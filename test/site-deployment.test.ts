import { describe, expect, test } from 'bun:test';

import {
  awaitPagesBuildForCommit,
  checkPublicSiteReachable,
  getRepositoryMainHeadSha,
  latestPagesBuild,
  verifyPublicSiteReachable,
  GithubDeployError,
} from '../src/site-deployment';

const REPOSITORY = 'alice/alice.github.io';
const INSTALLATION_TOKEN = 'installation-token';
const BUILDS_URL = `https://api.github.com/repos/${REPOSITORY}/pages/builds/latest`;

function response(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('getRepositoryMainHeadSha', () => {
  test('reads the current main HEAD sha with the installation token', async () => {
    const sha = await getRepositoryMainHeadSha(INSTALLATION_TOKEN, REPOSITORY, async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(`https://api.github.com/repos/${REPOSITORY}/commits/main`);
      expect(request.headers.get('authorization')).toBe(`Bearer ${INSTALLATION_TOKEN}`);
      return response(200, { sha: 'head-sha' });
    });
    expect(sha).toBe('head-sha');
  });

  test('surfaces an unreadable HEAD as unavailable', async () => {
    await expect(getRepositoryMainHeadSha(INSTALLATION_TOKEN, REPOSITORY, async () => response(404)))
      .rejects.toMatchObject({ code: 'github_deploy_unavailable' });
  });
});

describe('awaitPagesBuildForCommit', () => {
  test('waits for the build matching the expected commit, not a stale one', async () => {
    let calls = 0;
    const delays: number[] = [];
    const build = await awaitPagesBuildForCommit(INSTALLATION_TOKEN, REPOSITORY, 'expected-sha', {
      initialDelayMs: 5,
      maxDelayMs: 20,
      fetcher: async (input) => {
        calls += 1;
        expect(String(input)).toBe(BUILDS_URL);
        if (calls === 1) return response(200, { url: '.../builds/1', status: 'built', commit: 'stale-sha' });
        if (calls === 2) return response(200, { url: '.../builds/2', status: 'building', commit: 'expected-sha' });
        return response(200, { url: 'https://api.github.com/repos/alice/alice.github.io/builds/3', status: 'built', commit: 'expected-sha' });
      },
      sleep: async (ms) => delays.push(ms),
    });
    expect(calls).toBe(3);
    expect(delays).toEqual([5, 10]);
    expect(build).toEqual({ buildId: 3, status: 'built', commitSha: 'expected-sha' });
  });

  test('reports a matching but errored build as a build failure', async () => {
    await expect(awaitPagesBuildForCommit(INSTALLATION_TOKEN, REPOSITORY, 'expected-sha', {
      fetcher: async () => response(200, { url: '.../builds/1', status: 'errored', commit: 'expected-sha' }),
    })).rejects.toMatchObject({ code: 'github_deploy_build_failed' });
  });

  test('times out when the build never reaches a terminal matching state', async () => {
    await expect(awaitPagesBuildForCommit(INSTALLATION_TOKEN, REPOSITORY, 'expected-sha', {
      maxAttempts: 2,
      initialDelayMs: 1,
      fetcher: async () => response(200, { url: '.../builds/1', status: 'building', commit: 'expected-sha' }),
      sleep: async () => {},
    })).rejects.toMatchObject({ code: 'github_deploy_timeout', status: 504 });
  });

  test('never exposes the provider build error message', async () => {
    const error = await awaitPagesBuildForCommit(INSTALLATION_TOKEN, REPOSITORY, 'expected-sha', {
      fetcher: async () => response(200, {
        url: '.../builds/1',
        status: 'errored',
        commit: 'expected-sha',
        error: { message: 'Liquid error in _posts/leaked-notion-title.md' },
      }),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GithubDeployError);
    expect(JSON.stringify(error)).not.toContain('leaked-notion-title');
  });
});

describe('latestPagesBuild', () => {
  test('returns the latest build in whatever state it is', async () => {
    const build = await latestPagesBuild(INSTALLATION_TOKEN, REPOSITORY, async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(BUILDS_URL);
      expect(request.headers.get('authorization')).toBe(`Bearer ${INSTALLATION_TOKEN}`);
      return response(200, { url: '.../builds/7', status: 'building', commit: 'head-sha' });
    });
    expect(build).toEqual({ buildId: 7, status: 'building', commitSha: 'head-sha' });
  });

  test('null means the read succeeded and no build exists yet', async () => {
    const build = await latestPagesBuild(INSTALLATION_TOKEN, REPOSITORY, async () => response(404));
    expect(build).toBeNull();
  });

  test('a failed read throws so never-built stays distinguishable from cannot-tell', async () => {
    await expect(latestPagesBuild(INSTALLATION_TOKEN, REPOSITORY, async () => response(500)))
      .rejects.toMatchObject({ code: 'github_deploy_unavailable', status: 502 });
    await expect(latestPagesBuild(INSTALLATION_TOKEN, REPOSITORY, async () => response(200, { status: 7 })))
      .rejects.toMatchObject({ code: 'github_deploy_unavailable' });
  });

  test('never returns the build error message', async () => {
    const build = await latestPagesBuild(INSTALLATION_TOKEN, REPOSITORY, async () => response(200, {
      url: '.../builds/1',
      status: 'errored',
      commit: 'head-sha',
      error: { message: 'Liquid error in _posts/leaked-notion-title.md' },
    }));
    expect(build).toEqual({ buildId: 1, status: 'errored', commitSha: 'head-sha' });
    expect(JSON.stringify(build)).not.toContain('leaked-notion-title');
  });
});

describe('verifyPublicSiteReachable', () => {
  test('succeeds once the URL answers', async () => {
    let calls = 0;
    const result = await verifyPublicSiteReachable('https://alice.github.io/', {
      initialDelayMs: 5,
      fetcher: async () => {
        calls += 1;
        return calls < 2 ? new Response('', { status: 404 }) : new Response('ok', { status: 200 });
      },
      sleep: async () => {},
    });
    expect(calls).toBe(2);
    expect(result.status).toBe(200);
  });

  test('reports unreachable propagation as a distinct, bounded outcome', async () => {
    let calls = 0;
    await expect(verifyPublicSiteReachable('https://alice.github.io/', {
      maxAttempts: 3,
      initialDelayMs: 1,
      fetcher: async () => {
        calls += 1;
        return new Response('', { status: 404 });
      },
      sleep: async () => {},
    })).rejects.toMatchObject({ code: 'github_deploy_url_unreachable', status: 504 });
    expect(calls).toBe(3);
  });

  test('treats a network failure the same as a non-2xx response', async () => {
    await expect(verifyPublicSiteReachable('https://alice.github.io/', {
      maxAttempts: 1,
      fetcher: async () => {
        throw new Error('network down');
      },
    })).rejects.toMatchObject({ code: 'github_deploy_url_unreachable' });
  });
});

describe('checkPublicSiteReachable', () => {
  test('answers true with exactly one request when the site answers', async () => {
    let calls = 0;
    const reachable = await checkPublicSiteReachable('https://alice.github.io/', {
      fetcher: async () => {
        calls += 1;
        return new Response('ok', { status: 200 });
      },
    });
    expect(reachable).toBe(true);
    expect(calls).toBe(1);
  });

  test('answers false with exactly one request when the site does not answer', async () => {
    let calls = 0;
    const reachable = await checkPublicSiteReachable('https://alice.github.io/', {
      fetcher: async () => {
        calls += 1;
        return new Response('', { status: 404 });
      },
      sleep: async () => {},
    });
    expect(reachable).toBe(false);
    expect(calls).toBe(1);
  });

  test('collapses a network failure into false', async () => {
    const reachable = await checkPublicSiteReachable('https://alice.github.io/', {
      fetcher: async () => {
        throw new Error('network down');
      },
    });
    expect(reachable).toBe(false);
  });
});
