import { describe, expect, test } from 'bun:test';

import {
  awaitGeneratedRepositoryCommit,
  findReusableGeneratedRepository,
  GENERATED_REPOSITORY_DESCRIPTION,
  generateOrReuseRepository,
  generateRepositoryFromTemplate,
  getTemplateHead,
  GithubGenerateError,
  isInkdraftsGeneratedRepository,
  reuseCollidingRepository,
  TEMPLATE_REPOSITORY_FULL_NAME,
} from '../src/repository-generation';
import {
  GithubRepositoryNameCollisionError,
  isGithubRepositoryNameCollision,
  repositoryDestination,
  type GithubRepositorySummary,
} from '../src/repository-naming';

const USER_TOKEN = 'user-token';

function summary(overrides: Partial<GithubRepositorySummary> & { name: string }): GithubRepositorySummary {
  return {
    id: 1001,
    full_name: `alice/${overrides.name}`,
    html_url: `https://github.com/alice/${overrides.name}`,
    default_branch: 'main',
    fork: false,
    description: GENERATED_REPOSITORY_DESCRIPTION,
    ...overrides,
  };
}

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
}

/** A scripted fetch that records every request and replays queued responses. */
function scriptedFetch(responses: Array<{ match: (request: RecordedRequest) => boolean; respond: () => Response }>) {
  const requests: RecordedRequest[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const recorded: RecordedRequest = {
      method: request.method,
      url: request.url,
      authorization: request.headers.get('authorization'),
      contentType: request.headers.get('content-type'),
      body: request.method === 'POST' ? await request.json().catch(() => null) : null,
    };
    requests.push(recorded);
    for (const entry of responses) {
      if (entry.match(recorded)) return entry.respond();
    }
    throw new Error(`unexpected request: ${recorded.method} ${recorded.url}`);
  };
  return { fetcher, requests };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body ?? {}), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('generateRepositoryFromTemplate', () => {
  test('posts the template generate request with the user token and a public product description', async () => {
    const { fetcher, requests } = scriptedFetch([
      {
        match: (request) => request.method === 'POST' && request.url.endsWith(`/repos/${TEMPLATE_REPOSITORY_FULL_NAME}/generate`),
        respond: () => jsonResponse(201, summary({ name: 'alice.github.io' })),
      },
    ]);

    const identity = await generateRepositoryFromTemplate(
      USER_TOKEN,
      repositoryDestination('alice', 'alice.github.io'),
      fetcher,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe(`Bearer ${USER_TOKEN}`);
    expect(requests[0].contentType).toBe('application/json');
    expect(requests[0].body).toEqual({
      name: 'alice.github.io',
      description: GENERATED_REPOSITORY_DESCRIPTION,
      private: false,
      include_all_branches: false,
    });
    expect(identity).toEqual({
      id: 1001,
      fullName: 'alice/alice.github.io',
      name: 'alice.github.io',
      htmlUrl: 'https://github.com/alice/alice.github.io',
      defaultBranch: 'main',
      templateFullName: TEMPLATE_REPOSITORY_FULL_NAME,
      templateHeadSha: null,
      templateHeadTreeSha: null,
      headSha: null,
      headTreeSha: null,
      reused: false,
    });
  });

  test('reports a 422 through the naming collision contract', async () => {
    const { fetcher } = scriptedFetch([
      { match: (request) => request.method === 'POST', respond: () => jsonResponse(422, { message: 'name already exists on this account' }) },
    ]);

    const error = await generateRepositoryFromTemplate(USER_TOKEN, repositoryDestination('alice', 'alice.github.io'), fetcher)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GithubRepositoryNameCollisionError);
    expect(isGithubRepositoryNameCollision(error)).toBe(true);
  });

  test.each([
    ['429 without retry-after', 429, {}, null],
    ['403 with retry-after', 403, { 'retry-after': '42' }, 42],
  ])('%s is a distinct, resumable rate limit', async (_name, status, headers, retryAfter) => {
    const { fetcher } = scriptedFetch([
      { match: (request) => request.method === 'POST', respond: () => jsonResponse(status, {}, headers) },
    ]);

    await expect(
      generateRepositoryFromTemplate(USER_TOKEN, repositoryDestination('alice', 'alice.github.io'), fetcher),
    ).rejects.toMatchObject({ code: 'github_generate_rate_limited', retryAfterSeconds: retryAfter });
  });

  test.each([
    ['permission failure without retry-after', 403],
    ['server error', 500],
    ['created but a fork', 201],
  ])('%s is an unavailable failure, not a collision', async (_name, status) => {
    const { fetcher } = scriptedFetch([
      {
        match: (request) => request.method === 'POST',
        respond: () => jsonResponse(status, status === 201 ? summary({ name: 'alice.github.io', fork: true }) : {}),
      },
    ]);

    await expect(
      generateRepositoryFromTemplate(USER_TOKEN, repositoryDestination('alice', 'alice.github.io'), fetcher),
    ).rejects.toMatchObject({ code: 'github_generate_unavailable' });
  });
});

describe('reuseCollidingRepository', () => {
  test('adopts a marker repository', async () => {
    const { fetcher } = scriptedFetch([
      { match: (request) => request.method === 'GET', respond: () => jsonResponse(200, summary({ name: 'alice.github.io' })) },
    ]);

    const identity = await reuseCollidingRepository(USER_TOKEN, 'Alice', 'alice.github.io', fetcher);
    expect(identity).toMatchObject({ fullName: 'alice/alice.github.io', reused: true });
  });

  test('returns null for a foreign repository or a missing one', async () => {
    const foreign = scriptedFetch([
      { match: (request) => request.method === 'GET', respond: () => jsonResponse(200, summary({ name: 'alice.github.io', description: 'unrelated' })) },
    ]);
    expect(await reuseCollidingRepository(USER_TOKEN, 'alice', 'alice.github.io', foreign.fetcher)).toBeNull();

    const missing = scriptedFetch([
      { match: (request) => request.method === 'GET', respond: () => jsonResponse(404, {}) },
    ]);
    expect(await reuseCollidingRepository(USER_TOKEN, 'alice', 'alice.github.io', missing.fetcher)).toBeNull();
  });

  test('refuses to guess when the occupier cannot be read', async () => {
    const { fetcher } = scriptedFetch([
      { match: (request) => request.method === 'GET', respond: () => jsonResponse(503, {}) },
    ]);

    // An unreadable occupier must not advance the name: that could mint a
    // duplicate repository. It surfaces as a resumable failure instead.
    await expect(reuseCollidingRepository(USER_TOKEN, 'alice', 'alice.github.io', fetcher))
      .rejects.toMatchObject({ code: 'github_generate_unavailable' });
  });
});

describe('findReusableGeneratedRepository', () => {
  test('prefers the apex repository, then the shortest project name', () => {
    const candidates = [
      summary({ name: 'alice-inkdrafts-2' }),
      summary({ name: 'alice-inkdrafts' }),
      summary({ name: 'some-other-repo', description: 'unrelated' }),
      summary({ name: 'a-fork-of-ours', fork: true }),
      summary({ name: 'broken-entry', id: undefined }),
    ];

    expect(findReusableGeneratedRepository(candidates, 'alice')?.name).toBe('alice-inkdrafts');
    expect(findReusableGeneratedRepository(
      [...candidates, summary({ name: 'alice.github.io' })],
      'alice',
    )?.name).toBe('alice.github.io');
    expect(findReusableGeneratedRepository(
      candidates.filter((candidate) => candidate.description === 'unrelated' || candidate.fork),
      'alice',
    )).toBeNull();
  });

  test('the marker check excludes forks and foreign descriptions', () => {
    expect(isInkdraftsGeneratedRepository(summary({ name: 'x' }))).toBe(true);
    expect(isInkdraftsGeneratedRepository(summary({ name: 'x', fork: true }))).toBe(false);
    expect(isInkdraftsGeneratedRepository(summary({ name: 'x', description: 'unrelated' }))).toBe(false);
    expect(isInkdraftsGeneratedRepository({ name: 'x', description: null })).toBe(false);
  });
});

describe('getTemplateHead', () => {
  test('reads the template main HEAD with its tree and degrades to null on failure', async () => {
    const ok = scriptedFetch([
      {
        match: (request) => request.url.endsWith('/commits/main'),
        respond: () => jsonResponse(200, { sha: 'template-sha', commit: { tree: { sha: 'template-tree-sha' } } }),
      },
    ]);
    expect(await getTemplateHead(USER_TOKEN, ok.fetcher)).toEqual({ sha: 'template-sha', treeSha: 'template-tree-sha' });
    expect(ok.requests[0].url).toBe(`https://api.github.com/repos/${TEMPLATE_REPOSITORY_FULL_NAME}/commits/main`);

    const failing = scriptedFetch([
      { match: (request) => true, respond: () => jsonResponse(404, {}) },
    ]);
    expect(await getTemplateHead(USER_TOKEN, failing.fetcher)).toBeNull();
  });
});

describe('awaitGeneratedRepositoryCommit', () => {
  interface PollEntry {
    repository?: number;
    commit?: number;
    /** Placeholder default branch GitHub reports while the copy settles. */
    defaultBranch?: string;
  }

  function pollFetch(entries: PollEntry[]) {
    const queue = [...entries];
    let current: PollEntry | undefined;
    return async (input: RequestInfo | URL): Promise<Response> => {
      const url = new Request(input).url;
      if (url.endsWith('/commits/main')) {
        // Same poll attempt as the repository read; reuse its scripted entry.
        return current?.commit === 200
          ? jsonResponse(200, { sha: 'head-sha', commit: { tree: { sha: 'head-tree-sha' } } })
          : jsonResponse(404, {});
      }
      current = queue.shift();
      return current?.repository === 200
        ? jsonResponse(200, { default_branch: current.defaultBranch ?? 'main', fork: false })
        : jsonResponse(404, {});
    };
  }

  test('succeeds on the first attempt without sleeping', async () => {
    const sleeps: number[] = [];
    const result = await awaitGeneratedRepositoryCommit('Bearer installation-token', 'alice/alice.github.io', {
      fetcher: pollFetch([{ repository: 200, commit: 200 }]) as unknown as typeof fetch,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(result).toEqual({ defaultBranch: 'main', headSha: 'head-sha', headTreeSha: 'head-tree-sha' });
    expect(sleeps).toEqual([]);
  });

  test('keeps polling through the placeholder default branch GitHub reports while the copy settles', async () => {
    const sleeps: number[] = [];
    const result = await awaitGeneratedRepositoryCommit('Bearer installation-token', 'alice/alice.github.io', {
      fetcher: pollFetch([
        { repository: 200, defaultBranch: 'master' },
        { repository: 200, defaultBranch: 'master' },
        { repository: 200, commit: 200 },
      ]) as unknown as typeof fetch,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(result.headSha).toBe('head-sha');
    expect(sleeps).toEqual([250, 500]);
  });

  test('backs off exponentially while the repository or commit lags', async () => {
    const sleeps: number[] = [];
    const result = await awaitGeneratedRepositoryCommit('Bearer installation-token', 'alice/alice.github.io', {
      fetcher: pollFetch([
        { repository: 404 },
        { repository: 200, commit: 404 },
        { repository: 200, commit: 200 },
      ]) as unknown as typeof fetch,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(result.headSha).toBe('head-sha');
    expect(sleeps).toEqual([250, 500]);
  });

  test('raises a distinct timeout once attempts are exhausted', async () => {
    const sleeps: number[] = [];
    await expect(awaitGeneratedRepositoryCommit('Bearer installation-token', 'alice/alice.github.io', {
      maxAttempts: 4,
      fetcher: pollFetch([{ repository: 404 }, { repository: 404 }, { repository: 404 }, { repository: 404 }]) as unknown as typeof fetch,
      sleep: async (ms) => { sleeps.push(ms); },
    })).rejects.toMatchObject({ code: 'github_generate_timeout', status: 504 });
    expect(sleeps).toEqual([250, 500, 1000]);
  });

  test('caps the backoff delay', async () => {
    const sleeps: number[] = [];
    const lagging: PollEntry[] = Array.from({ length: 8 }, () => ({ repository: 404 }));
    await expect(awaitGeneratedRepositoryCommit('Bearer installation-token', 'alice/alice.github.io', {
      fetcher: pollFetch(lagging) as unknown as typeof fetch,
      sleep: async (ms) => { sleeps.push(ms); },
    })).rejects.toMatchObject({ code: 'github_generate_timeout' });
    expect(sleeps).toEqual([250, 500, 1000, 2000, 4000, 8000, 8000]);
  });

  test('fails immediately on a fork instead of polling', async () => {
    const fetcher = async (): Promise<Response> => jsonResponse(200, { default_branch: 'main', fork: true });
    await expect(awaitGeneratedRepositoryCommit('Bearer installation-token', 'alice/alice.github.io', {
      fetcher: fetcher as unknown as typeof fetch,
      sleep: async () => { throw new Error('must not sleep'); },
    })).rejects.toMatchObject({ code: 'github_generate_branch_mismatch' });
  });
});

describe('generateOrReuseRepository', () => {
  test('reuses a marker repository without any network calls', async () => {
    const failing = async (): Promise<Response> => {
      throw new Error('no network calls are allowed on the reuse path');
    };

    const { destination, identity } = await generateOrReuseRepository(
      USER_TOKEN,
      'alice',
      [summary({ name: 'alice-inkdrafts' })],
      failing as unknown as typeof fetch,
    );
    expect(destination).toMatchObject({ name: 'alice-inkdrafts', baseurl: '/alice-inkdrafts' });
    expect(identity).toMatchObject({ reused: true, templateHeadSha: null });
  });

  test('records the template HEAD and tree alongside a fresh generation', async () => {
    const { fetcher } = scriptedFetch([
      {
        match: (request) => request.url.endsWith('/commits/main'),
        respond: () => jsonResponse(200, { sha: 'template-sha', commit: { tree: { sha: 'template-tree-sha' } } }),
      },
      { match: (request) => request.method === 'POST', respond: () => jsonResponse(201, summary({ name: 'alice.github.io' })) },
    ]);

    const { destination, identity } = await generateOrReuseRepository(USER_TOKEN, 'alice', [], fetcher);
    expect(destination.name).toBe('alice.github.io');
    expect(identity.templateHeadSha).toBe('template-sha');
    expect(identity.templateHeadTreeSha).toBe('template-tree-sha');
    expect(identity.reused).toBe(false);
  });

  test('exhausted candidates surface as a terminal collision, not a transient failure', async () => {
    const { fetcher } = scriptedFetch([
      {
        match: (request) => request.method === 'POST',
        respond: () => jsonResponse(422, { message: 'name already exists on this account' }),
      },
      {
        match: (request) => request.method === 'GET' && !request.url.includes('commits'),
        respond: () => jsonResponse(200, summary({ name: 'occupied', description: 'unrelated' })),
      },
    ]);

    await expect(generateOrReuseRepository(USER_TOKEN, 'alice', [], fetcher))
      .rejects.toBeInstanceOf(GithubGenerateError);
  });

  test('beforeCreate runs immediately before each generate POST and never on the reuse path', async () => {
    const events: string[] = [];
    const { fetcher } = scriptedFetch([
      {
        match: (request) => request.url.endsWith('/commits/main'),
        respond: () => {
          events.push('template-head');
          return jsonResponse(200, { sha: 'template-sha', commit: { tree: { sha: 'template-tree-sha' } } });
        },
      },
      {
        match: (request) => request.method === 'POST',
        respond: () => {
          events.push('post');
          return jsonResponse(201, summary({ name: 'alice.github.io' }));
        },
      },
    ]);

    await generateOrReuseRepository(USER_TOKEN, 'alice', [], fetcher, {
      beforeCreate: async () => { events.push('beforeCreate'); },
    });
    expect(events.filter((event) => event !== 'template-head')).toEqual(['beforeCreate', 'post']);

    const reused = await generateOrReuseRepository(
      USER_TOKEN,
      'alice',
      [summary({ name: 'alice-inkdrafts' })],
      fetcher,
      { beforeCreate: async () => { events.push('beforeCreate-reuse'); } },
    );
    expect(reused.identity.reused).toBe(true);
    expect(events).not.toContain('beforeCreate-reuse');
  });

  test('a collision-advanced candidate pays beforeCreate again before its own POST', async () => {
    const events: string[] = [];
    const { fetcher } = scriptedFetch([
      {
        match: (request) => request.url.endsWith('/commits/main'),
        respond: () => jsonResponse(200, { sha: 'template-sha', commit: { tree: { sha: 'template-tree-sha' } } }),
      },
      {
        match: (request) => request.method === 'POST' && (request.body as { name?: string }).name === 'alice.github.io',
        respond: () => {
          events.push('post:alice.github.io');
          return jsonResponse(422, { message: 'name already exists on this account' });
        },
      },
      {
        match: (request) => request.method === 'GET',
        respond: () => jsonResponse(200, summary({ name: 'occupied', description: 'unrelated' })),
      },
      {
        match: (request) => request.method === 'POST',
        respond: () => {
          events.push('post:alice-inkdrafts');
          return jsonResponse(201, summary({ name: 'alice-inkdrafts' }));
        },
      },
    ]);

    const { destination } = await generateOrReuseRepository(USER_TOKEN, 'alice', [], fetcher, {
      beforeCreate: async () => { events.push('beforeCreate'); },
    });
    expect(destination.name).toBe('alice-inkdrafts');
    expect(events).toEqual(['beforeCreate', 'post:alice.github.io', 'beforeCreate', 'post:alice-inkdrafts']);
  });

  test('a beforeCreate refusal propagates without issuing any generate POST', async () => {
    const { fetcher, requests } = scriptedFetch([]);

    await expect(generateOrReuseRepository(USER_TOKEN, 'alice', [], fetcher, {
      beforeCreate: async () => { throw new Error('budget refused'); },
    })).rejects.toThrow('budget refused');
    // The template-head read precedes the create loop; the refusal must stop
    // every content-creating call.
    expect(requests.every((request) => request.method !== 'POST')).toBe(true);
  });
});
