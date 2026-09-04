import { describe, expect, test } from 'bun:test';

import {
  createProvisioningJob,
  isTerminalProvisioningStatus,
  loadProvisioningJob,
  nextPendingStep,
  provisioningJobKey,
  provisioningRetryDelaySeconds,
  saveProvisioningJob,
  tryAcquireProvisioningLock,
  PROVISIONING_JOB_TTL_SECONDS,
  PROVISIONING_JOB_VERSION,
  PROVISIONING_LOCK_TTL_MS,
  PROVISIONING_STEP_ORDER,
  type CreateProvisioningJobParams,
} from '../src/provisioning-job';

class MemoryKV {
  private values = new Map<string, string>();
  private ttls = new Map<string, number>();

  async get<T>(key: string, type?: string): Promise<T | string | null> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) as T : value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.values.set(key, value);
    if (options?.expirationTtl !== undefined) this.ttls.set(key, options.expirationTtl);
  }

  ttlFor(key: string): number | undefined {
    return this.ttls.get(key);
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

function baseParams(overrides: Partial<CreateProvisioningJobParams> = {}): CreateProvisioningJobParams {
  return {
    jobId: 'job-1',
    installationId: 123,
    identity: IDENTITY,
    repository: REPOSITORY,
    generatedRepository: GENERATED_REPOSITORY,
    now: 1_000,
    ...overrides,
  };
}

describe('createProvisioningJob', () => {
  test('starts every step pending with an unlocked job waiting on Notion', () => {
    const job = createProvisioningJob(baseParams());

    expect(job.version).toBe(PROVISIONING_JOB_VERSION);
    expect(job.status).toBe('awaiting_notion');
    expect(job.lock).toBeNull();
    expect(job.completedAt).toBeNull();
    expect(job.createdAt).toBe(1_000);
    expect(job.updatedAt).toBe(1_000);
    expect(PROVISIONING_STEP_ORDER.every((step) => job.steps[step].status === 'pending')).toBe(true);
    expect(PROVISIONING_STEP_ORDER.every((step) => job.steps[step].attempts === 0)).toBe(true);
    expect(PROVISIONING_STEP_ORDER.every((step) => job.steps[step].lastError === null)).toBe(true);
    expect(job.data).toEqual({
      repository: REPOSITORY,
      generatedRepository: GENERATED_REPOSITORY,
      pages: null,
      sync: null,
      syncDispatchMarker: null,
      deployment: null,
      notionSecretsWrittenAt: null,
    });
  });
});

describe('nextPendingStep', () => {
  test('returns the first non-succeeded step in order', () => {
    const job = createProvisioningJob(baseParams());
    expect(nextPendingStep(job)).toBe('verify_repository');

    job.steps.verify_repository.status = 'succeeded';
    job.steps.patch_config.status = 'succeeded';
    expect(nextPendingStep(job)).toBe('configure_pages');
  });

  test('treats in_progress and failed as not yet succeeded', () => {
    const job = createProvisioningJob(baseParams());
    job.steps.verify_repository.status = 'in_progress';
    expect(nextPendingStep(job)).toBe('verify_repository');
    job.steps.verify_repository.status = 'failed';
    expect(nextPendingStep(job)).toBe('verify_repository');
  });

  test('returns null once every step has succeeded', () => {
    const job = createProvisioningJob(baseParams());
    for (const step of PROVISIONING_STEP_ORDER) job.steps[step].status = 'succeeded';
    expect(nextPendingStep(job)).toBeNull();
  });
});

describe('isTerminalProvisioningStatus', () => {
  test.each([
    ['awaiting_notion', false],
    ['queued', false],
    ['running', false],
    ['succeeded', true],
    ['dead_letter', true],
  ] as const)('%s is terminal: %s', (status, terminal) => {
    expect(isTerminalProvisioningStatus(status)).toBe(terminal);
  });
});

describe('provisioningRetryDelaySeconds', () => {
  test('doubles from 30s and caps at 15 minutes', () => {
    expect(provisioningRetryDelaySeconds(1)).toBe(30);
    expect(provisioningRetryDelaySeconds(2)).toBe(60);
    expect(provisioningRetryDelaySeconds(3)).toBe(120);
    expect(provisioningRetryDelaySeconds(4)).toBe(240);
    expect(provisioningRetryDelaySeconds(10)).toBe(900);
    expect(provisioningRetryDelaySeconds(100)).toBe(900);
  });
});

describe('tryAcquireProvisioningLock', () => {
  test('acquires an unlocked job and marks it running', () => {
    const job = createProvisioningJob(baseParams());
    const locked = tryAcquireProvisioningLock(job, 'owner-a', 1_000);
    expect(locked).not.toBeNull();
    expect(locked?.status).toBe('running');
    expect(locked?.lock).toEqual({ owner: 'owner-a', acquiredAt: 1_000, expiresAt: 1_000 + PROVISIONING_LOCK_TTL_MS });
  });

  test('refuses a job whose lock has not expired', () => {
    const job = createProvisioningJob(baseParams());
    const locked = tryAcquireProvisioningLock(job, 'owner-a', 1_000)!;
    const contended = tryAcquireProvisioningLock(locked, 'owner-b', 1_500);
    expect(contended).toBeNull();
  });

  test('reclaims a stale, expired lock for a new owner', () => {
    const job = createProvisioningJob(baseParams());
    const locked = tryAcquireProvisioningLock(job, 'owner-a', 1_000)!;
    const reclaimed = tryAcquireProvisioningLock(locked, 'owner-b', locked.lock!.expiresAt + 1);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.lock?.owner).toBe('owner-b');
  });

  test('acquires again exactly at the expiry instant', () => {
    const job = createProvisioningJob(baseParams());
    const locked = tryAcquireProvisioningLock(job, 'owner-a', 1_000)!;
    const reclaimed = tryAcquireProvisioningLock(locked, 'owner-b', locked.lock!.expiresAt);
    expect(reclaimed).not.toBeNull();
  });
});

describe('KV persistence', () => {
  test('round-trips a job with the project-wide job TTL', async () => {
    const kv = new MemoryKV();
    const job = createProvisioningJob(baseParams());
    await saveProvisioningJob(kv as unknown as KVNamespace, job);

    const loaded = await loadProvisioningJob(kv as unknown as KVNamespace, job.jobId);
    expect(loaded).toEqual(job);
    expect(kv.ttlFor(provisioningJobKey(job.jobId))).toBe(PROVISIONING_JOB_TTL_SECONDS);
  });

  test('returns null for a job that was never persisted', async () => {
    const kv = new MemoryKV();
    expect(await loadProvisioningJob(kv as unknown as KVNamespace, 'missing')).toBeNull();
  });

  test('rejects a record with a mismatched schema version', async () => {
    const kv = new MemoryKV();
    const job = createProvisioningJob(baseParams());
    await kv.put(provisioningJobKey(job.jobId), JSON.stringify({ ...job, version: 2 }));
    expect(await loadProvisioningJob(kv as unknown as KVNamespace, job.jobId)).toBeNull();
  });

  test('normalizes an unrecognized stored failure code to the taxonomy fallback, keeping the recorded retryability', async () => {
    const kv = new MemoryKV();
    const job = createProvisioningJob(baseParams());
    const marked = {
      ...job,
      steps: {
        ...job.steps,
        configure_pages: {
          ...job.steps.configure_pages,
          lastError: { code: 'github_installation_gone', retryable: false },
        },
      },
    };
    await kv.put(provisioningJobKey(job.jobId), JSON.stringify(marked));

    const loaded = await loadProvisioningJob(kv as unknown as KVNamespace, job.jobId);
    expect(loaded?.steps.configure_pages.lastError).toEqual({ code: 'provisioning_step_failed', retryable: false });
    expect(loaded?.steps.verify_repository.lastError).toBeNull();
  });
});
