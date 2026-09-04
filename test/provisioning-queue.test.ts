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
  PROVISIONING_JOB_PREFIX,
  PROVISIONING_LOCK_RETRY_DELAY_SECONDS,
  PROVISIONING_RATE_LIMIT_MAX_ATTEMPTS,
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
import { accountLeaseKey, GLOBAL_RATE_KEY, type AccountLease, type GlobalRateState } from '../src/provisioning-throttle';

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
  readonly sendOptions: Array<{ delaySeconds?: number } | null> = [];

  async send(message: T, options?: { delaySeconds?: number }): Promise<void> {
    this.sent.push(message);
    this.sendOptions.push(options ?? null);
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
  // The queue only ever sees a job the Notion callback already finished with:
  // secrets written, status flipped off `awaiting_notion`.
  return {
    ...job,
    status: 'queued',
    data: { ...job.data, notionSecretsWrittenAt: 900, ...dataOverrides },
  };
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

  test('retries a rate-limited config patch and passes through its retry-after', () => {
    expect(classifyProvisioningError(new GithubConfigError('github_config_rate_limited', 429, 90)))
      .toEqual({ code: 'github_config_rate_limited', retryable: true, retryAfterSeconds: 90 });
  });

  test('passes an app-auth 429 retry-after through', () => {
    expect(classifyProvisioningError(new GithubAppAuthError(429, 45)))
      .toEqual({ code: 'github_app_auth_failed', retryable: true, retryAfterSeconds: 45 });
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

  test('waits instead of running a job whose Notion secrets were never written', async () => {
    const kv = new MemoryKV();
    const env = await testEnv(kv);
    const awaitingNotion: ProvisioningJob = {
      ...makeJob({}, { notionSecretsWrittenAt: null }),
      status: 'awaiting_notion',
    };
    await saveProvisioningJob(env.JOBS, awaitingNotion);

    const outcome = await processProvisioningMessage('job-1', env, { fetcher: unreachableFetch() });
    expect(outcome).toEqual({ outcome: 'retry', delaySeconds: PROVISIONING_LOCK_RETRY_DELAY_SECONDS });
    expect(await loadProvisioningJob(env.JOBS, 'job-1')).toEqual(awaitingNotion);
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

    const outcome = await processProvisioningMessage('job-1', env, { fetcher, sleep: async () => {}, now: () => 4_000, rng: () => 0 });
    expect(outcome).toEqual({ outcome: 'retry', delaySeconds: 30 });
    const job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.status).toBe('queued');
    expect(job?.lock).toBeNull();
    expect(job?.steps.configure_pages).toMatchObject({ status: 'pending', attempts: 1 });
    expect(job?.steps.configure_pages.lastError).toEqual({ code: 'github_pages_unavailable', retryable: true });
  });

  test('a retryable failure carries bounded jitter from the injected rng', async () => {
    const kv = new MemoryKV();
    const env = await testEnv(kv);
    await saveProvisioningJob(env.JOBS, jobAtConfigurePages());
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/app/installations/123/access_tokens') return Response.json({ token: 'installation-token' });
      if (url === 'https://api.github.com/repos/alice/alice.github.io/pages') return new Response(null, { status: 503 });
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    // 30s base backoff + floor(0.5 · 30 · 0.25) of jitter.
    const outcome = await processProvisioningMessage('job-1', env, { fetcher, sleep: async () => {}, now: () => 4_000, rng: () => 0.5 });
    expect(outcome).toEqual({ outcome: 'retry', delaySeconds: 33 });
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

    const first = await processProvisioningMessage('job-1', env, { fetcher, sleep: async () => {}, now: () => 2_000, lockOwner: () => 'attempt-1', rng: () => 0 });
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

  test('never persists the installation token anywhere in the job record', async () => {
    const kv = new MemoryKV();
    const env = await testEnv(kv);
    await saveProvisioningJob(env.JOBS, jobAtConfigurePages());
    const { fetcher } = pipelineFetch();
    const runtime = { fetcher, sleep: async () => {}, now: () => 7_000 };
    // MemoryKV keeps only the latest value per key, so inspect every write:
    // an intermediate save that leaked the token before being overwritten
    // would otherwise pass this tripwire.
    const writes: string[] = [];
    const spyingKv = {
      get: kv.get.bind(kv),
      put: async (key: string, value: string, options?: unknown) => {
        writes.push(value);
        return kv.put(key, value, options as never);
      },
    } as unknown as KVNamespace;

    for (let i = 0; i < 5; i += 1) await processProvisioningMessage('job-1', { ...env, JOBS: spyingKv }, runtime);

    const job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.status).toBe('succeeded');
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.join('\n')).not.toContain('installation-token');
  });

  test('a retryable correlate timeout after a confirmed dispatch preserves the marker, not the stale pre-handler snapshot', async () => {
    const kv = new MemoryKV();
    const env = await testEnv(kv);
    const job = jobAtConfigurePages();
    job.steps.configure_pages.status = 'succeeded';
    job.data.pages = { status: 'built', url: 'x', htmlUrl: 'https://alice.github.io', buildType: 'legacy', source: { branch: 'main', path: '/' }, reused: false };
    await saveProvisioningJob(env.JOBS, job);

    let dispatchCalls = 0;
    let correlatable = false;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.github.com/app/installations/123/access_tokens') return Response.json({ token: 'installation-token' });
      if (url.includes('/actions/workflows/sync-notion.yml/runs?')) {
        return Response.json({
          workflow_runs: correlatable
            // A fake-epoch `created_at` consistent with this test's `now()`
            // (8_000/9_000), so the correlation window filter is actually
            // exercised instead of vacuously passing a real-epoch timestamp.
            ? [{ id: 555, html_url: 'https://github.com/alice/alice.github.io/actions/runs/555', status: 'completed', conclusion: null, event: 'workflow_dispatch', created_at: new Date(8_500).toISOString() }]
            : [],
        });
      }
      if (url.endsWith('/dispatches') && init?.method === 'POST') {
        dispatchCalls += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    // The dispatch POST itself succeeds this time, but correlation never
    // finds a matching run in time and times out — a retryable failure that
    // happens strictly after runDispatchSync's own successful pre-dispatch
    // marker write, distinct from the POST itself failing.
    const first = await processProvisioningMessage('job-1', env, { fetcher, sleep: async () => {}, now: () => 8_000, rng: () => 0 });
    expect(first).toEqual({ outcome: 'retry', delaySeconds: 30 });
    expect(dispatchCalls).toBe(1);
    const afterFailure = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(afterFailure?.data.syncDispatchMarker).not.toBeNull();
    expect(afterFailure?.data.sync).toBeNull();
    expect(afterFailure?.steps.dispatch_sync).toMatchObject({ status: 'pending', attempts: 1 });

    correlatable = true;
    const second = await processProvisioningMessage('job-1', env, { fetcher, sleep: async () => {}, now: () => 9_000 });
    expect(second).toEqual({ outcome: 'acked' });
    expect(dispatchCalls).toBe(1);
    const afterResume = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(afterResume?.data.sync).toMatchObject({ runId: 555 });
    expect(afterResume?.data.syncDispatchMarker).toBeNull();
  });

  test('a failure to enqueue the continuation after a successful step preserves that success and asks for redelivery', async () => {
    const kv = new MemoryKV();
    const env = await testEnv(kv);
    await saveProvisioningJob(env.JOBS, jobAtConfigurePages());
    const { fetcher, calls } = pipelineFetch();
    const brokenQueue: Queue<{ jobId: string }> = {
      send: async () => { throw new Error('queue outage'); },
    } as unknown as Queue<{ jobId: string }>;

    const outcome = await processProvisioningMessage(
      'job-1',
      { ...env, PROVISIONING_QUEUE: brokenQueue },
      { fetcher, sleep: async () => {}, now: () => 10_000 },
    );
    expect(outcome).toEqual({ outcome: 'retry', delaySeconds: 10 });
    expect(calls.configure_pages).toBe(1);

    const afterFailedSend = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(afterFailedSend?.status).toBe('queued');
    expect(afterFailedSend?.steps.configure_pages.status).toBe('succeeded');
    expect(afterFailedSend?.steps.configure_pages.attempts).toBe(1);
    expect(afterFailedSend?.data.pages?.htmlUrl).toBe('https://alice.github.io');
    // The stall is visible on the record: the step now waiting carries the
    // breadcrumb, so this job never reads as healthy while its handoff is
    // missing.
    expect(afterFailedSend?.steps.dispatch_sync.lastError).toEqual({ code: 'provisioning_enqueue_failed', retryable: true });

    // Redelivery of the same message (the queue's own retry, not a fresh
    // continuation) must not re-run configure_pages.
    const redelivered = await processProvisioningMessage('job-1', env, { fetcher, sleep: async () => {}, now: () => 10_001 });
    expect(redelivered).toEqual({ outcome: 'acked' });
    expect(calls.configure_pages).toBe(1);
    expect(calls.dispatch_sync).toBe(1);

    // Running the breadcrumb's step clears it — the record no longer shows
    // a stall that has already been handed off.
    const afterResume = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(afterResume?.steps.configure_pages.status).toBe('succeeded');
    expect(afterResume?.steps.dispatch_sync.lastError).toBeNull();
  });

  test('a KV write failure while persisting a successful step counts as a step failure and re-runs it on redelivery', async () => {
    const kv = new MemoryKV();
    const env = await testEnv(kv);
    await saveProvisioningJob(env.JOBS, jobAtConfigurePages());
    const { fetcher, calls } = pipelineFetch();

    // Fail exactly the completed-result save: the job-record writes per
    // delivery are the locked record, the in-progress record, then the
    // completed result. The gate's lease and counter writes carry other key
    // prefixes and don't count.
    let jobPuts = 0;
    const flakyKv = {
      get: kv.get.bind(kv),
      put: async (key: string, value: string, options?: unknown) => {
        if (key.startsWith(PROVISIONING_JOB_PREFIX)) {
          jobPuts += 1;
          if (jobPuts === 3) throw new Error('kv write blip');
        }
        return kv.put(key, value, options as never);
      },
    } as unknown as KVNamespace;

    const outcome = await processProvisioningMessage('job-1', { ...env, JOBS: flakyKv }, { fetcher, sleep: async () => {}, now: () => 15_000, rng: () => 0 });
    expect(outcome).toEqual({ outcome: 'retry', delaySeconds: 30 });

    // The success was never durable, so the standard failure path applies:
    // lock released, step back to pending with its attempt counted, no
    // phantom result data, and the record is resumable rather than wedged
    // behind a live lock.
    const afterSaveFailure = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(afterSaveFailure?.status).toBe('queued');
    expect(afterSaveFailure?.lock).toBeNull();
    expect(afterSaveFailure?.steps.configure_pages).toMatchObject({ status: 'pending', attempts: 1 });
    expect(afterSaveFailure?.data.pages).toBeNull();

    // A healthy redelivery re-runs exactly configure_pages (the first POST's
    // result was lost with the failed write) and advances the pipeline.
    const redelivered = await processProvisioningMessage('job-1', env, { fetcher, sleep: async () => {}, now: () => 15_001 });
    expect(redelivered).toEqual({ outcome: 'acked' });
    expect(calls.configure_pages).toBe(2);
    const afterResume = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(afterResume?.steps.configure_pages).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  test('patch_config advances through the queue without redoing verify_repository', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<{ jobId: string }>();
    const env = await testEnv(kv, queue);
    const job = makeJob();
    job.steps.verify_repository.status = 'succeeded';
    await saveProvisioningJob(env.JOBS, job);

    let putCalls = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.github.com/app/installations/123/access_tokens') return Response.json({ token: 'installation-token' });
      if (url.startsWith('https://api.github.com/repos/alice/alice.github.io/contents/_config.yml')) {
        if (init?.method === 'PUT') {
          putCalls += 1;
          return Response.json({ content: { sha: 'patched-sha' }, commit: { sha: 'commit-sha' } });
        }
        return Response.json({ type: 'file', encoding: 'base64', content: base64(CONFIG_YAML), sha: 'config-sha' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const outcome = await processProvisioningMessage('job-1', env, { fetcher, sleep: async () => {}, now: () => 11_000 });
    expect(outcome).toEqual({ outcome: 'acked' });
    expect(putCalls).toBe(1);
    const stored = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(stored?.steps.patch_config.status).toBe('succeeded');
    expect(stored?.steps.verify_repository.status).toBe('succeeded');
    expect(queue.sent).toEqual([{ jobId: 'job-1' }]);
  });

  test('patch_config dead-letters on an unparseable config instead of retrying', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<{ jobId: string }>();
    const env = await testEnv(kv, queue);
    const job = makeJob();
    job.steps.verify_repository.status = 'succeeded';
    await saveProvisioningJob(env.JOBS, job);

    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.github.com/app/installations/123/access_tokens') return Response.json({ token: 'installation-token' });
      if (url.startsWith('https://api.github.com/repos/alice/alice.github.io/contents/_config.yml')) {
        if (init?.method === 'PUT') throw new Error('an invalid config must never be patched');
        // Duplicate `url` keys make the config parser throw
        // `github_config_invalid` (terminal) before any PUT is attempted.
        return Response.json({ type: 'file', encoding: 'base64', content: base64('url: ""\nurl: ""\nbaseurl: ""\n'), sha: 'config-sha' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const outcome = await processProvisioningMessage('job-1', env, { fetcher, sleep: async () => {}, now: () => 17_000 });
    expect(outcome).toEqual({ outcome: 'acked' });
    const stored = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(stored?.status).toBe('dead_letter');
    expect(stored?.steps.patch_config.lastError).toEqual({ code: 'github_config_invalid', retryable: false });
    expect(queue.sent).toEqual([]);
  });

  test('verify_repository dead-letters on a branch mismatch instead of retrying', async () => {
    const kv = new MemoryKV();
    const env = await testEnv(kv);
    await saveProvisioningJob(env.JOBS, makeJob());
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/app/installations/123/access_tokens') return Response.json({ token: 'installation-token' });
      if (url === 'https://api.github.com/repos/alice/alice.github.io') return Response.json({ id: 1001, full_name: 'alice/alice.github.io', default_branch: 'main', fork: true });
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const outcome = await processProvisioningMessage('job-1', env, { fetcher, sleep: async () => {}, now: () => 12_000 });
    expect(outcome).toEqual({ outcome: 'acked' });
    const stored = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(stored?.status).toBe('dead_letter');
    expect(stored?.steps.verify_repository.lastError?.code).toBe('github_generate_branch_mismatch');
  });

  test('await_sync dead-letters on a failed sync run conclusion without enqueuing a continuation', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<{ jobId: string }>();
    const env = await testEnv(kv, queue);
    const job = jobAtConfigurePages();
    job.steps.configure_pages.status = 'succeeded';
    job.steps.dispatch_sync.status = 'succeeded';
    job.data.sync = { runId: 555, htmlUrl: 'https://github.com/alice/alice.github.io/actions/runs/555', conclusion: null };
    await saveProvisioningJob(env.JOBS, job);
    const { fetcher } = pipelineFetch({ runConclusion: 'failure' });

    const outcome = await processProvisioningMessage('job-1', env, { fetcher, sleep: async () => {}, now: () => 13_000 });
    expect(outcome).toEqual({ outcome: 'acked' });
    const stored = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(stored?.status).toBe('dead_letter');
    expect(stored?.steps.await_sync.lastError).toEqual({ code: 'github_sync_run_failed', retryable: false });
    expect(queue.sent).toEqual([]);
  });

  test('await_deploy_build dead-letters on an errored Pages build without enqueuing a continuation', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<{ jobId: string }>();
    const env = await testEnv(kv, queue);
    const job = jobAtConfigurePages();
    job.steps.configure_pages.status = 'succeeded';
    job.steps.dispatch_sync.status = 'succeeded';
    job.steps.await_sync.status = 'succeeded';
    job.data.sync = { runId: 555, htmlUrl: 'https://github.com/alice/alice.github.io/actions/runs/555', conclusion: 'success' };
    await saveProvisioningJob(env.JOBS, job);
    const { fetcher } = pipelineFetch({ buildStatus: 'errored' });

    const outcome = await processProvisioningMessage('job-1', env, { fetcher, sleep: async () => {}, now: () => 14_000 });
    expect(outcome).toEqual({ outcome: 'acked' });
    const stored = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(stored?.status).toBe('dead_letter');
    expect(stored?.steps.await_deploy_build.lastError).toEqual({ code: 'github_deploy_build_failed', retryable: false });
    expect(queue.sent).toEqual([]);
  });

  test('a rate-limited step failure rides a fresh delayed message instead of the platform retry', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<{ jobId: string }>();
    const env = await testEnv(kv, queue);
    await saveProvisioningJob(env.JOBS, jobAtConfigurePages());
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/app/installations/123/access_tokens') return Response.json({ token: 'installation-token' });
      if (url === 'https://api.github.com/repos/alice/alice.github.io/pages') {
        return new Response(null, { status: 429, headers: { 'retry-after': '120' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const outcome = await processProvisioningMessage('job-1', env, { fetcher, sleep: async () => {}, now: () => 4_000, rng: () => 0 });
    expect(outcome).toEqual({ outcome: 'acked' });
    expect(queue.sent).toEqual([{ jobId: 'job-1' }]);
    expect(queue.sendOptions[0]).toEqual({ delaySeconds: 120 });

    const job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.status).toBe('queued');
    expect(job?.lock).toBeNull();
    expect(job?.steps.configure_pages).toMatchObject({ status: 'pending', attempts: 1 });
    expect(job?.steps.configure_pages.lastError).toEqual({ code: 'github_pages_rate_limited', retryable: true });
  });

  test('repeated rate-limited failures bypass the five-attempt ceiling and dead-letter only at 24', async () => {
    const kv = new MemoryKV();
    const env = await testEnv(kv);
    await saveProvisioningJob(env.JOBS, jobAtConfigurePages());
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/app/installations/123/access_tokens') return Response.json({ token: 'installation-token' });
      if (url === 'https://api.github.com/repos/alice/alice.github.io/pages') {
        return new Response(null, { status: 403, headers: { 'retry-after': '60' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const runtime = { fetcher, sleep: async () => {}, now: () => 4_000, rng: () => 0 };
    for (let attempt = 1; attempt < PROVISIONING_RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      const outcome = await processProvisioningMessage('job-1', env, runtime);
      expect(outcome).toEqual({ outcome: 'acked' });
      const job = await loadProvisioningJob(env.JOBS, 'job-1');
      expect(job?.status).toBe('queued');
      expect(job?.steps.configure_pages.attempts).toBe(attempt);
    }

    const final = await processProvisioningMessage('job-1', env, runtime);
    expect(final).toEqual({ outcome: 'acked' });
    const job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.status).toBe('dead_letter');
    expect(job?.steps.configure_pages.attempts).toBe(PROVISIONING_RATE_LIMIT_MAX_ATTEMPTS);
    expect(job?.completedAt).toBe(4_000);
  });

  test('a rate-limited retry whose fresh send fails falls back to a platform retry with the same delay', async () => {
    const kv = new MemoryKV();
    const env = await testEnv(kv);
    await saveProvisioningJob(env.JOBS, jobAtConfigurePages());
    const brokenQueue: Queue<{ jobId: string }> = {
      send: async () => { throw new Error('queue outage'); },
    } as unknown as Queue<{ jobId: string }>;
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/app/installations/123/access_tokens') return Response.json({ token: 'installation-token' });
      if (url === 'https://api.github.com/repos/alice/alice.github.io/pages') {
        return new Response(null, { status: 429, headers: { 'retry-after': '90' } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const outcome = await processProvisioningMessage(
      'job-1',
      { ...env, PROVISIONING_QUEUE: brokenQueue },
      { fetcher, sleep: async () => {}, now: () => 4_000, rng: () => 0 },
    );
    expect(outcome).toEqual({ outcome: 'retry', delaySeconds: 90 });
    const job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.status).toBe('queued');
  });

  test('a rate-limited installation-token mint rides the fresh-message path too', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<{ jobId: string }>();
    const env = await testEnv(kv, queue);
    await saveProvisioningJob(env.JOBS, jobAtConfigurePages());
    const fetcher = (async () => new Response(null, { status: 403, headers: { 'retry-after': '45' } })) as typeof fetch;

    const outcome = await processProvisioningMessage('job-1', env, { fetcher, sleep: async () => {}, now: () => 4_000, rng: () => 0 });
    expect(outcome).toEqual({ outcome: 'acked' });
    expect(queue.sent).toEqual([{ jobId: 'job-1' }]);
    expect(queue.sendOptions[0]).toEqual({ delaySeconds: 45 });
    const job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.steps.configure_pages.lastError).toEqual({ code: 'github_app_auth_failed', retryable: true });
  });
});

/** Seeds the global rate counter as exhausted for the fixed window that
 * contains `nowMs`, so every budgeted gate pass is refused. */
async function exhaustGlobalBudget(kv: MemoryKV, nowMs: number): Promise<void> {
  const state: GlobalRateState = {
    version: 1,
    minuteBucket: Math.floor(nowMs / 60_000),
    hourBucket: Math.floor(nowMs / 3_600_000),
    minuteCount: 30,
    hourCount: 240,
  };
  await kv.put(GLOBAL_RATE_KEY, JSON.stringify(state), { expirationTtl: 7200 });
}

async function putAccountLease(kv: MemoryKV, lease: AccountLease, accountId = 42): Promise<void> {
  await kv.put(accountLeaseKey(accountId), JSON.stringify(lease), { expirationTtl: 1800 });
}

describe('provisioning throttle gate', () => {
  test('a gate wait parks the job queued with a breadcrumb and a fresh delayed message, minting no token', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<{ jobId: string }>();
    const env = await testEnv(kv, queue);
    await saveProvisioningJob(env.JOBS, jobAtConfigurePages());
    await exhaustGlobalBudget(kv, 18_000);

    const outcome = await processProvisioningMessage(
      'job-1',
      env,
      { fetcher: unreachableFetch(), sleep: async () => {}, now: () => 18_000, rng: () => 0 },
    );

    expect(outcome).toEqual({ outcome: 'acked' });
    expect(queue.sent).toEqual([{ jobId: 'job-1' }]);
    expect(queue.sendOptions[0]?.delaySeconds).toBeGreaterThanOrEqual(1);

    const job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.status).toBe('queued');
    expect(job?.lock).toBeNull();
    expect(job?.steps.configure_pages.attempts).toBe(0);
    expect(job?.steps.configure_pages.status).toBe('pending');
    expect(job?.wait?.reason).toBe('global_throttled');
    expect(job?.wait?.updatedAt).toBe(18_000);
    expect(job?.wait?.untilMs).toBe(18_000 + queue.sendOptions[0]!.delaySeconds! * 1000);
  });

  test('five consecutive gate refusals never consume an attempt nor dead-letter', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<{ jobId: string }>();
    const env = await testEnv(kv, queue);
    await saveProvisioningJob(env.JOBS, jobAtConfigurePages());
    await exhaustGlobalBudget(kv, 18_000);
    const runtime = { fetcher: unreachableFetch(), sleep: async () => {}, now: () => 18_000, rng: () => 0 };

    for (let pass = 0; pass < 5; pass += 1) {
      expect(await processProvisioningMessage('job-1', env, runtime)).toEqual({ outcome: 'acked' });
    }

    const job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.status).toBe('queued');
    expect(job?.steps.configure_pages.attempts).toBe(0);
    expect(queue.sent).toHaveLength(5);
  });

  test('the wait breadcrumb clears when the step next books', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<{ jobId: string }>();
    const env = await testEnv(kv, queue);
    await saveProvisioningJob(env.JOBS, jobAtConfigurePages());
    await exhaustGlobalBudget(kv, 18_000);
    const gatedRuntime = { fetcher: unreachableFetch(), sleep: async () => {}, now: () => 18_000, rng: () => 0 };

    await processProvisioningMessage('job-1', env, gatedRuntime);
    expect((await loadProvisioningJob(env.JOBS, 'job-1'))?.wait).not.toBeNull();

    // The window rolls: the next delivery re-evaluates and books the step.
    await kv.put(GLOBAL_RATE_KEY, JSON.stringify({
      version: 1,
      minuteBucket: Math.floor(78_000 / 60_000),
      hourBucket: Math.floor(78_000 / 3_600_000),
      minuteCount: 0,
      hourCount: 0,
    }), { expirationTtl: 7200 });
    const { fetcher, calls } = pipelineFetch();
    const outcome = await processProvisioningMessage(
      'job-1',
      env,
      { fetcher, sleep: async () => {}, now: () => 78_000, rng: () => 0 },
    );

    expect(outcome).toEqual({ outcome: 'acked' });
    expect(calls.mint_token).toBe(1);
    expect(calls.configure_pages).toBe(1);
    const job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.steps.configure_pages.status).toBe('succeeded');
    expect(job?.wait).toBeNull();
  });

  test('a foreign live lease supersedes the job terminally without touching a provider', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<{ jobId: string }>();
    const env = await testEnv(kv, queue);
    await saveProvisioningJob(env.JOBS, jobAtConfigurePages());
    await putAccountLease(kv, { version: 1, jobId: 'job-0', expiresAt: 30_000 });

    const outcome = await processProvisioningMessage(
      'job-1',
      env,
      { fetcher: unreachableFetch(), sleep: async () => {}, now: () => 18_000, rng: () => 0 },
    );

    expect(outcome).toEqual({ outcome: 'acked' });
    expect(queue.sent).toEqual([]);
    const job = await loadProvisioningJob(env.JOBS, 'job-1');
    expect(job?.status).toBe('failed');
    expect(job?.completedAt).toBe(18_000);
    expect(job?.steps.configure_pages.lastError).toEqual({ code: 'github_provisioning_superseded', retryable: false });
    // The live owner keeps the lease; the superseded duplicate never steals it.
    expect(JSON.parse(await kv.get(accountLeaseKey(42)) as string)).toMatchObject({ jobId: 'job-0' });
  });

  test('a read step renews the account lease without consuming budget', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<{ jobId: string }>();
    const env = await testEnv(kv, queue);
    await saveProvisioningJob(env.JOBS, makeJob());
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.github.com/app/installations/123/access_tokens') return Response.json({ token: 'installation-token' });
      if (url === 'https://api.github.com/repos/alice/alice.github.io') {
        return Response.json({ id: 1001, full_name: 'alice/alice.github.io', default_branch: 'main', fork: false });
      }
      if (url === 'https://api.github.com/repos/alice/alice.github.io/commits/main') {
        return Response.json({ sha: 'generated-head-sha', commit: { tree: { sha: 'generated-tree-sha' } } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const outcome = await processProvisioningMessage('job-1', env, { fetcher, sleep: async () => {}, now: () => 18_000, rng: () => 0 });

    expect(outcome).toEqual({ outcome: 'acked' });
    expect(await kv.get(GLOBAL_RATE_KEY)).toBeNull();
    const lease = JSON.parse(await kv.get(accountLeaseKey(42)) as string) as AccountLease;
    expect(lease).toMatchObject({ version: 1, jobId: 'job-1', expiresAt: 18_000 + 1800_000 });
  });
});
