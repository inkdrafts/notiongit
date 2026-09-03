import { describe, expect, test } from 'bun:test';

import { processProvisioningMessage, type ProvisioningQueueEnv } from '../src/provisioning-queue';
import {
  createProvisioningJob,
  loadProvisioningJob,
  saveProvisioningJob,
  PROVISIONING_STEP_MAX_ATTEMPTS,
  PROVISIONING_STEP_ORDER,
  type ProvisioningJob,
} from '../src/provisioning-job';

const JOB_ID = 'job-funnel';

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
}

class FakeMetrics {
  readonly points: AnalyticsEngineDataPoint[] = [];

  writeDataPoint(event?: AnalyticsEngineDataPoint): void {
    this.points.push(event ?? {});
  }
}

interface EmittedEvent {
  type: string;
  jobId: string;
  step?: string;
  attempt?: number;
  terminal?: boolean;
  errorCode?: string;
  durationMs?: number;
  totalDurationMs?: number;
}

async function captureEvents(run: () => Promise<void>): Promise<EmittedEvent[]> {
  const original = console.log;
  const events: EmittedEvent[] = [];
  console.log = (...args: unknown[]) => {
    events.push(JSON.parse(args.map((argument) => String(argument)).join(' ')) as EmittedEvent);
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return events;
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

function freshJob(): ProvisioningJob {
  return createProvisioningJob({
    jobId: JOB_ID,
    installationId: 123,
    identity: { id: 42, login: 'alice', accountType: 'User' },
    repository: { name: 'alice.github.io', url: 'https://alice.github.io', baseurl: '', kind: 'apex' },
    generatedRepository: {
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
    },
    now: 1_000,
  });
}

function base64(content: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(content)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const CONFIG_YAML = 'title: "NotionGit"\nurl: ""\nbaseurl: ""\n';

function fullPipelineFetch(overrides: { siteReachable?: boolean } = {}): typeof fetch {
  let syncDispatched = false;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://api.github.com/app/installations/123/access_tokens') {
      return Response.json({ token: 'installation-token' });
    }
    if (url === 'https://api.github.com/repos/alice/alice.github.io') {
      return Response.json({ id: 1001, full_name: 'alice/alice.github.io', default_branch: 'main', fork: false });
    }
    if (url === 'https://api.github.com/repos/alice/alice.github.io/commits/main') {
      return Response.json({ sha: 'generated-head-sha', commit: { tree: { sha: 'generated-tree-sha' } } });
    }
    if (url.startsWith('https://api.github.com/repos/alice/alice.github.io/contents/_config.yml')) {
      if (init?.method === 'PUT') return Response.json({ content: { sha: 'patched-sha' }, commit: { sha: 'commit-sha' } });
      return Response.json({ type: 'file', encoding: 'base64', content: base64(CONFIG_YAML), sha: 'config-sha' });
    }
    if (url === 'https://api.github.com/repos/alice/alice.github.io/pages' && init?.method === 'POST') {
      return Response.json({
        status: 'built',
        url: 'https://api.github.com/repos/alice/alice.github.io/pages',
        html_url: 'https://alice.github.io',
        build_type: 'legacy',
        source: { branch: 'main', path: '/' },
      }, { status: 201 });
    }
    if (url.includes('/actions/workflows/sync-notion.yml/runs?')) {
      return Response.json({
        workflow_runs: syncDispatched
          ? [{
              id: 555,
              html_url: 'https://github.com/alice/alice.github.io/actions/runs/555',
              status: 'completed',
              conclusion: null,
              event: 'workflow_dispatch',
              created_at: new Date().toISOString(),
            }]
          : [],
      });
    }
    if (url.endsWith('/actions/workflows/sync-notion.yml/dispatches')) {
      syncDispatched = true;
      return new Response(null, { status: 204 });
    }
    if (url === 'https://api.github.com/repos/alice/alice.github.io/actions/runs/555') {
      return Response.json({
        id: 555,
        html_url: 'https://github.com/alice/alice.github.io/actions/runs/555',
        status: 'completed',
        conclusion: 'success',
      });
    }
    if (url === 'https://api.github.com/repos/alice/alice.github.io/pages/builds/latest') {
      return Response.json({
        url: 'https://api.github.com/repos/alice/alice.github.io/builds/999',
        status: 'built',
        commit: 'generated-head-sha',
      });
    }
    if (url === 'https://alice.github.io') {
      if (overrides.siteReachable === false) return new Response('not found', { status: 404 });
      return new Response('<!doctype html>', { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

async function funnelEnv(metrics: FakeMetrics): Promise<ProvisioningQueueEnv> {
  return {
    JOBS: new MemoryKV() as unknown as KVNamespace,
    PROVISIONING_QUEUE: new MemoryQueue<{ jobId: string }>() as unknown as Queue<{ jobId: string }>,
    PROVISIONING_METRICS: metrics as unknown as AnalyticsEngineDataset,
    GITHUB_APP_ID: '4798518',
    GITHUB_APP_PRIVATE_KEY: await generateThrowawayPrivateKey(),
  };
}

describe('synthetic provisioning funnel', () => {
  test('a job that succeeds emits a started/succeeded pair per step and one job_succeeded', async () => {
    const metrics = new FakeMetrics();
    const env = await funnelEnv(metrics);
    await saveProvisioningJob(env.JOBS, freshJob());
    const fetcher = fullPipelineFetch();

    let elapsed = 1_000;
    const events = await captureEvents(async () => {
      for (let invocation = 0; invocation < PROVISIONING_STEP_ORDER.length; invocation += 1) {
        const outcome = await processProvisioningMessage(JOB_ID, env, {
          fetcher,
          sleep: async () => {},
          now: () => (elapsed += 100),
        });
        expect(outcome).toEqual({ outcome: 'acked' });
      }
    });

    const expected = PROVISIONING_STEP_ORDER.flatMap((step) => [
      { type: 'step_started', step },
      { type: 'step_succeeded', step },
    ]);
    expect(events.map(({ type, step }) => (step ? { type, step } : { type })))
      .toEqual([...expected, { type: 'job_succeeded' }]);

    expect(new Set(events.map((event) => event.jobId))).toEqual(new Set([JOB_ID]));
    expect(events.filter((event) => event.type === 'step_succeeded').every((event) => event.attempt === 1)).toBe(true);
    expect(events.at(-1)?.totalDurationMs).toBeGreaterThan(0);
    expect((await loadProvisioningJob(env.JOBS, JOB_ID))?.status).toBe('succeeded');
    expect(metrics.points).toHaveLength(events.length);
    expect(metrics.points.map((point) => point.indexes?.[0])).toEqual(events.map((event) => event.type));
  });

  test('a job that exhausts its retries emits a failure per attempt and one job_dead_lettered', async () => {
    const metrics = new FakeMetrics();
    const env = await funnelEnv(metrics);
    const job = freshJob();
    for (const step of PROVISIONING_STEP_ORDER) {
      if (step !== 'verify_deploy') job.steps[step].status = 'succeeded';
    }
    job.data.pages = {
      status: 'built',
      url: 'https://api.github.com/repos/alice/alice.github.io/pages',
      htmlUrl: 'https://alice.github.io',
      buildType: 'legacy',
      source: { branch: 'main', path: '/' },
      reused: false,
    };
    job.data.deployment = { commitSha: 'generated-head-sha', buildId: 999, status: 'built', verifiedAt: null };
    await saveProvisioningJob(env.JOBS, job);
    const fetcher = fullPipelineFetch({ siteReachable: false });

    let elapsed = 1_000;
    const events = await captureEvents(async () => {
      for (let attempt = 0; attempt < PROVISIONING_STEP_MAX_ATTEMPTS; attempt += 1) {
        await processProvisioningMessage(JOB_ID, env, {
          fetcher,
          sleep: async () => {},
          now: () => (elapsed += 100),
        });
      }
    });

    const attemptPairs = Array.from({ length: PROVISIONING_STEP_MAX_ATTEMPTS }, () => [
      { type: 'step_started', step: 'verify_deploy' },
      { type: 'step_failed', step: 'verify_deploy' },
    ]).flat();
    expect(events.map(({ type, step }) => (step ? { type, step } : { type })))
      .toEqual([...attemptPairs, { type: 'job_dead_lettered', step: 'verify_deploy' }]);

    expect(new Set(events.map((event) => event.jobId))).toEqual(new Set([JOB_ID]));
    const failures = events.filter((event) => event.type === 'step_failed');
    expect(failures.map((event) => event.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(failures.map((event) => event.terminal)).toEqual([false, false, false, false, true]);
    expect(new Set(failures.map((event) => event.errorCode))).toEqual(new Set(['github_deploy_url_unreachable']));
    expect(events.at(-1)?.errorCode).toBe('github_deploy_url_unreachable');
    expect((await loadProvisioningJob(env.JOBS, JOB_ID))?.status).toBe('dead_letter');
    expect(metrics.points).toHaveLength(events.length);
  });
});
