/**
 * Global content-creation throttle and per-GitHub-account provisioning quota.
 *
 * Two limits guard GitHub's app-wide secondary rate limits (~80 mutations per
 * minute, ~500 per hour) without a Durable Object:
 *
 * - One account lease per numeric account id (`github:account-lease:<id>`).
 *   The lease IS the per-account quota: capacity one, which is exactly what
 *   the product can consume — every attempt converges on the same
 *   reuse-biased destination repository, so spaced-out concurrent
 *   provisionings against one account gain nothing and a replayed callback
 *   is refused instead of re-mutating GitHub.
 * - One global fixed-window counter pair in a single key
 *   (`github:rate:global`), consumed only by real content-creating calls:
 *   the sync-path generate POST and the queue's `patch_config`,
 *   `configure_pages`, and `dispatch_sync` steps. Reads and polls never
 *   consume budget.
 *
 * Workers KV has no compare-and-swap and is eventually consistent across
 * locations, so neither limit is globally exact. Within one isolate, the
 * counter's read-modify-write is serialized by a per-key promise-chain mutex
 * (`withKeyLock`), which makes budget admission exact — and therefore
 * deterministic in tests. Across isolates, each racer can over-admit by at
 * most one stale read per window: at most `MAX_RACING_ISOLATES - 1` extra
 * admissions per window, absorbed by the configured headroom under GitHub's
 * ceilings (see the static headroom test). A corrupted counter fails closed:
 * refusing a mutation that might have been admitted only delays
 * provisioning, while admitting on an unreadable count could exceed GitHub's
 * limits, and the state's TTL bounds the outage.
 *
 * Lease lifecycle invariants:
 * - L1 At most one lease value per account id; it names the only jobId
 *   allowed to provision for that account.
 * - L2 A live lease is renewed only by its owner (queue gate, every step)
 *   and released only on its owner's terminal transition. A different jobId
 *   that finds it live never steals it: that job terminal-fails superseded.
 * - L3 Wedge recovery is TTL plus contenders: a wedged job stops renewing;
 *   within `leaseTtlSeconds` the lease expires; the next sync-path contender
 *   breaks a lease whose named job record is missing or terminal. No cron
 *   exists; the next contender is always the breaker.
 * - L4 KV staleness can only make a lease look missing or older, never
 *   change its jobId: ownership comparison is stale-safe, and the one
 *   stale-sensitive predicate (expiry) errs conservative — same-job reclaim,
 *   other-job refused or superseded.
 * - L5 The sync path hands the lease to the job it enqueues; if no job is
 *   durably created and enqueued, the request releases it before returning.
 * - L6 Acquire is write-then-read-back verify. KV reads may serve a pre-write
 *   cache, so the only proof of ownership is reading our own jobId back. A
 *   loser never deletes: the winner owns the lease now. Any residual
 *   double-winner is contained at the first queue gate pass by L2.
 *
 * Identity containment: every key and value below carries the numeric
 * account id and/or the jobId — never a login, token, or OAuth code.
 */

import {
  isTerminalProvisioningStatus,
  loadProvisioningJob,
  PROVISIONING_STEP_ORDER,
  saveProvisioningJob,
  type ProvisioningJob,
  type ProvisioningStepName,
} from './provisioning-job';

export interface ProvisioningThrottleVars {
  PROVISIONING_MUTATIONS_PER_MINUTE?: string;
  PROVISIONING_MUTATIONS_PER_HOUR?: string;
  PROVISIONING_LEASE_TTL_SECONDS?: string;
}

export interface ProvisioningThrottleConfig {
  /** Global content-creating mutations admitted per fixed minute window. */
  readonly mutationsPerMinute: number;
  /** Global content-creating mutations admitted per fixed hour window. */
  readonly mutationsPerHour: number;
  /** Lease TTL; renewed at every queue step. Bounded below by KV's 60s
   * minimum expirationTtl and above by the longest `await_sync`-class poll. */
  readonly leaseTtlSeconds: number;
}

export const PROVISIONING_MUTATIONS_PER_MINUTE_DEFAULT = 30;
export const PROVISIONING_MUTATIONS_PER_MINUTE_CEILING = 60;
export const PROVISIONING_MUTATIONS_PER_HOUR_DEFAULT = 240;
export const PROVISIONING_MUTATIONS_PER_HOUR_CEILING = 400;
export const PROVISIONING_LEASE_TTL_DEFAULT_SECONDS = 1800;
export const PROVISIONING_LEASE_TTL_MIN_SECONDS = 60;
export const PROVISIONING_LEASE_TTL_MAX_SECONDS = 86400;

/** Isolates the over-admission bound assumes. Each racing isolate can commit
 * at most one admission per window that the others never saw, so the
 * worst-case observed rate is budget + MAX_RACING_ISOLATES - 1. */
export const MAX_RACING_ISOLATES = 32;

function parsePositiveInteger(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    // The variable name rides as a field, not in the message: every Error
    // message in src/ stays a constant string so platform logs stay
    // credential-free even when serialized verbatim.
    const failure = new Error('invalid provisioning throttle configuration value') as Error & { variable: string };
    failure.variable = name;
    throw failure;
  }
  return value;
}

/**
 * Parse, default, and clamp. A present-but-invalid value throws (a typo
 * should fail visibly, not silently halve the limits); a valid value beyond
 * a ceiling clamps (misconfiguration must not be able to exceed GitHub's
 * limits).
 */
export function provisioningThrottleConfig(vars: ProvisioningThrottleVars): ProvisioningThrottleConfig {
  const perMinute = parsePositiveInteger(vars.PROVISIONING_MUTATIONS_PER_MINUTE, 'PROVISIONING_MUTATIONS_PER_MINUTE');
  const perHour = parsePositiveInteger(vars.PROVISIONING_MUTATIONS_PER_HOUR, 'PROVISIONING_MUTATIONS_PER_HOUR');
  const leaseTtl = parsePositiveInteger(vars.PROVISIONING_LEASE_TTL_SECONDS, 'PROVISIONING_LEASE_TTL_SECONDS');
  return {
    mutationsPerMinute: Math.min(perMinute ?? PROVISIONING_MUTATIONS_PER_MINUTE_DEFAULT, PROVISIONING_MUTATIONS_PER_MINUTE_CEILING),
    mutationsPerHour: Math.min(perHour ?? PROVISIONING_MUTATIONS_PER_HOUR_DEFAULT, PROVISIONING_MUTATIONS_PER_HOUR_CEILING),
    leaseTtlSeconds: Math.min(
      Math.max(leaseTtl ?? PROVISIONING_LEASE_TTL_DEFAULT_SECONDS, PROVISIONING_LEASE_TTL_MIN_SECONDS),
      PROVISIONING_LEASE_TTL_MAX_SECONDS,
    ),
  };
}

export const ACCOUNT_LEASE_PREFIX = 'github:account-lease:';
export const GLOBAL_RATE_KEY = 'github:rate:global';
const GLOBAL_RATE_TTL_SECONDS = 2 * 60 * 60;
const BUDGET_RETRY_MARGIN_SECONDS = 5;

/** Value of `github:account-lease:<accountId>`. jobId — not login, not token. */
export interface AccountLease {
  version: 1;
  /** The single job allowed to provision for this account while the lease lives. */
  jobId: string;
  /** Epoch ms after which the lease is reclaimable. Mirrors the KV expirationTtl. */
  expiresAt: number;
}

/** Both counters in ONE key: one read plus one write per check. Fixed windows. */
export interface GlobalRateState {
  version: 1;
  minuteBucket: number;
  minuteCount: number;
  hourBucket: number;
  hourCount: number;
}

export function accountLeaseKey(accountId: number): string {
  return `${ACCOUNT_LEASE_PREFIX}${accountId}`;
}

function minuteBucketOf(nowMs: number): number {
  return Math.floor(nowMs / 60_000);
}

function hourBucketOf(nowMs: number): number {
  return Math.floor(nowMs / 3_600_000);
}

function freshGlobalRateState(nowMs: number): GlobalRateState {
  return {
    version: 1,
    minuteBucket: minuteBucketOf(nowMs),
    hourBucket: hourBucketOf(nowMs),
    minuteCount: 0,
    hourCount: 0,
  };
}

/**
 * Normalize a stored counter for `nowMs`, or report it corrupted. An absent
 * counter is a fresh zero state. Counts stamped for any other bucket are
 * stale by definition — including buckets stamped in the future by a skewed
 * writer — and roll to zero. Anything unreadable as a versioned counter
 * fails closed at the caller.
 */
function rolledGlobalRateState(value: unknown, nowMs: number): GlobalRateState | 'corrupted' {
  if (value === null || value === undefined) return freshGlobalRateState(nowMs);
  if (typeof value !== 'object') return 'corrupted';
  const state = value as Record<string, unknown>;
  if (
    state.version !== 1 ||
    !Number.isSafeInteger(state.minuteBucket) ||
    !Number.isSafeInteger(state.minuteCount) ||
    !Number.isSafeInteger(state.hourBucket) ||
    !Number.isSafeInteger(state.hourCount) ||
    (state.minuteCount as number) < 0 ||
    (state.hourCount as number) < 0
  ) {
    return 'corrupted';
  }
  return {
    version: 1,
    minuteBucket: minuteBucketOf(nowMs),
    hourBucket: hourBucketOf(nowMs),
    minuteCount: state.minuteBucket === minuteBucketOf(nowMs) ? (state.minuteCount as number) : 0,
    hourCount: state.hourBucket === hourBucketOf(nowMs) ? (state.hourCount as number) : 0,
  };
}

/** Seconds until the binding window rolls, or null when neither is full.
 * The next hour boundary is always at or after the next minute boundary, so
 * the later of the two covers both. */
function secondsUntilBudgetReleases(state: GlobalRateState, config: ProvisioningThrottleConfig, nowMs: number): number | null {
  const minuteFull = state.minuteCount >= config.mutationsPerMinute;
  const hourFull = state.hourCount >= config.mutationsPerHour;
  if (!minuteFull && !hourFull) return null;
  let seconds = 60 - (nowMs % 60_000) / 1000;
  if (hourFull) seconds = Math.max(seconds, 3600 - (nowMs % 3_600_000) / 1000);
  return seconds;
}

const keyLocks = new Map<string, Promise<unknown>>();

/**
 * Serialize a critical section per key within one Worker isolate.
 *
 * All read-modify-write sequences for one key are mutually exclusive inside
 * an isolate, so concurrent budget admissions in a single isolate can never
 * lose an increment — the property the deterministic concurrent tests pin.
 * The residual race is cross-isolate only (KV eventual consistency) and is
 * bounded by budget headroom, never claimed away.
 */
function withKeyLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  // A rejected predecessor must not poison the chain: work runs either way.
  const previous = keyLocks.get(key) ?? Promise.resolve();
  const result = previous.then(work, work);
  const tail = result.catch(() => undefined);
  keyLocks.set(key, tail);
  void tail.then(() => {
    if (keyLocks.get(key) === tail) keyLocks.delete(key);
  });
  return result;
}

// ============================================================================
// Global budget (shared by the sync path's beforeCreate and the queue gate;
// one budget for every content-creating call, GitHub's secondary limits are
// app-wide and the product has one tenant class)
// ============================================================================

export type BudgetDecision =
  | { admitted: true }
  | { admitted: false; reason: 'global_throttled'; delaySeconds: number };

/**
 * Consume one global mutation. Admit rolls the fixed windows, increments
 * both counters, and writes the state BEFORE the caller performs its GitHub
 * call — a crash in between over-counts, the conservative direction. There
 * is no decrement or refund path anywhere: the counter can overcount
 * (under-admit) but never undercount.
 *
 * The refusal is pure: it writes nothing and points at the next window
 * boundary plus a small margin (so a resumed job does not wake exactly on
 * the boundary against every other gated job), jittered, floored at 1s,
 * capped at the 3600s Queues delay limit.
 */
export async function consumeGlobalMutationBudget(
  kv: KVNamespace,
  config: ProvisioningThrottleConfig,
  nowMs: number,
  rng: () => number,
): Promise<BudgetDecision> {
  return withKeyLock(GLOBAL_RATE_KEY, async () => {
    let state: GlobalRateState | 'corrupted';
    try {
      state = rolledGlobalRateState(await kv.get(GLOBAL_RATE_KEY, 'json'), nowMs);
    } catch {
      state = 'corrupted';
    }
    if (state === 'corrupted') {
      // Fail closed; the 2h TTL bounds the outage.
      return { admitted: false, reason: 'global_throttled', delaySeconds: jitteredDelaySeconds(60, rng) };
    }
    const untilRelease = secondsUntilBudgetReleases(state, config, nowMs);
    if (untilRelease !== null) {
      return {
        admitted: false,
        reason: 'global_throttled',
        delaySeconds: jitteredDelaySeconds(untilRelease + BUDGET_RETRY_MARGIN_SECONDS, rng),
      };
    }
    const updated: GlobalRateState = {
      ...freshGlobalRateState(nowMs),
      minuteCount: state.minuteCount + 1,
      hourCount: state.hourCount + 1,
    };
    await kv.put(GLOBAL_RATE_KEY, JSON.stringify(updated), { expirationTtl: GLOBAL_RATE_TTL_SECONDS });
    return { admitted: true };
  });
}

export type StartGateDecision =
  | { granted: true }
  | { granted: false; reason: 'global_throttled' | 'account_busy'; retryAfterSeconds: number };

/**
 * Anti-replay plus per-account quota, refusing BEFORE any further token
 * spend. Refusals ahead of the acquire are read-only: no writes, no state
 * change. The global budget is deliberately NOT consumed here — it is
 * consumed per real generate POST by `beforeCreate`, so a callback that
 * reuses an existing repository spends zero global budget.
 */
export async function acquireProvisioningStart(
  kv: KVNamespace,
  params: { accountId: number; jobId: string },
  config: ProvisioningThrottleConfig,
  nowMs: number,
): Promise<StartGateDecision> {
  const rate = rolledGlobalRateState(await kv.get(GLOBAL_RATE_KEY, 'json'), nowMs);
  if (rate !== 'corrupted') {
    const untilRelease = secondsUntilBudgetReleases(rate, config, nowMs);
    if (untilRelease !== null) {
      return {
        granted: false,
        reason: 'global_throttled',
        retryAfterSeconds: Math.max(Math.ceil(untilRelease), 1),
      };
    }
  }

  const leaseKey = accountLeaseKey(params.accountId);
  const lease = await kv.get<AccountLease>(leaseKey, 'json');
  if (lease && lease.version === 1 && lease.expiresAt > nowMs && lease.jobId !== params.jobId) {
    // L3: the lease names the only job allowed to provision, and the job
    // record is authoritative. A lease naming a missing or terminal job is a
    // wedged leftover; with no cron, this contender is its breaker.
    const namedJob = await loadProvisioningJob(kv, lease.jobId);
    if (namedJob && !isTerminalProvisioningStatus(namedJob.status)) {
      return {
        granted: false,
        reason: 'account_busy',
        retryAfterSeconds: Math.max(Math.ceil((lease.expiresAt - nowMs) / 1000), 1),
      };
    }
    await kv.delete(leaseKey);
  }

  // Acquire/renew, then verify by reading back (L6). The read-back failing
  // means a concurrent winner owns the lease now — never delete it.
  const renewed: AccountLease = { version: 1, jobId: params.jobId, expiresAt: nowMs + config.leaseTtlSeconds * 1000 };
  await kv.put(leaseKey, JSON.stringify(renewed), { expirationTtl: config.leaseTtlSeconds });
  const readBack = await kv.get<AccountLease>(leaseKey, 'json');
  if (!readBack || readBack.jobId !== params.jobId) {
    return { granted: false, reason: 'account_busy', retryAfterSeconds: config.leaseTtlSeconds };
  }
  return { granted: true };
}

/**
 * Release-if-owned: get, compare jobId, delete. The value check is what
 * makes a stale or superseded writer unable to delete a successor's lease
 * (L2, L4). Best-effort at every call site: a failed release only costs a
 * TTL-bounded lockout.
 */
export async function releaseProvisioningLeaseIfOwned(kv: KVNamespace, accountId: number, jobId: string): Promise<void> {
  try {
    const leaseKey = accountLeaseKey(accountId);
    const lease = await kv.get<AccountLease>(leaseKey, 'json');
    if (!lease || lease.jobId !== jobId) return;
    await kv.delete(leaseKey);
  } catch {
  }
}

/**
 * Single place for the terminal ⇒ release invariant (L2): persist the
 * terminal record — with any wait breadcrumb dropped, a breadcrumb can never
 * outlive the stall it describes — then release this job's account lease if
 * it still owns it. Used by every terminal writer.
 */
export async function saveTerminalProvisioningJob(env: { JOBS: KVNamespace }, job: ProvisioningJob): Promise<void> {
  await saveProvisioningJob(env.JOBS, { ...job, wait: null });
  await releaseProvisioningLeaseIfOwned(env.JOBS, job.identity.id, job.jobId);
}

// ============================================================================
// Queue-step gate (call site: processProvisioningMessage, after
// nextPendingStep, before the installation-token mint)
// ============================================================================

/**
 * The `PROVISIONING_STEP_ORDER` names that create or change content on
 * GitHub and therefore consume global budget. The set is typed against the
 * step-name union derived from `PROVISIONING_STEP_ORDER`, so renaming a step
 * fails typecheck; a newly added step defaults to non-budgeted and must be
 * classified here deliberately. `verify_repository`, `await_sync`,
 * `await_deploy_build`, and `verify_deploy` are reads and polls: gated for
 * lease renewal, never for budget. `generate` is sync-path-only and never
 * appears in the order.
 */
const BUDGETED_MUTATION_STEPS: ReadonlySet<ProvisioningStepName> = new Set<ProvisioningStepName>([
  'patch_config',
  'configure_pages',
  'dispatch_sync',
]);

export function isBudgetedMutationStep(step: ProvisioningStepName): boolean {
  return BUDGETED_MUTATION_STEPS.has(step);
}

export type StepGateDecision =
  | { action: 'proceed' }
  | { action: 'wait'; reason: 'global_throttled'; delaySeconds: number }
  | { action: 'superseded' };

/**
 * One gate pass = conflict check + lease renewal + (iff budgeted step)
 * budget consumption, run for EVERY step so slow inline poll steps keep
 * renewing their lease. Rules:
 * - foreign live lease ⇒ superseded (L2: never steal — the caller
 *   terminal-fails the job);
 * - own, expired, or absent lease ⇒ (re)claim by writing ours;
 * - budgeted step ⇒ consumeGlobalMutationBudget; a refusal becomes a wait.
 *
 * Caller contract: on 'wait' the queue persists the job queued, unlocked,
 * and carrying the wait breadcrumb with attempts untouched, then hands the
 * continuation to a fresh message — never the platform's retry, whose
 * max_retries budget gate waits must not consume. On 'superseded' the caller
 * saves the terminal record via saveTerminalProvisioningJob and acks.
 */
export async function gateProvisioningStep(
  kv: KVNamespace,
  job: ProvisioningJob,
  step: ProvisioningStepName,
  config: ProvisioningThrottleConfig,
  nowMs: number,
  rng: () => number,
): Promise<StepGateDecision> {
  const leaseKey = accountLeaseKey(job.identity.id);
  const lease = await kv.get<AccountLease>(leaseKey, 'json');
  if (lease && lease.version === 1 && lease.expiresAt > nowMs && lease.jobId !== job.jobId) {
    return { action: 'superseded' };
  }
  // Reclaim or renew. Renewing on every pass is what keeps a job that
  // spends minutes inside one poll step from outliving its own lease.
  const renewed: AccountLease = { version: 1, jobId: job.jobId, expiresAt: nowMs + config.leaseTtlSeconds * 1000 };
  await kv.put(leaseKey, JSON.stringify(renewed), { expirationTtl: config.leaseTtlSeconds });
  if (isBudgetedMutationStep(step)) {
    const budget = await consumeGlobalMutationBudget(kv, config, nowMs, rng);
    if (!budget.admitted) {
      return { action: 'wait', reason: budget.reason, delaySeconds: budget.delaySeconds };
    }
  }
  return { action: 'proceed' };
}

/** Browser-visible refusal; `authError` maps the reason to a body. */
export class ProvisioningGateRefusedError extends Error {
  readonly reason: 'global_throttled' | 'account_busy';
  readonly status: 409 | 429;
  readonly retryAfterSeconds: number;

  constructor(decision: Extract<StartGateDecision, { granted: false }>) {
    super(`provisioning_refused_${decision.reason}`);
    this.name = 'ProvisioningGateRefusedError';
    this.reason = decision.reason;
    this.status = decision.reason === 'account_busy' ? 409 : 429;
    this.retryAfterSeconds = decision.retryAfterSeconds;
  }
}

/**
 * base + U(0, base·fraction), floored at 1 and capped at the 3600s Queues
 * delay limit — a gate refusal can never produce a 0-delay busy loop, and no
 * computed delay can ever exceed what a queue send may carry.
 */
export function jitteredDelaySeconds(baseSeconds: number, rng: () => number, fraction = 0.25): number {
  const jittered = baseSeconds + rng() * baseSeconds * fraction;
  return Math.min(Math.max(Math.floor(jittered), 1), 3600);
}
