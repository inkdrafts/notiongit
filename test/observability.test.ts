import { describe, expect, test } from 'bun:test';

import { emitProvisioningEvent, type ProvisioningEvent } from '../src/observability';
import { processProvisioningMessage, type ProvisioningQueueEnv } from '../src/provisioning-queue';
import {
  createProvisioningJob,
  loadProvisioningJob,
  provisioningJobKey,
  PROVISIONING_STEP_MAX_ATTEMPTS,
  type ProvisioningJob,
} from '../src/provisioning-job';
import { GithubSyncError } from '../src/notion-sync';

const CANARY = 'ghs_CANARY1234567890abcdef';

class FakeMetrics {
  readonly points: AnalyticsEngineDataPoint[] = [];

  writeDataPoint(event?: AnalyticsEngineDataPoint): void {
    this.points.push(event ?? {});
  }
}

class ThrowingMetrics {
  writeDataPoint(): void {
    throw new Error('analytics engine is unavailable');
  }
}

async function captureLogs(run: () => Promise<void> | void): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((argument) => String(argument)).join(' '));
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines;
}

function metricsEnv(metrics: FakeMetrics) {
  return { PROVISIONING_METRICS: metrics as unknown as AnalyticsEngineDataset };
}

const EVENTS: Array<{ event: ProvisioningEvent; blobs: string[]; doubles: number[] }> = [
  {
    event: { type: 'consent_started', jobId: 'job-1', ts: 1_000, provider: 'notion' },
    blobs: ['consent_started', 'job-1', 'notion'],
    doubles: [1_000],
  },
  {
    event: { type: 'consent_completed', jobId: 'job-1', ts: 1_100, provider: 'notion', templateDuplicated: true },
    blobs: ['consent_completed', 'job-1', 'notion'],
    doubles: [1_100, 1],
  },
  {
    event: { type: 'consent_failed', jobId: 'job-1', ts: 1_200, provider: 'notion', errorCode: 'notion_rate_limited' },
    blobs: ['consent_failed', 'job-1', 'notion_rate_limited', 'notion'],
    doubles: [1_200],
  },
  {
    event: { type: 'job_queued', jobId: 'job-1', ts: 1_300 },
    blobs: ['job_queued', 'job-1'],
    doubles: [1_300],
  },
  {
    event: { type: 'job_enqueue_failed', jobId: 'job-1', ts: 1_400, errorCode: 'provisioning_enqueue_failed' },
    blobs: ['job_enqueue_failed', 'job-1', 'provisioning_enqueue_failed'],
    doubles: [1_400],
  },
  {
    event: { type: 'step_started', jobId: 'job-1', ts: 1_500, step: 'configure_pages', attempt: 2 },
    blobs: ['step_started', 'job-1', 'configure_pages'],
    doubles: [1_500, 2],
  },
  {
    event: { type: 'step_succeeded', jobId: 'job-1', ts: 1_600, step: 'configure_pages', attempt: 2, durationMs: 350 },
    blobs: ['step_succeeded', 'job-1', 'configure_pages'],
    doubles: [1_600, 2, 350],
  },
  {
    event: {
      type: 'step_failed',
      jobId: 'job-1',
      ts: 1_700,
      step: 'await_sync',
      attempt: 3,
      errorCode: 'github_sync_run_failed',
      retryable: false,
      terminal: true,
      durationMs: 900,
    },
    blobs: ['step_failed', 'job-1', 'await_sync', 'github_sync_run_failed'],
    doubles: [1_700, 3, 900, 0, 1],
  },
  {
    event: {
      type: 'rate_limited',
      jobId: 'job-1',
      ts: 1_800,
      step: 'dispatch_sync',
      errorCode: 'github_sync_rate_limited',
      retryAfterSeconds: 42,
    },
    blobs: ['rate_limited', 'job-1', 'dispatch_sync', 'github_sync_rate_limited'],
    doubles: [1_800, 42],
  },
  {
    event: { type: 'job_succeeded', jobId: 'job-1', ts: 1_900, totalDurationMs: 120_000 },
    blobs: ['job_succeeded', 'job-1'],
    doubles: [1_900, 120_000],
  },
  {
    event: {
      type: 'job_dead_lettered',
      jobId: 'job-1',
      ts: 2_000,
      step: 'verify_deploy',
      errorCode: 'github_deploy_url_unreachable',
      totalDurationMs: 240_000,
    },
    blobs: ['job_dead_lettered', 'job-1', 'verify_deploy', 'github_deploy_url_unreachable'],
    doubles: [2_000, 240_000],
  },
  {
    event: { type: 'status_rerun_dispatched', requestLabel: 'request-label-1', ts: 2_100 },
    blobs: ['status_rerun_dispatched', 'request-label-1'],
    doubles: [2_100],
  },
];

class MemoryKV {
  private values = new Map<string, string>();
  private failNextPuts = new Set<number>();
  private putError: unknown = null;
  private putCount = 0;

  failPutNumber(ordinal: number, error: unknown): void {
    this.failNextPuts.add(ordinal);
    this.putError = error;
  }

  async get<T>(key: string, type?: string): Promise<T | string | null> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) as T : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.putCount += 1;
    if (this.failNextPuts.has(this.putCount)) throw this.putError;
    this.values.set(key, value);
  }
}

class MemoryQueue<T> {
  readonly sent: T[] = [];

  async send(message: T): Promise<void> {
    this.sent.push(message);
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

function canaryJob(attempts = 0): ProvisioningJob {
  const job = createProvisioningJob({
    jobId: 'job-canary',
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
      headSha: 'generated-head-sha',
      headTreeSha: 'generated-tree-sha',
      reused: false,
    },
    now: 1_000,
  });
  job.steps.verify_repository.status = 'succeeded';
  job.steps.patch_config.status = 'succeeded';
  job.steps.configure_pages.attempts = attempts;
  // As the queue sees it: the Notion callback already wrote the secrets.
  return { ...job, status: 'queued', data: { ...job.data, notionSecretsWrittenAt: 900 } };
}

function pagesFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === 'https://api.github.com/app/installations/123/access_tokens') {
      return Response.json({ token: 'installation-token' });
    }
    if (url === 'https://api.github.com/repos/alice/alice.github.io/pages') {
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
}

async function funnelEventsForCaughtError(
  error: unknown,
  attempts: number,
): Promise<{ logs: string[]; points: AnalyticsEngineDataPoint[]; job: ProvisioningJob | null }> {
  const kv = new MemoryKV();
  const metrics = new FakeMetrics();
  await kv.put(provisioningJobKey('job-canary'), JSON.stringify(canaryJob(attempts)));
  // Ordinal 6 is the success save the consumer catches: 1 setup, 2 locked,
  // 3 lease renewal, 4 budget admission, 5 in-progress, 6 success save. A
  // failure there routes through `recordStepFailure`, which is the funnel
  // under test; a later ordinal would escape the consumer uncaught.
  kv.failPutNumber(6, error);

  const env: ProvisioningQueueEnv = {
    JOBS: kv as unknown as KVNamespace,
    PROVISIONING_QUEUE: new MemoryQueue<{ jobId: string }>() as unknown as Queue<{ jobId: string }>,
    PROVISIONING_METRICS: metrics as unknown as AnalyticsEngineDataset,
    GITHUB_APP_ID: '4798518',
    GITHUB_APP_PRIVATE_KEY: await generateThrowawayPrivateKey(),
  };

  const logs = await captureLogs(async () => {
    await processProvisioningMessage('job-canary', env, {
      fetcher: pagesFetch(),
      sleep: async () => {},
      now: () => 5_000,
    });
  });
  return { logs, points: metrics.points, job: await loadProvisioningJob(env.JOBS, 'job-canary') };
}

describe('emitProvisioningEvent', () => {
  test('writes the documented blob, double, and index columns for every event variant', async () => {
    for (const { event, blobs, doubles } of EVENTS) {
      const metrics = new FakeMetrics();
      await captureLogs(() => emitProvisioningEvent(metricsEnv(metrics), event));
      expect(metrics.points).toEqual([{ blobs, doubles, indexes: [event.type] }]);
    }
  });

  test('logs each event as one line of JSON that round-trips to the event itself', async () => {
    for (const { event } of EVENTS) {
      const metrics = new FakeMetrics();
      const logs = await captureLogs(() => emitProvisioningEvent(metricsEnv(metrics), event));
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0] as string)).toEqual(event);
    }
  });

  test('covers every event type in the union exactly once', () => {
    const types = EVENTS.map(({ event }) => event.type);
    expect(new Set(types).size).toBe(types.length);
    expect(types).toContain('job_succeeded');
    expect(types).toContain('status_rerun_dispatched');
    expect(types).toHaveLength(12);
  });

  test('still logs when no metrics dataset is bound', async () => {
    const logs = await captureLogs(() => emitProvisioningEvent({}, EVENTS[0]!.event));
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] as string)).toEqual(EVENTS[0]!.event);
  });

  test('a metrics sink that throws never fails the operation it observes', async () => {
    const env = { PROVISIONING_METRICS: new ThrowingMetrics() as unknown as AnalyticsEngineDataset };
    const logs = await captureLogs(() => emitProvisioningEvent(env, EVENTS[0]!.event));
    expect(logs).toHaveLength(1);
  });
});

describe('redaction canary', () => {
  test('a provider error whose message carries a token never reaches either sink', async () => {
    const rateLimited = new GithubSyncError('github_sync_rate_limited', 429, 30);
    rateLimited.message = `dispatch rejected for installation token ${CANARY}`;
    const { logs, points, job } = await funnelEventsForCaughtError(rateLimited, 0);

    expect(logs.join('\n')).not.toContain(CANARY);
    expect(JSON.stringify(points)).not.toContain(CANARY);
    expect(JSON.stringify(job)).not.toContain(CANARY);

    const types = logs.map((line) => JSON.parse(line).type);
    expect(types).toEqual(['step_started', 'step_failed', 'rate_limited']);
    expect(JSON.parse(logs[1] as string).errorCode).toBe('github_sync_rate_limited');
  });

  test('an unclassified error whose message carries a token dead-letters without leaking it', async () => {
    const raw = new Error(`upstream refused: Authorization: Bearer ${CANARY}`);
    const { logs, points, job } = await funnelEventsForCaughtError(raw, PROVISIONING_STEP_MAX_ATTEMPTS - 1);

    expect(logs.join('\n')).not.toContain(CANARY);
    expect(JSON.stringify(points)).not.toContain(CANARY);
    expect(JSON.stringify(job)).not.toContain(CANARY);

    const types = logs.map((line) => JSON.parse(line).type);
    expect(types).toEqual(['step_started', 'step_failed', 'job_dead_lettered']);
    expect(JSON.parse(logs[1] as string).errorCode).toBe('provisioning_step_failed');
    expect(job?.status).toBe('dead_letter');
  });

  test('every emitted field name is drawn from the schema allowlist', async () => {
    const raw = new Error(`upstream refused: Authorization: Bearer ${CANARY}`);
    const { logs } = await funnelEventsForCaughtError(raw, 0);
    const allowed = new Set([
      'type', 'jobId', 'ts', 'provider', 'templateDuplicated', 'errorCode', 'step',
      'attempt', 'durationMs', 'retryable', 'terminal', 'retryAfterSeconds', 'totalDurationMs',
    ]);
    for (const line of logs) {
      for (const field of Object.keys(JSON.parse(line))) {
        expect(allowed.has(field)).toBe(true);
      }
    }
  });
});
