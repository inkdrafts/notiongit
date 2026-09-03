import { describe, expect, test } from 'bun:test';

import {
  classifyProvisioningError,
  processProvisioningMessage,
  type ProvisioningQueueEnv,
} from '../src/provisioning-queue';
import {
  createProvisioningJob,
  loadProvisioningJob,
  saveProvisioningJob,
  tryAcquireProvisioningLock,
  PROVISIONING_LOCK_RETRY_DELAY_SECONDS,
  PROVISIONING_STEP_MAX_ATTEMPTS,
  type CreateProvisioningJobParams,
  type ProvisioningJob,
} from '../src/provisioning-job';
import { GithubConfigError } from '../src/repository-config';
import { GithubPagesError } from '../src/github-pages';
import { GithubSyncError } from '../src/notion-sync';
import { GithubDeployError } from '../src/site-deployment';
import { GithubGenerateError } from '../src/repository-generation';
import { GithubAppAuthError } from '../src/github-app-auth';

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

class MemoryQueue<T> {
  readonly sent: T[] = [];

  async send(message: T): Promise<void> {
    this.sent.push(message);
  }

  async sendBatch(): Promise<void> {
    throw new Error('MemoryQueue.sendBatch is not used by this project');
  }
}

let throwawayPrivateKey: Promise<string> | undefined;

function generateThrowawayPrivateKey(): Promise<string> {
  throwawayPrivateKey ??= (async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
    let base64 = '';
    for (const byte of der) base64 += String.fromCharCode(byte);
    return `-----BEGIN PRIVATE KEY-----\n${btoa(base64)}\n-----END PRIVATE KEY-----`;
  })();
  return throwawayPrivateKey;
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
    generatedRepository: { ...GENERATED_REPOSITORY, headSha: 'generated-head-sha', headTreeSha: 'generated-tree-sha' },
    now: 1_000,
    ...overrides,
  });
  return { ...job, data: { ...job.data, ...dataOverrides } };
}

/** A job already through `verify_repository` and `patch_config`, ready for `configure_pages`. */
function jobAtConfigurePages(): ProvisioningJob {
  const job = makeJob();
  job.steps.verify_repository.status = 'succeeded';
  job.steps.patch_config.status = 'succeeded';
  return job;
}

async function testEnv(kv = new MemoryKV(), queue = new MemoryQueue<{ jobId: string }>()): Promise<ProvisioningQueueEnv> {
  return {
    JOBS: kv as unknown as KVNamespace,
    PROVISIONING_QUEUE: queue as unknown as Queue<{ jobId: string }>,
    GITHUB_APP_ID: '4798518',
    GITHUB_APP_PRIVATE_KEY: await generateThrowawayPrivateKey(),
  };
}

const CONFIG_YAML = `title: "NotionGit"\nurl: ""\nbaseurl: ""\n`;

function base64(content: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(content)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Handles installation-token minting plus every endpoint from `configure_pages` onward. */
function pipelineFetch(overrides: { runConclusion?: 'success' | 'failure'; buildStatus?: 'built' | 'errored' } = {}) {
  const calls: Record<string, number> = {};
  let syncDispatched = false;
  const count = (name: string) => { calls[name] = (calls[name] ?? 0) + 1; };

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://api.github.com/app/installations/123/access_tokens') {
      count('mint_token');
      return Response.json({ token: 'installation-token' });
    }
    if (url === 'https://api.github.com/repos/alice/alice.github.io/pages' && init?.method === 'POST') {
      count('configure_pages');
      return Response.json({
        status: 'built',
        url: 'https://api.github.com/repos/alice/alice.github.io/pages',
        html_url: 'https://alice.github.io',
        build_type: 'legacy',
        source: { branch: 'main', path: '/' },
      }, { status: 201 });
    }
    if (url.includes('/actions/workflows/sync-notion.yml/runs?')) {
      count('list_sync_runs');
      return Response.json({
        workflow_runs: syncDispatched
          ? [{ id: 555, html_url: 'https://github.com/alice/alice.github.io/actions/runs/555', status: 'completed', conclusion: null, event: 'workflow_dispatch', created_at: new Date().toISOString() }]
          : [],
      });
    }
    if (url.endsWith('/actions/workflows/sync-notion.yml/dispatches')) {
      count('dispatch_sync');
      syncDispatched = true;
      return new Response(null, { status: 204 });
    }
    if (url === 'https://api.github.com/repos/alice/alice.github.io/actions/runs/555') {
      count('await_sync');
      return Response.json({
        id: 555,
        html_url: 'https://github.com/alice/alice.github.io/actions/runs/555',
        status: 'completed',
        conclusion: overrides.runConclusion ?? 'success',
      });
    }
    if (url === 'https://api.github.com/repos/alice/alice.github.io/commits/main') {
      count('deploy_head_sha');
      return Response.json({ sha: 'generated-head-sha' });
    }
    if (url === 'https://api.github.com/repos/alice/alice.github.io/pages/builds/latest') {
      count('await_deploy_build');
      return Response.json({
        url: 'https://api.github.com/repos/alice/alice.github.io/builds/999',
        status: overrides.buildStatus ?? 'built',
        commit: 'generated-head-sha',
      });
    }
    if (url === 'https://alice.github.io') {
      count('verify_deploy');
      return new Response('<!doctype html>', { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  return { fetcher, calls };
}

function unreachableFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    throw new Error(`unexpected fetch: ${String(input)}`);
  }) as typeof fetch;
}

describe('classifyProvisioningError', () => {
  test('retries a config conflict but dead-letters an invalid config', () => {
    expect(classifyProvisioningError(new GithubConfigError('github_config_conflict', 409)).retryable).toBe(true);
    expect(classifyProvisioningError(new GithubConfigError('github_config_invalid', 502)).retryable).toBe(false);
  });

  test('retries a rate-limited Pages call and passes through its retry-after', () => {
    const classification = classifyProvisioningError(new GithubPagesError('github_pages_rate_limited', 429, 42));
    expect(classification).toEqual({ code: 'github_pages_rate_limited', retryable: true, retryAfterSeconds: 42 });
  });

  test('dead-letters a permission-denied Pages call', () => {
    expect(classifyProvisioningError(new GithubPagesError('github_pages_permission_denied', 403)).retryable).toBe(false);
  });

  test('retries every documented transient sync failure, dead-letters a failed run', () => {
    expect(classifyProvisioningError(new GithubSyncError('github_sync_correlate_timeout', 504)).retryable).toBe(true);
    expect(classifyProvisioningError(new GithubSyncError('github_sync_run_timeout', 504)).retryable).toBe(true);
    expect(classifyProvisioningError(new GithubSyncError('github_sync_run_failed', 502)).retryable).toBe(false);
  });

  test('retries a build/url timeout but dead-letters an errored build', () => {
    expect(classifyProvisioningError(new GithubDeployError('github_deploy_url_unreachable', 504)).retryable).toBe(true);
    expect(classifyProvisioningError(new GithubDeployError('github_deploy_build_failed', 502)).retryable).toBe(false);
  });

  test('retries a generate timeout but dead-letters exhausted names', () => {
    expect(classifyProvisioningError(new GithubGenerateError('github_generate_timeout', 504)).retryable).toBe(true);
    expect(classifyProvisioningError(new GithubGenerateError('github_generate_name_exhausted', 409)).retryable).toBe(false);
  });

  test('treats a 5xx/429 app-auth failure as retryable and a 4xx as terminal', () => {
    expect(classifyProvisioningError(new GithubAppAuthError(503)).retryable).toBe(true);
    expect(classifyProvisioningError(new GithubAppAuthError(429)).retryable).toBe(true);
    expect(classifyProvisioningError(new GithubAppAuthError(404)).retryable).toBe(false);
  });

  test('treats an unrecognized error as retryable, bounded by the step attempt ceiling', () => {
    expect(classifyProvisioningError(new TypeError('network blip')).retryable).toBe(true);
  });
});

describe('processProvisioningMessage', () => {
  test('retries a message whose job record is not yet visible in KV', async () => {
    const env = await testEnv();
    const outcome = await processProvisioningMessage('missing-job', env, { fetcher: unreachableFetch() });
    expect(outcome).toEqual({ outcome: 'retry', delaySeconds: PROVISIONING_LOCK_RETRY_DELAY_SECONDS });
  });

  test('advances one step per call and completes the remaining pipeline', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<{ jobId: string }>();
    const env = await testEnv(kv, queue);
    await saveProvisioningJob(env.JOBS, jobAtConfigurePages());

    const { fetcher, calls } = pipelineFetch();
    const runtime = { fetcher, sleep: async () => {}, now: () => 2_000 };

    // configure_pages
    let outcome = await processProvisioningMessage('job-1', env, runtime);
    expect(outcome).toEqual({ outcome: 'acked' });
    let job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.status).toBe('queued');
    expect(job?.steps.configure_pages.status).toBe('succeeded');
    expect(job?.data.pages?.htmlUrl).toBe('https://alice.github.io');
    expect(calls.configure_pages).toBe(1);
    expect(queue.sent).toEqual([{ jobId: 'job-1' }]);

    // dispatch_sync
    outcome = await processProvisioningMessage('job-1', env, runtime);
    expect(outcome).toEqual({ outcome: 'acked' });
    job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.data.sync?.runId).toBe(555);
    expect(job?.data.sync?.conclusion).toBeNull();
    expect(calls.dispatch_sync).toBe(1);

    // await_sync
    outcome = await processProvisioningMessage('job-1', env, runtime);
    job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.data.sync?.conclusion).toBe('success');
    expect(calls.await_sync).toBe(1);

    // await_deploy_build
    outcome = await processProvisioningMessage('job-1', env, runtime);
    job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.data.deployment).toMatchObject({ commitSha: 'generated-head-sha', buildId: 999, status: 'built', verifiedAt: null });
    expect(calls.await_deploy_build).toBe(1);

    // verify_deploy — the last step
    outcome = await processProvisioningMessage('job-1', env, runtime);
    expect(outcome).toEqual({ outcome: 'acked' });
    job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.status).toBe('succeeded');
    expect(job?.completedAt).toBe(2_000);
    expect(job?.lock).toBeNull();
    expect(job?.data.deployment?.verifiedAt).toBe(2_000);
    expect(calls.verify_deploy).toBe(1);

    // Every step ran exactly once across all five invocations, and no further
    // continuation was enqueued once the job reached a terminal status.
    expect(queue.sent).toEqual([{ jobId: 'job-1' }, { jobId: 'job-1' }, { jobId: 'job-1' }, { jobId: 'job-1' }]);
    expect(calls.mint_token).toBe(5);
  });

  test('a crash between steps resumes at the next step without re-running the completed one', async () => {
    const kv = new MemoryKV();
    const env = await testEnv(kv);
    await saveProvisioningJob(env.JOBS, jobAtConfigurePages());
    const { fetcher, calls } = pipelineFetch();
    const runtime = { fetcher, sleep: async () => {}, now: () => 3_000 };

    await processProvisioningMessage('job-1', env, runtime);
    expect(calls.configure_pages).toBe(1);
    expect(calls.dispatch_sync ?? 0).toBe(0);

    // Simulates the queue redelivering a continuation after this Worker
    // instance restarted: a fresh call, same job.
    await processProvisioningMessage('job-1', env, runtime);
    expect(calls.configure_pages).toBe(1);
    expect(calls.dispatch_sync).toBe(1);
  });

  test('duplicate delivery of an already-succeeded job makes no external call', async () => {
    const kv = new MemoryKV();
    const env = await testEnv(kv);
    const finished: ProvisioningJob = { ...makeJob(), status: 'succeeded', completedAt: 1_000 };
    await saveProvisioningJob(env.JOBS, finished);

    const outcome = await processProvisioningMessage('job-1', env, { fetcher: unreachableFetch() });
    expect(outcome).toEqual({ outcome: 'acked' });
    const job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job).toEqual(finished);
  });

  test('a job dead-lettered by a prior attempt is left untouched on redelivery', async () => {
    const kv = new MemoryKV();
    const env = await testEnv(kv);
    const dead: ProvisioningJob = { ...makeJob(), status: 'dead_letter', completedAt: 1_000 };
    await saveProvisioningJob(env.JOBS, dead);

    const outcome = await processProvisioningMessage('job-1', env, { fetcher: unreachableFetch() });
    expect(outcome).toEqual({ outcome: 'acked' });
  });

  test('out-of-order or concurrent delivery defers to whichever attempt holds the lock', async () => {
    const kv = new MemoryKV();
    const env = await testEnv(kv);
    const job = jobAtConfigurePages();
    const locked = tryAcquireProvisioningLock(job, 'other-attempt', 500)!;
    await saveProvisioningJob(env.JOBS, locked);

    const outcome = await processProvisioningMessage('job-1', env, { fetcher: unreachableFetch(), now: () => 800 });
    expect(outcome).toEqual({ outcome: 'retry', delaySeconds: PROVISIONING_LOCK_RETRY_DELAY_SECONDS });
    const stillLocked = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(stillLocked?.lock?.owner).toBe('other-attempt');
  });

  test('a stale lock past its expiry is reclaimed rather than deferred', async () => {
    const kv = new MemoryKV();
    const env = await testEnv(kv);
    const job = jobAtConfigurePages();
    const locked = tryAcquireProvisioningLock(job, 'crashed-attempt', 500)!;
    await saveProvisioningJob(env.JOBS, locked);
    const { fetcher, calls } = pipelineFetch();

    const outcome = await processProvisioningMessage(
      'job-1',
      env,
      { fetcher, sleep: async () => {}, now: () => locked.lock!.expiresAt + 1, lockOwner: () => 'recovering-attempt' },
    );
    expect(outcome).toEqual({ outcome: 'acked' });
    expect(calls.configure_pages).toBe(1);
    const resumed = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(resumed?.steps.configure_pages.status).toBe('succeeded');
  });

  test('a retryable step failure reverts to pending, clears the lock, and reports a backoff delay', async () => {
    const kv = new MemoryKV();
    const env = await testEnv(kv);
    await saveProvisioningJob(env.JOBS, jobAtConfigurePages());
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/app/installations/123/access_tokens') return Response.json({ token: 'installation-token' });
      if (url === 'https://api.github.com/repos/alice/alice.github.io/pages') return new Response(null, { status: 503 });
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const outcome = await processProvisioningMessage('job-1', env, { fetcher, sleep: async () => {}, now: () => 4_000 });
    expect(outcome).toEqual({ outcome: 'retry', delaySeconds: 30 });
    const job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.status).toBe('queued');
    expect(job?.lock).toBeNull();
    expect(job?.steps.configure_pages).toMatchObject({ status: 'pending', attempts: 1 });
    expect(job?.steps.configure_pages.lastError).toEqual({ code: 'github_pages_unavailable', retryable: true });
  });

  test('an ambiguous dispatch failure keeps the persisted marker, so the retry correlates instead of dispatching again', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<{ jobId: string }>();
    const env = await testEnv(kv, queue);
    const readyToDispatch = jobAtConfigurePages();
    readyToDispatch.steps.configure_pages.status = 'succeeded';
    await saveProvisioningJob(env.JOBS, readyToDispatch);

    let dispatchAttempts = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.github.com/app/installations/123/access_tokens') {
        return Response.json({ token: 'installation-token' });
      }
      if (url.endsWith('/actions/workflows/sync-notion.yml/runs?event=workflow_dispatch&per_page=20')) {
        return Response.json({
          workflow_runs: dispatchAttempts > 0
            ? [{
                id: 555,
                html_url: 'https://github.com/alice/alice.github.io/actions/runs/555',
                status: 'in_progress',
                conclusion: null,
                event: 'workflow_dispatch',
                created_at: new Date(2_000).toISOString(),
                head_sha: 'generated-head-sha',
              }]
            : [],
        });
      }
      if (url.endsWith('/actions/workflows/sync-notion.yml/dispatches')) {
        dispatchAttempts += 1;
        // The handler has already persisted the dispatch marker when this
        // fires; a network reset here leaves whether GitHub accepted the
        // dispatch unknown.
        throw new TypeError('network reset after dispatch was sent');
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const first = await processProvisioningMessage('job-1', env, { fetcher, sleep: async () => {}, now: () => 2_000, lockOwner: () => 'attempt-1' });
    expect(first).toEqual({ outcome: 'retry', delaySeconds: 30 });

    const afterFailure = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(afterFailure?.data.syncDispatchMarker).not.toBeNull();

    // The retry must resume by correlating the recorded window — never by
    // issuing a second workflow_dispatch.
    const second = await processProvisioningMessage('job-1', env, { fetcher, sleep: async () => {}, now: () => 3_000, lockOwner: () => 'attempt-2' });
    expect(second).toEqual({ outcome: 'acked' });
    expect(dispatchAttempts).toBe(1);
    const job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.data.sync).toMatchObject({ runId: 555, conclusion: null });
    expect(job?.data.syncDispatchMarker).toBeNull();
    expect(job?.steps.dispatch_sync.status).toBe('succeeded');
    expect(queue.sent).toEqual([{ jobId: 'job-1' }]);
  });

  test('a non-retryable step failure dead-letters the job on its first attempt', async () => {
    const kv = new MemoryKV();
    const env = await testEnv(kv);
    await saveProvisioningJob(env.JOBS, jobAtConfigurePages());
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/app/installations/123/access_tokens') return Response.json({ token: 'installation-token' });
      if (url === 'https://api.github.com/repos/alice/alice.github.io/pages') return new Response(null, { status: 401 });
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const outcome = await processProvisioningMessage('job-1', env, { fetcher, sleep: async () => {}, now: () => 4_000 });
    expect(outcome).toEqual({ outcome: 'acked' });
    const job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.status).toBe('dead_letter');
    expect(job?.steps.configure_pages.status).toBe('failed');
    expect(job?.completedAt).toBe(4_000);
  });

  test('a retryable failure that keeps recurring is dead-lettered once the attempt ceiling is hit', async () => {
    const kv = new MemoryKV();
    const env = await testEnv(kv);
    await saveProvisioningJob(env.JOBS, jobAtConfigurePages());
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/app/installations/123/access_tokens') return Response.json({ token: 'installation-token' });
      if (url === 'https://api.github.com/repos/alice/alice.github.io/pages') return new Response(null, { status: 503 });
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    let outcome;
    for (let attempt = 1; attempt <= PROVISIONING_STEP_MAX_ATTEMPTS; attempt += 1) {
      outcome = await processProvisioningMessage('job-1', env, { fetcher, sleep: async () => {}, now: () => 4_000 + attempt });
    }
    expect(outcome).toEqual({ outcome: 'acked' });
    const job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.status).toBe('dead_letter');
    expect(job?.steps.configure_pages.attempts).toBe(PROVISIONING_STEP_MAX_ATTEMPTS);
  });

  test('an installation-token mint failure is classified and recorded like any other step failure', async () => {
    const kv = new MemoryKV();
    const env = await testEnv(kv);
    await saveProvisioningJob(env.JOBS, jobAtConfigurePages());
    const fetcher = (async () => new Response(null, { status: 404 })) as typeof fetch;

    const outcome = await processProvisioningMessage('job-1', env, { fetcher, now: () => 5_000 });
    expect(outcome).toEqual({ outcome: 'acked' });
    const job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.status).toBe('dead_letter');
    expect(job?.steps.configure_pages.lastError?.code).toBe('github_app_auth_failed');
  });

  test('a partially completed job finishes from wherever it left off without redoing prior steps', async () => {
    const kv = new MemoryKV();
    const env = await testEnv(kv);
    const partial = jobAtConfigurePages();
    partial.steps.configure_pages.status = 'succeeded';
    partial.data.pages = { status: 'built', url: 'x', htmlUrl: 'https://alice.github.io', buildType: 'legacy', source: { branch: 'main', path: '/' }, reused: false };
    await saveProvisioningJob(env.JOBS, partial);
    const { fetcher, calls } = pipelineFetch();
    const runtime = { fetcher, sleep: async () => {}, now: () => 6_000 };

    let outcome = await processProvisioningMessage('job-1', env, runtime); // dispatch_sync
    outcome = await processProvisioningMessage('job-1', env, runtime); // await_sync
    outcome = await processProvisioningMessage('job-1', env, runtime); // await_deploy_build
    outcome = await processProvisioningMessage('job-1', env, runtime); // verify_deploy
    expect(outcome).toEqual({ outcome: 'acked' });
    expect(calls.configure_pages ?? 0).toBe(0);
    const job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.status).toBe('succeeded');
  });
});
