import { describe, expect, test } from 'bun:test';

import {
  admitProvisioningAccount,
  admitProvisioningCallback,
  admitProvisioningRequest,
  admitProvisioningStage,
  acquireProvisioningStart,
  provisioningAdmissionConfig,
  provisioningCallbackKey,
  provisioningDenialKey,
  recordProvisioningIdentityDenial,
  accountLeaseKey,
  consumeGlobalMutationBudget,
  gateProvisioningStep,
  GLOBAL_RATE_KEY,
  isBudgetedMutationStep,
  jitteredDelaySeconds,
  MAX_RACING_ISOLATES,
  ProvisioningGateRefusedError,
  provisioningThrottleConfig,
  releaseProvisioningLeaseIfOwned,
  saveTerminalProvisioningJob,
  PROVISIONING_LEASE_TTL_MAX_SECONDS,
  PROVISIONING_LEASE_TTL_MIN_SECONDS,
  PROVISIONING_MUTATIONS_PER_HOUR_CEILING,
  PROVISIONING_MUTATIONS_PER_MINUTE_CEILING,
  type AccountLease,
  type GlobalRateState,
} from '../src/provisioning-throttle';
import {
  createProvisioningJob,
  loadProvisioningJob,
  PROVISIONING_STEP_ORDER,
  saveProvisioningJob,
  type ProvisioningJob,
} from '../src/provisioning-job';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** A fixed instant exactly 30s into a minute window. */
const NOW = 1_704_000_000_000 + 30_000;

const minuteBucketOf = (nowMs: number): number => Math.floor(nowMs / MINUTE_MS);
const hourBucketOf = (nowMs: number): number => Math.floor(nowMs / HOUR_MS);

class MemoryKV {
  private values = new Map<string, string>();
  private ttls = new Map<string, number>();
  puts = 0;
  deletes = 0;

  async get<T>(key: string, type?: string): Promise<T | string | null> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) as T : value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.puts += 1;
    this.values.set(key, value);
    if (options?.expirationTtl !== undefined) this.ttls.set(key, options.expirationTtl);
  }

  async delete(key: string): Promise<void> {
    this.deletes += 1;
    this.values.delete(key);
  }

  ttlFor(key: string): number | undefined {
    return this.ttls.get(key);
  }

  rawValue(key: string): string | undefined {
    return this.values.get(key);
  }

  snapshot(): string {
    return JSON.stringify([...this.values.entries()]);
  }
}

/**
 * Simulates one KV propagation artifact: the first `get` after a `put`
 * serves the value from before that put, as a pre-write cache would. Later
 * gets see the current value.
 */
class StaleOnceKV {
  private values = new Map<string, string>();
  private stale = new Map<string, string>();

  async get<T>(key: string, type?: string): Promise<T | string | null> {
    const value = this.stale.get(key) ?? this.values.get(key);
    this.stale.delete(key);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) as T : value;
  }

  async put(key: string, value: string): Promise<void> {
    const previous = this.values.get(key);
    if (previous !== undefined) this.stale.set(key, previous);
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  rawValue(key: string): string | undefined {
    return this.values.get(key);
  }
}

/** Small deterministic linear-congruential generator over [0, 1). */
function seededRng(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const IDENTITY = { id: 42, login: 'alice', accountType: 'User' as const };

function makeJob(jobId = 'job-1'): ProvisioningJob {
  return createProvisioningJob({
    jobId,
    installationId: 123,
    identity: IDENTITY,
    repository: { name: 'alice.github.io', url: 'https://alice.github.io', baseurl: '', kind: 'apex' },
    generatedRepository: {
      id: 1001,
      fullName: 'alice/alice.github.io',
      name: 'alice.github.io',
      htmlUrl: 'https://github.com/alice/alice.github.io',
      defaultBranch: 'main',
      templateFullName: 'inkdrafts/notiongit-template',
      templateHeadSha: null,
      templateHeadTreeSha: null,
      headSha: null,
      headTreeSha: null,
      reused: false,
    },
    now: 1_000,
  });
}

function storedState(kv: MemoryKV): GlobalRateState | null {
  const raw = kv.rawValue(GLOBAL_RATE_KEY);
  return raw ? JSON.parse(raw) as GlobalRateState : null;
}

function storedLease(kv: MemoryKV, accountId = IDENTITY.id): AccountLease | null {
  const raw = kv.rawValue(accountLeaseKey(accountId));
  return raw ? JSON.parse(raw) as AccountLease : null;
}

async function putLease(kv: MemoryKV, jobId: string, expiresAt: number): Promise<void> {
  await kv.put(accountLeaseKey(IDENTITY.id), JSON.stringify({ version: 1, jobId, expiresAt } satisfies AccountLease), { expirationTtl: 1800 });
}

async function saveJob(kv: MemoryKV, job: ProvisioningJob): Promise<void> {
  await saveProvisioningJob(kv as unknown as KVNamespace, job);
}

describe('provisioningThrottleConfig', () => {
  test('defaults to 30/min, 240/hour, and a 30-minute lease', () => {
    expect(provisioningThrottleConfig({})).toEqual({ mutationsPerMinute: 30, mutationsPerHour: 240, leaseTtlSeconds: 1800 });
  });

  test('honors operator values inside the clamped range', () => {
    expect(provisioningThrottleConfig({
      PROVISIONING_MUTATIONS_PER_MINUTE: '10',
      PROVISIONING_MUTATIONS_PER_HOUR: '100',
      PROVISIONING_LEASE_TTL_SECONDS: '3600',
    })).toEqual({ mutationsPerMinute: 10, mutationsPerHour: 100, leaseTtlSeconds: 3600 });
  });

  test('clamps valid values to the hard ceilings and the KV-ttl floor', () => {
    expect(provisioningThrottleConfig({
      PROVISIONING_MUTATIONS_PER_MINUTE: '1000',
      PROVISIONING_MUTATIONS_PER_HOUR: '100000',
      PROVISIONING_LEASE_TTL_SECONDS: '1000000',
    })).toEqual({
      mutationsPerMinute: PROVISIONING_MUTATIONS_PER_MINUTE_CEILING,
      mutationsPerHour: PROVISIONING_MUTATIONS_PER_HOUR_CEILING,
      leaseTtlSeconds: PROVISIONING_LEASE_TTL_MAX_SECONDS,
    });
    expect(provisioningThrottleConfig({ PROVISIONING_LEASE_TTL_SECONDS: '30' }).leaseTtlSeconds)
      .toBe(PROVISIONING_LEASE_TTL_MIN_SECONDS);
  });

  test.each([
    ['not a number', 'abc'],
    ['non-integer', '3.5'],
    ['zero', '0'],
    ['negative', '-5'],
    ['empty', ''],
  ])('%s (present but invalid) throws instead of clamping', (_name, raw) => {
    expect(() => provisioningThrottleConfig({ PROVISIONING_MUTATIONS_PER_MINUTE: raw })).toThrow();
    expect(() => provisioningThrottleConfig({ PROVISIONING_MUTATIONS_PER_HOUR: raw })).toThrow();
    expect(() => provisioningThrottleConfig({ PROVISIONING_LEASE_TTL_SECONDS: raw })).toThrow();
  });
});

describe('provisioning admission controls', () => {
  const admissionEnv = (kv: MemoryKV) => ({ JOBS: kv as unknown as KVNamespace });

  test('kill switch rejects new stages and queue gates before lease or mutation budget writes', async () => {
    const kv = new MemoryKV();
    await kv.put('provisioning:admission:control', JSON.stringify({
      version: 1,
      mode: 'kill',
      pausedStages: [],
      rejectedStages: [],
      updatedAt: NOW,
      expiresAt: null,
    }));
    const config = provisioningAdmissionConfig({});

    const admission = await admitProvisioningStage(admissionEnv(kv), config, {
      stage: 'github_repository',
      jobId: 'job-killed',
    }, NOW);
    expect(admission).toEqual({
      action: 'reject',
      stage: 'github_repository',
      reason: 'global_kill',
      retryAfterSeconds: 60,
    });
    const beforeGate = kv.snapshot();
    const gate = await gateProvisioningStep(kv as unknown as KVNamespace, makeJob('job-killed'), 'patch_config', provisioningThrottleConfig({}), NOW, () => 0, config);
    expect(gate).toEqual({ action: 'pause', reason: 'stage_paused', delaySeconds: 60 });
    expect(kv.rawValue(GLOBAL_RATE_KEY)).toBeUndefined();
    expect(kv.rawValue(accountLeaseKey(IDENTITY.id))).toBeUndefined();
    expect(kv.snapshot()).not.toBe(beforeGate);
  });

  test('callback claims serialize concurrent replays to one winner', async () => {
    const kv = new MemoryKV();
    const config = provisioningAdmissionConfig({});
    const decisions = await Promise.all(Array.from({ length: 32 }, () => admitProvisioningCallback(admissionEnv(kv), config, {
      provider: 'github',
      phase: 'oauth',
      nonce: 'nonce-1',
      jobId: 'job-1',
      stage: 'github_callback',
    }, NOW)));
    expect(decisions.filter((decision) => decision.action === 'allow')).toHaveLength(1);
    expect(decisions.filter((decision) => decision.action === 'reject')).toHaveLength(31);
    expect(kv.rawValue(provisioningCallbackKey('github', 'oauth', 'nonce-1'))).toContain('job-1');
  });

  test('request burst is keyed by an HMAC of the network prefix, never the raw address', async () => {
    const kv = new MemoryKV();
    const config = provisioningAdmissionConfig({
      PROVISIONING_REQUEST_BURST_LIMIT: '2',
    });
    const request = new Request('https://example.com/connect/github', { headers: { 'CF-Connecting-IP': '203.0.113.42' } });
    const first = await admitProvisioningRequest(admissionEnv(kv), config, { request, jobId: 'job-1', hmacSecret: 'test-secret' }, NOW);
    const second = await admitProvisioningRequest(admissionEnv(kv), config, { request, jobId: 'job-2', hmacSecret: 'test-secret' }, NOW + 1);
    const third = await admitProvisioningRequest(admissionEnv(kv), config, { request, jobId: 'job-3', hmacSecret: 'test-secret' }, NOW + 2);
    expect(first.action).toBe('allow');
    expect(second.action).toBe('allow');
    expect(third).toMatchObject({ action: 'reject', reason: 'request_burst' });
    expect(kv.snapshot()).not.toContain('203.0.113.42');
    expect([...JSON.parse(kv.snapshot()) as [string, string][]].some(([key]) => key.startsWith('provisioning:admission:burst:'))).toBe(true);
  });

  test('account attempts and provider denials fail closed before repository generation', async () => {
    const kv = new MemoryKV();
    const config = provisioningAdmissionConfig({ PROVISIONING_ACCOUNT_ATTEMPT_LIMIT: '2' });
    const first = await admitProvisioningAccount(admissionEnv(kv), config, { accountId: 42, jobId: 'job-1' }, NOW);
    const second = await admitProvisioningAccount(admissionEnv(kv), config, { accountId: 42, jobId: 'job-2' }, NOW + 1);
    const third = await admitProvisioningAccount(admissionEnv(kv), config, { accountId: 42, jobId: 'job-3' }, NOW + 2);
    expect(first.action).toBe('allow');
    expect(second.action).toBe('allow');
    expect(third).toMatchObject({ action: 'reject', reason: 'account_attempt_limit' });
    await recordProvisioningIdentityDenial(kv as unknown as KVNamespace, config, { accountId: 42, reason: 'suspended' }, NOW + 3);
    const denied = await admitProvisioningAccount(admissionEnv(kv), config, { accountId: 42, jobId: 'job-4' }, NOW + 4);
    expect(denied).toMatchObject({ action: 'reject', reason: 'identity_denied' });
    expect(kv.rawValue(provisioningDenialKey(42))).toContain('suspended');
  });
});

describe('static headroom', () => {
  test('defaults plus the cross-isolate over-admission bound stay under GitHub ceilings', () => {
    const config = provisioningThrottleConfig({});
    expect(config.mutationsPerMinute + MAX_RACING_ISOLATES - 1).toBeLessThanOrEqual(80);
    expect(config.mutationsPerHour + MAX_RACING_ISOLATES - 1).toBeLessThanOrEqual(500);
  });

  test('the clamp ceilings pin the operator maximum the docs promise', () => {
    expect(PROVISIONING_MUTATIONS_PER_MINUTE_CEILING).toBe(60);
    expect(PROVISIONING_MUTATIONS_PER_HOUR_CEILING).toBe(400);
    expect(PROVISIONING_LEASE_TTL_MAX_SECONDS).toBe(86400);
    expect(PROVISIONING_LEASE_TTL_MIN_SECONDS).toBe(60);
  });
});

describe('consumeGlobalMutationBudget', () => {
  test('admits up to the minute budget, then refuses with a positive delay to the boundary', async () => {
    const kv = new MemoryKV();
    const config = provisioningThrottleConfig({ PROVISIONING_MUTATIONS_PER_MINUTE: '2', PROVISIONING_MUTATIONS_PER_HOUR: '100' });
    const rng = seededRng(7);

    expect(await consumeGlobalMutationBudget(kv, config, NOW, rng)).toEqual({ admitted: true });
    expect(await consumeGlobalMutationBudget(kv, config, NOW, rng)).toEqual({ admitted: true });

    const refused = await consumeGlobalMutationBudget(kv, config, NOW, rng);
    expect(refused.admitted).toBe(false);
    if (!refused.admitted) {
      // 30s to the minute boundary + 5s margin, jittered by at most 25%.
      expect(refused.reason).toBe('global_throttled');
      expect(refused.delaySeconds).toBeGreaterThanOrEqual(35);
      expect(refused.delaySeconds).toBeLessThanOrEqual(Math.ceil(35 * 1.25));
    }
    expect(storedState(kv)?.minuteCount).toBe(2);
    expect(kv.ttlFor(GLOBAL_RATE_KEY)).toBe(2 * 60 * 60);
  });

  test('rollover into the next minute admits a fresh budget', async () => {
    const kv = new MemoryKV();
    const config = provisioningThrottleConfig({ PROVISIONING_MUTATIONS_PER_MINUTE: '1', PROVISIONING_MUTATIONS_PER_HOUR: '100' });
    const rng = seededRng(11);

    expect((await consumeGlobalMutationBudget(kv, config, NOW, rng)).admitted).toBe(true);
    expect((await consumeGlobalMutationBudget(kv, config, NOW + 1, rng)).admitted).toBe(false);
    expect((await consumeGlobalMutationBudget(kv, config, NOW + MINUTE_MS + 1, rng)).admitted).toBe(true);
    expect(storedState(kv)?.minuteBucket).toBe(minuteBucketOf(NOW + MINUTE_MS + 1));
    expect(storedState(kv)?.minuteCount).toBe(1);
  });

  test('the hour budget binds across minute rollovers', async () => {
    const kv = new MemoryKV();
    const config = provisioningThrottleConfig({ PROVISIONING_MUTATIONS_PER_MINUTE: '10', PROVISIONING_MUTATIONS_PER_HOUR: '2' });
    const rng = seededRng(13);

    expect((await consumeGlobalMutationBudget(kv, config, NOW, rng)).admitted).toBe(true);
    expect((await consumeGlobalMutationBudget(kv, config, NOW + MINUTE_MS, rng)).admitted).toBe(true);
    const refused = await consumeGlobalMutationBudget(kv, config, NOW + 2 * MINUTE_MS, rng);
    expect(refused.admitted).toBe(false);
    if (!refused.admitted) {
      // The full hour is the binding window: its boundary is never before
      // the next minute boundary.
      expect(refused.delaySeconds).toBeGreaterThanOrEqual(3600 - ((NOW + 2 * MINUTE_MS) % HOUR_MS) / 1000);
    }
  });

  test('a refusal writes nothing and there is no decrement path', async () => {
    const kv = new MemoryKV();
    const config = provisioningThrottleConfig({ PROVISIONING_MUTATIONS_PER_MINUTE: '1', PROVISIONING_MUTATIONS_PER_HOUR: '100' });
    const rng = seededRng(17);

    await consumeGlobalMutationBudget(kv, config, NOW, rng);
    const before = kv.snapshot();
    const refused = await consumeGlobalMutationBudget(kv, config, NOW, rng);
    expect(refused.admitted).toBe(false);
    expect(kv.snapshot()).toBe(before);
  });

  test('400 concurrent admissions against a budget of 100 admit exactly 100', async () => {
    const kv = new MemoryKV();
    // A literal config, not provisioningThrottleConfig: the clamp would cap
    // the minute budget at 60, and this proof is about the mutex, which
    // must be exact for any budget.
    const config = { mutationsPerMinute: 100, mutationsPerHour: 1000, leaseTtlSeconds: 1800 };
    const rng = seededRng(19);

    const decisions = await Promise.all(
      Array.from({ length: 400 }, () => consumeGlobalMutationBudget(kv, config, NOW, rng)),
    );
    expect(decisions.filter((decision) => decision.admitted)).toHaveLength(100);
    expect(storedState(kv)).toEqual({
      version: 1,
      minuteBucket: minuteBucketOf(NOW),
      hourBucket: hourBucketOf(NOW),
      minuteCount: 100,
      hourCount: 100,
    });
  });

  test('corrupted counter state fails closed instead of admitting', async () => {
    const kv = new MemoryKV();
    const config = provisioningThrottleConfig({ PROVISIONING_MUTATIONS_PER_MINUTE: '10', PROVISIONING_MUTATIONS_PER_HOUR: '100' });
    await kv.put(GLOBAL_RATE_KEY, '{not json', { expirationTtl: 7200 });

    const refused = await consumeGlobalMutationBudget(kv, config, NOW, seededRng(23));
    expect(refused.admitted).toBe(false);
    if (!refused.admitted) expect(refused.delaySeconds).toBeGreaterThanOrEqual(1);
    expect(kv.snapshot()).toBe(JSON.stringify([[GLOBAL_RATE_KEY, '{not json']]));
  });
});

describe('jitteredDelaySeconds', () => {
  test('stays within [base, base·(1+fraction)] under a seeded rng', () => {
    const rng = seededRng(29);
    for (let index = 0; index < 100; index += 1) {
      const delay = jitteredDelaySeconds(100, rng, 0.25);
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThanOrEqual(125);
    }
    expect(jitteredDelaySeconds(100, () => 0, 0.25)).toBe(100);
    expect(jitteredDelaySeconds(100, () => 0.999999, 0.25)).toBe(124);
  });

  test('floors at 1s and caps at the 3600s queue-delay limit', () => {
    expect(jitteredDelaySeconds(0.2, () => 0)).toBe(1);
    expect(jitteredDelaySeconds(100_000, seededRng(31), 0.25)).toBe(3600);
  });
});

describe('acquireProvisioningStart', () => {
  test('grants a fresh start, writes the lease, and renews an own live lease', async () => {
    const kv = new MemoryKV();
    const config = provisioningThrottleConfig({});

    const first = await acquireProvisioningStart(kv, { accountId: IDENTITY.id, jobId: 'job-1' }, config, NOW);
    expect(first).toEqual({ granted: true });
    const lease = storedLease(kv);
    expect(lease).toEqual({ version: 1, jobId: 'job-1', expiresAt: NOW + 1800_000 });
    expect(kv.ttlFor(accountLeaseKey(IDENTITY.id))).toBe(1800);

    const renew = await acquireProvisioningStart(kv, { accountId: IDENTITY.id, jobId: 'job-1' }, config, NOW + 1000);
    expect(renew).toEqual({ granted: true });
    expect(storedLease(kv)?.expiresAt).toBe(NOW + 1000 + 1800_000);
  });

  test('refuses a foreign live lease naming a live non-terminal job, without writing', async () => {
    const kv = new MemoryKV();
    await putLease(kv, 'job-1', NOW + 600_000);
    await saveJob(kv, makeJob('job-1'));
    const config = provisioningThrottleConfig({});

    const before = kv.snapshot();
    const decision = await acquireProvisioningStart(kv, { accountId: IDENTITY.id, jobId: 'job-2' }, config, NOW);
    expect(decision).toEqual({
      granted: false,
      reason: 'account_busy',
      retryAfterSeconds: 600,
      activeJobId: 'job-1',
    });
    expect(kv.snapshot()).toBe(before);
  });

  test('reclaims an expired own lease', async () => {
    const kv = new MemoryKV();
    await putLease(kv, 'job-1', NOW - 1);
    const decision = await acquireProvisioningStart(kv, { accountId: IDENTITY.id, jobId: 'job-1' }, provisioningThrottleConfig({}), NOW);
    expect(decision).toEqual({ granted: true });
    expect(storedLease(kv)?.expiresAt).toBe(NOW + 1800_000);
  });

  test('breaks a live lease whose named job record is missing', async () => {
    const kv = new MemoryKV();
    await putLease(kv, 'job-1', NOW + 600_000);
    const decision = await acquireProvisioningStart(kv, { accountId: IDENTITY.id, jobId: 'job-2' }, provisioningThrottleConfig({}), NOW);
    expect(decision).toEqual({ granted: true });
    expect(storedLease(kv)?.jobId).toBe('job-2');
  });

  test('breaks a live lease whose named job is terminal', async () => {
    const kv = new MemoryKV();
    await putLease(kv, 'job-1', NOW + 600_000);
    await saveJob(kv, { ...makeJob('job-1'), status: 'succeeded', completedAt: 1_000 });
    const decision = await acquireProvisioningStart(kv, { accountId: IDENTITY.id, jobId: 'job-2' }, provisioningThrottleConfig({}), NOW);
    expect(decision).toEqual({ granted: true });
    expect(storedLease(kv)?.jobId).toBe('job-2');
  });

  test('refuses when the global budget is exhausted, without writing', async () => {
    const kv = new MemoryKV();
    await kv.put(GLOBAL_RATE_KEY, JSON.stringify({
      version: 1,
      minuteBucket: minuteBucketOf(NOW),
      hourBucket: hourBucketOf(NOW),
      minuteCount: 30,
      hourCount: 100,
    }), { expirationTtl: 7200 });
    const config = provisioningThrottleConfig({});

    const before = kv.snapshot();
    const decision = await acquireProvisioningStart(kv, { accountId: IDENTITY.id, jobId: 'job-1' }, config, NOW);
    expect(decision.granted).toBe(false);
    if (!decision.granted) {
      expect(decision.reason).toBe('global_throttled');
      // Only the minute window is full: exactly the seconds to its boundary.
      expect(decision.retryAfterSeconds).toBe(30);
    }
    expect(kv.snapshot()).toBe(before);
  });

  test('concurrent acquires converge on one durable lease and losers never delete it', async () => {
    const kv = new MemoryKV();
    const config = provisioningThrottleConfig({});

    const decisions = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        acquireProvisioningStart(kv, { accountId: IDENTITY.id, jobId: `job-${index}` }, config, NOW)),
    );
    const granted = decisions.filter((decision) => decision.granted);
    expect(granted.length).toBeGreaterThanOrEqual(1);
    for (const decision of decisions) {
      if (!decision.granted) {
        expect(decision.reason).toBe('account_busy');
        expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        expect(decision.activeJobId).not.toBeNull();
      }
    }
    const lease = storedLease(kv);
    expect(lease).not.toBeNull();
    // The surviving lease names the contender that read its own jobId back —
    // the durable owner.
    const survivorIndex = Number(lease!.jobId.replace('job-', ''));
    expect(decisions[survivorIndex].granted).toBe(true);
  });

  test('a stale read-back rejects a loser without deleting the lease (L6)', async () => {
    const kv = new StaleOnceKV();
    const config = provisioningThrottleConfig({});
    await kv.put(accountLeaseKey(IDENTITY.id), JSON.stringify({ version: 1, jobId: 'job-1', expiresAt: NOW - 1 } satisfies AccountLease));

    // job-2 sees the expired lease, puts its own, but its read-back serves
    // the pre-write snapshot: it must refuse and leave the key in place.
    const decision = await acquireProvisioningStart(kv as unknown as KVNamespace, { accountId: IDENTITY.id, jobId: 'job-2' }, config, NOW);
    expect(decision).toEqual({
      granted: false,
      reason: 'account_busy',
      retryAfterSeconds: config.leaseTtlSeconds,
      activeJobId: 'job-1',
    });
    expect(kv.rawValue(accountLeaseKey(IDENTITY.id))).not.toBeUndefined();
  });
});

describe('releaseProvisioningLeaseIfOwned', () => {
  test('deletes only a lease this job owns', async () => {
    const kv = new MemoryKV();
    await putLease(kv, 'job-1', NOW + 600_000);

    await releaseProvisioningLeaseIfOwned(kv as unknown as KVNamespace, IDENTITY.id, 'job-2');
    expect(storedLease(kv)?.jobId).toBe('job-1');

    await releaseProvisioningLeaseIfOwned(kv as unknown as KVNamespace, IDENTITY.id, 'job-1');
    expect(storedLease(kv)).toBeNull();
  });

  test('swallows KV failures instead of failing the caller', async () => {
    const throwingKv = {
      get: async () => { throw new Error('kv outage'); },
    } as unknown as KVNamespace;
    await expect(releaseProvisioningLeaseIfOwned(throwingKv, IDENTITY.id, 'job-1')).resolves.toBeUndefined();
  });
});

describe('saveTerminalProvisioningJob', () => {
  test('persists the terminal record, drops the wait breadcrumb, and frees the owned lease', async () => {
    const kv = new MemoryKV();
    await putLease(kv, 'job-1', NOW + 600_000);
    const job: ProvisioningJob = {
      ...makeJob('job-1'),
      status: 'failed',
      completedAt: NOW,
      wait: { reason: 'global_throttled', untilMs: NOW + 1000, updatedAt: NOW },
    };

    await saveTerminalProvisioningJob({ JOBS: kv as unknown as KVNamespace }, job);

    const stored = await loadProvisioningJob(kv as unknown as KVNamespace, 'job-1');
    expect(stored?.status).toBe('failed');
    expect(stored?.wait).toBeNull();
    expect(storedLease(kv)).toBeNull();
  });

  test('never deletes a successor\'s lease', async () => {
    const kv = new MemoryKV();
    await putLease(kv, 'job-2', NOW + 600_000);

    await saveTerminalProvisioningJob({ JOBS: kv as unknown as KVNamespace }, { ...makeJob('job-1'), status: 'failed', completedAt: NOW });

    expect(storedLease(kv)?.jobId).toBe('job-2');
  });
});

describe('gateProvisioningStep', () => {
  test('a read step renews the lease without consuming budget', async () => {
    const kv = new MemoryKV();
    await putLease(kv, 'job-1', NOW + 1000);
    const config = provisioningThrottleConfig({});

    const decision = await gateProvisioningStep(kv as unknown as KVNamespace, makeJob('job-1'), 'await_sync', config, NOW, seededRng(37));

    expect(decision).toEqual({ action: 'proceed' });
    expect(storedLease(kv)?.expiresAt).toBe(NOW + 1800_000);
    expect(storedState(kv)).toBeNull();
  });

  test('a budgeted mutation step consumes exactly one global mutation', async () => {
    const kv = new MemoryKV();
    const config = provisioningThrottleConfig({});

    const decision = await gateProvisioningStep(kv as unknown as KVNamespace, makeJob('job-1'), 'configure_pages', config, NOW, seededRng(41));

    expect(decision).toEqual({ action: 'proceed' });
    expect(storedState(kv)?.minuteCount).toBe(1);
    expect(storedLease(kv)?.jobId).toBe('job-1');
  });

  test('an exhausted budget turns a mutation step into a wait and writes no counter', async () => {
    const kv = new MemoryKV();
    await putLease(kv, 'job-1', NOW + 600_000);
    await kv.put(GLOBAL_RATE_KEY, JSON.stringify({
      version: 1,
      minuteBucket: minuteBucketOf(NOW),
      hourBucket: hourBucketOf(NOW),
      minuteCount: 60,
      hourCount: 400,
    }), { expirationTtl: 7200 });

    const decision = await gateProvisioningStep(
      kv as unknown as KVNamespace,
      makeJob('job-1'),
      'patch_config',
      provisioningThrottleConfig({}),
      NOW,
      seededRng(43),
    );

    expect(decision.action).toBe('wait');
    if (decision.action === 'wait') {
      expect(decision.reason).toBe('global_throttled');
      expect(decision.delaySeconds).toBeGreaterThanOrEqual(1);
      expect(decision.delaySeconds).toBeLessThanOrEqual(3600);
    }
    // The lease was still renewed — only the budget refusal stops the step.
    expect(storedLease(kv)?.expiresAt).toBe(NOW + 1800_000);
  });

  test('a foreign live lease supersedes the step without consuming budget', async () => {
    const kv = new MemoryKV();
    await putLease(kv, 'job-0', NOW + 600_000);

    const decision = await gateProvisioningStep(
      kv as unknown as KVNamespace,
      makeJob('job-1'),
      'dispatch_sync',
      provisioningThrottleConfig({}),
      NOW,
      seededRng(47),
    );

    expect(decision).toEqual({ action: 'superseded' });
    expect(storedLease(kv)?.jobId).toBe('job-0');
    expect(storedState(kv)).toBeNull();
  });

  test('reclaims an expired own lease and proceeds', async () => {
    const kv = new MemoryKV();
    await putLease(kv, 'job-1', NOW - 1);

    const decision = await gateProvisioningStep(
      kv as unknown as KVNamespace,
      makeJob('job-1'),
      'verify_repository',
      provisioningThrottleConfig({}),
      NOW,
      seededRng(53),
    );

    expect(decision).toEqual({ action: 'proceed' });
    expect(storedLease(kv)?.expiresAt).toBe(NOW + 1800_000);
  });
});

describe('isBudgetedMutationStep', () => {
  test('consumes budget exactly for patch_config, configure_pages, and dispatch_sync', () => {
    const budgeted = PROVISIONING_STEP_ORDER.filter(isBudgetedMutationStep);
    expect(budgeted).toEqual(['patch_config', 'configure_pages', 'dispatch_sync']);
  });
});

describe('ProvisioningGateRefusedError', () => {
  test('maps account_busy to 409 and global_throttled to 429', () => {
    const busy = new ProvisioningGateRefusedError({
      granted: false,
      reason: 'account_busy',
      retryAfterSeconds: 120,
      activeJobId: 'job-9',
    });
    expect(busy.status).toBe(409);
    expect(busy.reason).toBe('account_busy');
    expect(busy.retryAfterSeconds).toBe(120);
    expect(busy.activeJobId).toBe('job-9');

    const throttled = new ProvisioningGateRefusedError({ granted: false, reason: 'global_throttled', retryAfterSeconds: 30 });
    expect(throttled.status).toBe(429);
    expect(throttled.retryAfterSeconds).toBe(30);
    expect(throttled.activeJobId).toBeNull();
  });
});
