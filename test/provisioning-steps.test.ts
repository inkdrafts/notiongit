import { describe, expect, test } from 'bun:test';

import { PROVISIONING_STEP_HANDLERS, type StepRunnerContext } from '../src/provisioning-steps';
import { createProvisioningJob, type CreateProvisioningJobParams, type ProvisioningJob } from '../src/provisioning-job';
import { GithubDeployError } from '../src/site-deployment';

class MemoryKV {
  private values = new Map<string, string>();

  async get<T>(key: string, type?: string): Promise<T | string | null> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) as T : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

const IDENTITY = { id: 42, login: 'alice', accountType: 'User' as const };
const REPOSITORY = { name: 'alice.github.io', url: 'https://alice.github.io', baseurl: '', kind: 'apex' as const };
const GENERATED_REPOSITORY = {
  id: 1001,
  fullName: 'alice/alice.github.io',
  name: 'alice.github.io',
  htmlUrl: 'https://github.com/alice/alice.github.io',
  defaultBranch: 'main',
  templateFullName: 'inkdrafts/notiongit-template',
  templateHeadSha: 'template-head-sha',
  templateHeadTreeSha: 'template-tree-sha',
  headSha: null,
  headTreeSha: null,
  reused: false,
};

function makeJob(overrides: Partial<CreateProvisioningJobParams> = {}, dataOverrides: Partial<ProvisioningJob['data']> = {}): ProvisioningJob {
  const job = createProvisioningJob({
    jobId: 'job-1',
    installationId: 123,
    identity: IDENTITY,
    repository: REPOSITORY,
    generatedRepository: GENERATED_REPOSITORY,
    now: 5_000,
    ...overrides,
  });
  return { ...job, data: { ...job.data, ...dataOverrides } };
}

function makeContext(fetcher: typeof fetch, overrides: Partial<StepRunnerContext> = {}): StepRunnerContext {
  return {
    jobs: new MemoryKV() as unknown as KVNamespace,
    installationToken: 'installation-token',
    fetcher,
    sleep: async () => {},
    now: () => 9_000,
    ...overrides,
  };
}

function unreachableFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    throw new Error(`unexpected fetch: ${String(input)}`);
  }) as typeof fetch;
}

const CONFIG_YAML = `title: "NotionGit"\nurl: ""\nbaseurl: ""\n`;

function base64(content: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(content)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe('runVerifyRepository', () => {
  test('records the readable head sha and tree sha', async () => {
    const job = makeJob();
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/alice/alice.github.io') {
        return Response.json({ id: 1001, full_name: 'alice/alice.github.io', default_branch: 'main', fork: false });
      }
      if (url === 'https://api.github.com/repos/alice/alice.github.io/commits/main') {
        return Response.json({ sha: 'generated-head-sha', commit: { tree: { sha: 'generated-tree-sha' } } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const patch = await PROVISIONING_STEP_HANDLERS.verify_repository(job, makeContext(fetcher));
    expect(patch.generatedRepository).toMatchObject({ headSha: 'generated-head-sha', headTreeSha: 'generated-tree-sha' });
  });
});

describe('runPatchConfig', () => {
  test('patches url/baseurl into _config.yml', async () => {
    let putBody: unknown;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://api.github.com/repos/alice/alice.github.io/contents/_config.yml')) {
        if (init?.method === 'PUT') {
          putBody = JSON.parse(String(init.body));
          return Response.json({ content: { sha: 'patched-sha' }, commit: { sha: 'commit-sha' } });
        }
        return Response.json({ type: 'file', encoding: 'base64', content: base64(CONFIG_YAML), sha: 'config-sha' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const patch = await PROVISIONING_STEP_HANDLERS.patch_config(makeJob(), makeContext(fetcher));
    expect(patch).toEqual({});
    expect(putBody).toMatchObject({ sha: 'config-sha', branch: 'main' });
  });
});

describe('runConfigurePages', () => {
  test('enables legacy Pages and returns its identity', async () => {
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/alice/alice.github.io/pages' && init?.method === 'POST') {
        return Response.json({
          status: 'built',
          url: 'https://api.github.com/repos/alice/alice.github.io/pages',
          html_url: 'https://alice.github.io',
          build_type: 'legacy',
          source: { branch: 'main', path: '/' },
        }, { status: 201 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const patch = await PROVISIONING_STEP_HANDLERS.configure_pages(makeJob(), makeContext(fetcher));
    expect(patch.pages).toMatchObject({ status: 'built', htmlUrl: 'https://alice.github.io' });
  });
});

describe('runDispatchSync', () => {
  test('dispatches once and correlates the resulting run when nothing is recorded yet', async () => {
    let dispatchCalls = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/actions/workflows/sync-notion.yml/runs?')) {
        return Response.json({
          workflow_runs: dispatchCalls > 0
            ? [{ id: 555, html_url: 'https://github.com/alice/alice.github.io/actions/runs/555', status: 'queued', conclusion: null, event: 'workflow_dispatch', created_at: new Date(20_000).toISOString() }]
            : [],
        });
      }
      if (url.endsWith('/actions/workflows/sync-notion.yml/dispatches') && init?.method === 'POST') {
        dispatchCalls += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const patch = await PROVISIONING_STEP_HANDLERS.dispatch_sync(makeJob(), makeContext(fetcher, { now: () => 20_000 }));
    expect(dispatchCalls).toBe(1);
    expect(patch).toEqual({ sync: { runId: 555, htmlUrl: 'https://github.com/alice/alice.github.io/actions/runs/555', conclusion: null }, syncDispatchMarker: null });
  });

  test('resumes from a persisted dispatch marker instead of dispatching a second run', async () => {
    let dispatchCalls = 0;
    const job = makeJob({}, { syncDispatchMarker: { excludedRunIds: [111], dispatchedAtMs: 20_000 } });
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/actions/workflows/sync-notion.yml/runs?')) {
        return Response.json({
          workflow_runs: [{ id: 555, html_url: 'https://github.com/alice/alice.github.io/actions/runs/555', status: 'queued', conclusion: null, event: 'workflow_dispatch', created_at: new Date(20_000).toISOString() }],
        });
      }
      if (url.endsWith('/dispatches')) {
        dispatchCalls += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const patch = await PROVISIONING_STEP_HANDLERS.dispatch_sync(job, makeContext(fetcher, { now: () => 20_000 }));
    expect(dispatchCalls).toBe(0);
    expect(patch.sync).toEqual({ runId: 555, htmlUrl: 'https://github.com/alice/alice.github.io/actions/runs/555', conclusion: null });
    expect(patch.syncDispatchMarker).toBeNull();
  });

  test('is a no-op once a run is already recorded — duplicate delivery makes no request', async () => {
    const job = makeJob({}, { sync: { runId: 555, htmlUrl: 'https://github.com/alice/alice.github.io/actions/runs/555', conclusion: null } });
    const patch = await PROVISIONING_STEP_HANDLERS.dispatch_sync(job, makeContext(unreachableFetch()));
    expect(patch).toEqual({});
  });
});

describe('runAwaitSync', () => {
  test('polls the recorded run to completion', async () => {
    const job = makeJob({}, { sync: { runId: 555, htmlUrl: 'https://github.com/alice/alice.github.io/actions/runs/555', conclusion: null } });
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/alice/alice.github.io/actions/runs/555') {
        return Response.json({ id: 555, html_url: 'https://github.com/alice/alice.github.io/actions/runs/555', status: 'completed', conclusion: 'success' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const patch = await PROVISIONING_STEP_HANDLERS.await_sync(job, makeContext(fetcher));
    expect(patch.sync).toEqual({ runId: 555, htmlUrl: 'https://github.com/alice/alice.github.io/actions/runs/555', conclusion: 'success' });
  });

  test('throws if it somehow runs before dispatch_sync recorded a run', async () => {
    const job = makeJob();
    await expect(PROVISIONING_STEP_HANDLERS.await_sync(job, makeContext(unreachableFetch()))).rejects.toThrow();
  });
});

describe('runAwaitDeployBuild', () => {
  test('waits for the Pages build matching the current head commit', async () => {
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/alice/alice.github.io/commits/main') {
        return Response.json({ sha: 'generated-head-sha' });
      }
      if (url === 'https://api.github.com/repos/alice/alice.github.io/pages/builds/latest') {
        return Response.json({ url: 'https://api.github.com/repos/alice/alice.github.io/builds/999', status: 'built', commit: 'generated-head-sha' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const patch = await PROVISIONING_STEP_HANDLERS.await_deploy_build(makeJob(), makeContext(fetcher));
    expect(patch.deployment).toEqual({ commitSha: 'generated-head-sha', buildId: 999, status: 'built', verifiedAt: null });
  });
});

describe('runVerifyDeploy', () => {
  test('confirms the public URL answers and stamps verifiedAt', async () => {
    const job = makeJob({}, {
      pages: { status: 'built', url: 'x', htmlUrl: 'https://alice.github.io', buildType: 'legacy', source: { branch: 'main', path: '/' }, reused: false },
      deployment: { commitSha: 'generated-head-sha', buildId: 999, status: 'built', verifiedAt: null },
    });
    const fetcher = (async () => new Response('<!doctype html>', { status: 200 })) as typeof fetch;

    const patch = await PROVISIONING_STEP_HANDLERS.verify_deploy(job, makeContext(fetcher, { now: () => 12_345 }));
    expect(patch.deployment).toEqual({ commitSha: 'generated-head-sha', buildId: 999, status: 'built', verifiedAt: 12_345 });
  });

  test('refuses to run without a Pages URL and deployment record', async () => {
    await expect(PROVISIONING_STEP_HANDLERS.verify_deploy(makeJob(), makeContext(unreachableFetch())))
      .rejects.toThrow(GithubDeployError);
  });
});
