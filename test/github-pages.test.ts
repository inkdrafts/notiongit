import { describe, expect, test } from 'bun:test';

import {
  configureGithubPages,
  getGithubPagesSite,
  GithubPagesError,
  GITHUB_PAGES_SOURCE,
} from '../src/github-pages';

const REPOSITORY = 'alice/alice.github.io';
const INSTALLATION_TOKEN = 'installation-token';

function response(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function site(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'built',
    url: 'https://api.github.com/repos/alice/alice.github.io/pages',
    html_url: 'https://alice.github.io',
    build_type: 'legacy',
    source: GITHUB_PAGES_SOURCE,
    ...overrides,
  };
}

describe('configureGithubPages', () => {
  test('creates legacy main:/ Pages with the installation token', async () => {
    const requests: Request[] = [];
    const pages = await configureGithubPages(INSTALLATION_TOKEN, REPOSITORY, {
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return response(201, site());
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.github.com/repos/alice/alice.github.io/pages');
    expect(requests[0].method).toBe('POST');
    expect(requests[0].headers.get('authorization')).toBe(`Bearer ${INSTALLATION_TOKEN}`);
    expect(await requests[0].json()).toEqual({ build_type: 'legacy', source: GITHUB_PAGES_SOURCE });
    expect(pages).toMatchObject({
      status: 'built',
      url: 'https://api.github.com/repos/alice/alice.github.io/pages',
      htmlUrl: 'https://alice.github.io',
      buildType: 'legacy',
      source: GITHUB_PAGES_SOURCE,
      reused: false,
    });
  });

  test('treats an existing compatible site as an idempotent success', async () => {
    const methods: string[] = [];
    const pages = await configureGithubPages(INSTALLATION_TOKEN, REPOSITORY, {
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        methods.push(request.method);
        return request.method === 'POST' ? response(409) : response(200, site());
      },
    });

    expect(methods).toEqual(['POST', 'GET']);
    expect(pages.reused).toBe(true);
  });

  test('updates an existing incompatible site to legacy main:/', async () => {
    const requests: Request[] = [];
    const pages = await configureGithubPages(INSTALLATION_TOKEN, REPOSITORY, {
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === 'POST') return response(409);
        if (request.method === 'GET') return response(200, site({ build_type: 'workflow', source: { branch: 'main', path: '/docs' } }));
        return response(204);
      },
    });

    expect(requests.map((request) => request.method)).toEqual(['POST', 'GET', 'PUT']);
    expect(await requests[2].json()).toEqual({ build_type: 'legacy', source: GITHUB_PAGES_SOURCE });
    expect(pages.reused).toBe(true);
  });

  test('does not retry actionable provider failures', async () => {
    for (const [status, code] of [
      [404, 'github_pages_missing_branch'],
      [422, 'github_pages_validation_failed'],
      [403, 'github_pages_permission_denied'],
      [429, 'github_pages_rate_limited'],
    ] as const) {
      let calls = 0;
      await expect(configureGithubPages(INSTALLATION_TOKEN, REPOSITORY, {
        fetcher: async () => {
          calls += 1;
          return response(status, {}, status === 429 ? { 'retry-after': '30' } : {});
        },
        sleep: async () => {
          throw new Error('actionable errors must not sleep');
        },
      })).rejects.toMatchObject({ code, status });
      expect(calls).toBe(1);
    }

    await expect(configureGithubPages(INSTALLATION_TOKEN, REPOSITORY, {
      fetcher: async () => response(403, {}, { 'retry-after': '30' }),
    })).rejects.toMatchObject({ code: 'github_pages_rate_limited', status: 429, retryAfterSeconds: 30 });
  });

  test('retries transient failures with bounded exponential backoff', async () => {
    let calls = 0;
    const delays: number[] = [];
    const pages = await configureGithubPages(INSTALLATION_TOKEN, REPOSITORY, {
      maxAttempts: 3,
      initialDelayMs: 10,
      maxDelayMs: 15,
      fetcher: async () => {
        calls += 1;
        return calls < 3 ? response(503) : response(201, site());
      },
      sleep: async (milliseconds) => delays.push(milliseconds),
    });

    expect(calls).toBe(3);
    expect(delays).toEqual([10, 15]);
    expect(pages.status).toBe('built');
  });

  test('the read helper uses the metadata-only Pages response', async () => {
    const pages = await getGithubPagesSite(INSTALLATION_TOKEN, REPOSITORY, async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe('GET');
      expect(request.headers.get('authorization')).toBe(`Bearer ${INSTALLATION_TOKEN}`);
      return response(200, site());
    });
    expect(pages).toMatchObject({ htmlUrl: 'https://alice.github.io', reused: true });
  });

  test('keeps the public error contract free of provider details', async () => {
    const error = await configureGithubPages(INSTALLATION_TOKEN, REPOSITORY, {
      fetcher: async () => response(422, { message: 'private repository details' }),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GithubPagesError);
    expect((error as Error).message).toBe('github_pages_validation_failed');
  });
});
