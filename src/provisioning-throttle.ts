/**
 * Provisioning admission controls, content-creation throttle, and per-account quota.
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
  saveProvisioningJob,
  type ProvisioningJob,
  type ProvisioningStepName,
} from './provisioning-job';
import type { ProvisioningFailureCode } from './failures';

export const PROVISIONING_ADMISSION_STAGES = [
  'github_connect',
  'github_callback',
  'github_repository',
  'notion_callback',
  'notion_secrets',
  'queue_verify_repository',
  'queue_patch_config',
  'queue_configure_pages',
  'queue_dispatch_sync',
  'queue_await_sync',
  'queue_await_deploy_build',
  'queue_verify_deploy',
] as const;

export type ProvisioningAdmissionStage = (typeof PROVISIONING_ADMISSION_STAGES)[number];
export type ProvisioningControlMode = 'active' | 'pause' | 'kill';

export interface ProvisioningAdmissionVars {
  PROVISIONING_CONTROL_MODE?: string;
  PROVISIONING_PAUSED_STAGES?: string;
  PROVISIONING_REJECTED_STAGES?: string;
  PROVISIONING_ACCOUNT_ATTEMPT_WINDOW_SECONDS?: string;
  PROVISIONING_ACCOUNT_ATTEMPT_LIMIT?: string;
  PROVISIONING_REQUEST_BURST_WINDOW_SECONDS?: string;
  PROVISIONING_REQUEST_BURST_LIMIT?: string;
  PROVISIONING_DENIED_IDENTITY_COOLDOWN_SECONDS?: string;
  PROVISIONING_ADMISSION_AUDIT_TTL_SECONDS?: string;
}

export interface ProvisioningAdmissionConfig {
  readonly mode: ProvisioningControlMode;
  readonly pausedStages: readonly ProvisioningAdmissionStage[];
  readonly rejectedStages: readonly ProvisioningAdmissionStage[];
  readonly accountAttemptWindowSeconds: number;
  readonly accountAttemptLimit: number;
  readonly requestBurstWindowSeconds: number;
  readonly requestBurstLimit: number;
  readonly deniedIdentityCooldownSeconds: number;
  readonly auditTtlSeconds: number;
}

/** Operator-written value at `PROVISIONING_CONTROL_KEY`. Expired records are ignored. */
export interface ProvisioningControl {
  readonly version: 1;
  readonly mode: ProvisioningControlMode;
  readonly pausedStages: readonly ProvisioningAdmissionStage[];
  readonly rejectedStages: readonly ProvisioningAdmissionStage[];
  readonly updatedAt: number;
  readonly expiresAt: number | null;
}

export type ProvisioningAdmissionReason =
  | 'global_pause'
  | 'global_kill'
  | 'stage_paused'
  | 'stage_rejected'
  | 'control_invalid'
  | 'callback_replay'
  | 'request_burst'
  | 'account_attempt_limit'
  | 'identity_denied'
  | 'account_busy'
  | 'global_throttled';

export type ProvisioningAdmissionDecision =
  | { readonly action: 'allow'; readonly stage: ProvisioningAdmissionStage }
  | {
      readonly action: 'pause';
      readonly stage: ProvisioningAdmissionStage;
      readonly reason: 'global_pause' | 'stage_paused';
      readonly retryAfterSeconds: number;
    }
  | {
      readonly action: 'reject';
      readonly stage: ProvisioningAdmissionStage;
      readonly reason: Exclude<ProvisioningAdmissionReason, 'global_pause' | 'stage_paused'>;
      readonly retryAfterSeconds: number | null;
    };

export interface ProvisioningAccountAdmissionRecord {
  readonly version: 1;
  readonly accountId: number;
  readonly windowStartedAt: number;
  readonly expiresAt: number;
  readonly jobIds: readonly string[];
}

export interface ProvisioningRequestBurstRecord {
  readonly version: 1;
  readonly requestDigest: string;
  readonly windowStartedAt: number;
  readonly expiresAt: number;
  readonly count: number;
  readonly lastJobId: string;
}

export interface ProvisioningCallbackClaimRecord {
  readonly version: 1;
  readonly provider: 'github' | 'notion';
  readonly phase: 'setup' | 'oauth';
  readonly jobId: string;
  readonly claimedAt: number;
  readonly expiresAt: number;
}

export interface ProvisioningIdentityDenialRecord {
  readonly version: 1;
  readonly accountId: number;
  readonly reason: 'suspended' | 'provider_denied';
  readonly deniedAt: number;
  readonly expiresAt: number;
}

export interface ProvisioningAdmissionAuditRecord {
  readonly version: 1;
  readonly jobId: string;
  readonly accountId?: number;
  readonly requestDigest?: string;
  readonly stage: ProvisioningAdmissionStage;
  readonly decision: 'pause' | 'reject';
  readonly reason: ProvisioningAdmissionReason;
  readonly decidedAt: number;
  readonly expiresAt: number;
}

export interface ProvisioningAdmissionEnv extends ProvisioningAdmissionVars {
  JOBS: KVNamespace;
}

export const PROVISIONING_CONTROL_KEY = 'provisioning:admission:control';
export const PROVISIONING_ACCOUNT_PREFIX = 'provisioning:admission:account:';
export const PROVISIONING_CALLBACK_PREFIX = 'provisioning:admission:callback:';
export const PROVISIONING_BURST_PREFIX = 'provisioning:admission:burst:';
export const PROVISIONING_DENIAL_PREFIX = 'provisioning:admission:denial:';
export const PROVISIONING_AUDIT_PREFIX = 'provisioning:admission:audit:';

export const PROVISIONING_ACCOUNT_ATTEMPT_WINDOW_DEFAULT_SECONDS = 24 * 60 * 60;
export const PROVISIONING_ACCOUNT_ATTEMPT_LIMIT_DEFAULT = 3;
export const PROVISIONING_REQUEST_BURST_WINDOW_DEFAULT_SECONDS = 60;
export const PROVISIONING_REQUEST_BURST_LIMIT_DEFAULT = 10;
export const PROVISIONING_DENIED_IDENTITY_COOLDOWN_DEFAULT_SECONDS = 60 * 60;
export const PROVISIONING_ADMISSION_AUDIT_TTL_DEFAULT_SECONDS = 7 * 24 * 60 * 60;
export const PROVISIONING_CONTROL_RECHECK_SECONDS = 60;
const ADMISSION_TTL_MIN_SECONDS = 60;
const ADMISSION_TTL_MAX_SECONDS = 30 * 24 * 60 * 60;
const ADMISSION_LIMIT_MAX = 10_000;

export function admissionFailureCode(
  decisionOrReason: Exclude<ProvisioningAdmissionDecision, { action: 'allow' }> | ProvisioningAdmissionReason,
  callbackProvider?: 'github' | 'notion',
): ProvisioningFailureCode {
  const reason = typeof decisionOrReason === 'string' ? decisionOrReason : decisionOrReason.reason;
  switch (reason) {
    case 'global_pause':
    case 'stage_paused':
      return 'provisioning_paused';
    case 'global_kill':
    case 'stage_rejected':
      return 'provisioning_rejected';
    case 'control_invalid':
      return 'provisioning_control_invalid';
    case 'callback_replay':
      return callbackProvider === 'notion' ? 'notion_state_replayed' : 'github_state_replayed';
    case 'request_burst':
      return 'github_request_burst_limited';
    case 'account_attempt_limit':
      return 'github_account_attempt_limited';
    case 'identity_denied':
      return 'github_identity_temporarily_denied';
    case 'account_busy':
      return 'github_provisioning_already_active';
    case 'global_throttled':
      return 'github_rate_limited';
  }
}

export class ProvisioningAdmissionRefusedError extends Error {
  readonly code: ProvisioningFailureCode;
  readonly retryAfterSeconds: number | null;

  constructor(
    decision: Exclude<ProvisioningAdmissionDecision, { action: 'allow' }>,
    callbackProvider?: 'github' | 'notion',
  ) {
    const code = admissionFailureCode(decision, callbackProvider);
    super(code);
    this.name = 'ProvisioningAdmissionRefusedError';
    this.code = code;
    this.retryAfterSeconds = decision.retryAfterSeconds;
  }
}

export interface ProvisioningThrottleVars extends ProvisioningAdmissionVars {
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

function parseControlMode(raw: string | undefined): ProvisioningControlMode {
  if (raw === undefined) return 'active';
  if (raw === 'active' || raw === 'pause' || raw === 'kill') return raw;
  const failure = new Error('invalid provisioning admission configuration value') as Error & { variable: string };
  failure.variable = 'PROVISIONING_CONTROL_MODE';
  throw failure;
}

function parseStageList(raw: string | undefined, name: string): readonly ProvisioningAdmissionStage[] {
  if (raw === undefined || raw.trim() === '') return [];
  const known = new Set<string>(PROVISIONING_ADMISSION_STAGES);
  const stages = [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))];
  if (stages.some((stage) => !known.has(stage))) {
    const failure = new Error('invalid provisioning admission configuration value') as Error & { variable: string };
    failure.variable = name;
    throw failure;
  }
  return stages as ProvisioningAdmissionStage[];
}

function boundedConfigInteger(
  raw: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = parsePositiveInteger(raw, name) ?? fallback;
  if (value < minimum || value > maximum) {
    const failure = new Error('invalid provisioning admission configuration value') as Error & { variable: string };
    failure.variable = name;
    throw failure;
  }
  return value;
}

/** Parse operator environment input at each request or queue invocation. */
export function provisioningAdmissionConfig(vars: ProvisioningAdmissionVars): ProvisioningAdmissionConfig {
  return {
    mode: parseControlMode(vars.PROVISIONING_CONTROL_MODE),
    pausedStages: parseStageList(vars.PROVISIONING_PAUSED_STAGES, 'PROVISIONING_PAUSED_STAGES'),
    rejectedStages: parseStageList(vars.PROVISIONING_REJECTED_STAGES, 'PROVISIONING_REJECTED_STAGES'),
    accountAttemptWindowSeconds: boundedConfigInteger(
      vars.PROVISIONING_ACCOUNT_ATTEMPT_WINDOW_SECONDS,
      'PROVISIONING_ACCOUNT_ATTEMPT_WINDOW_SECONDS',
      PROVISIONING_ACCOUNT_ATTEMPT_WINDOW_DEFAULT_SECONDS,
      ADMISSION_TTL_MIN_SECONDS,
      ADMISSION_TTL_MAX_SECONDS,
    ),
    accountAttemptLimit: boundedConfigInteger(
      vars.PROVISIONING_ACCOUNT_ATTEMPT_LIMIT,
      'PROVISIONING_ACCOUNT_ATTEMPT_LIMIT',
      PROVISIONING_ACCOUNT_ATTEMPT_LIMIT_DEFAULT,
      1,
      ADMISSION_LIMIT_MAX,
    ),
    requestBurstWindowSeconds: boundedConfigInteger(
      vars.PROVISIONING_REQUEST_BURST_WINDOW_SECONDS,
      'PROVISIONING_REQUEST_BURST_WINDOW_SECONDS',
      PROVISIONING_REQUEST_BURST_WINDOW_DEFAULT_SECONDS,
      ADMISSION_TTL_MIN_SECONDS,
      60 * 60,
    ),
    requestBurstLimit: boundedConfigInteger(
      vars.PROVISIONING_REQUEST_BURST_LIMIT,
      'PROVISIONING_REQUEST_BURST_LIMIT',
      PROVISIONING_REQUEST_BURST_LIMIT_DEFAULT,
      1,
      ADMISSION_LIMIT_MAX,
    ),
    deniedIdentityCooldownSeconds: boundedConfigInteger(
      vars.PROVISIONING_DENIED_IDENTITY_COOLDOWN_SECONDS,
      'PROVISIONING_DENIED_IDENTITY_COOLDOWN_SECONDS',
      PROVISIONING_DENIED_IDENTITY_COOLDOWN_DEFAULT_SECONDS,
      ADMISSION_TTL_MIN_SECONDS,
      ADMISSION_TTL_MAX_SECONDS,
    ),
    auditTtlSeconds: boundedConfigInteger(
      vars.PROVISIONING_ADMISSION_AUDIT_TTL_SECONDS,
      'PROVISIONING_ADMISSION_AUDIT_TTL_SECONDS',
      PROVISIONING_ADMISSION_AUDIT_TTL_DEFAULT_SECONDS,
      ADMISSION_TTL_MIN_SECONDS,
      ADMISSION_TTL_MAX_SECONDS,
    ),
  };
}

export function provisioningAccountKey(accountId: number): string {
  return `${PROVISIONING_ACCOUNT_PREFIX}${accountId}`;
}

export function provisioningDenialKey(accountId: number): string {
  return `${PROVISIONING_DENIAL_PREFIX}${accountId}`;
}

export function provisioningBurstKey(requestDigest: string): string {
  return `${PROVISIONING_BURST_PREFIX}${requestDigest}`;
}

export function provisioningCallbackKey(
  provider: ProvisioningCallbackClaimRecord['provider'],
  phase: ProvisioningCallbackClaimRecord['phase'],
  nonce: string,
): string {
  return `${PROVISIONING_CALLBACK_PREFIX}${provider}:${phase}:${nonce}`;
}

export function provisioningQueueStage(step: ProvisioningStepName): ProvisioningAdmissionStage {
  return `queue_${step}` as ProvisioningAdmissionStage;
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

function validStageList(value: unknown): value is readonly ProvisioningAdmissionStage[] {
  const known = new Set<string>(PROVISIONING_ADMISSION_STAGES);
  return Array.isArray(value) && value.every((stage) => typeof stage === 'string' && known.has(stage));
}

function parseStoredControl(value: unknown, nowMs: number): ProvisioningControl | null | 'corrupted' {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return 'corrupted';
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || (record.mode !== 'active' && record.mode !== 'pause' && record.mode !== 'kill')
    || !validStageList(record.pausedStages)
    || !validStageList(record.rejectedStages)
    || !Number.isSafeInteger(record.updatedAt)
    || (record.expiresAt !== null && !Number.isSafeInteger(record.expiresAt))
  ) return 'corrupted';
  if (typeof record.expiresAt === 'number' && record.expiresAt <= nowMs) return null;
  return record as unknown as ProvisioningControl;
}

function stricterMode(left: ProvisioningControlMode, right: ProvisioningControlMode): ProvisioningControlMode {
  const rank: Record<ProvisioningControlMode, number> = { active: 0, pause: 1, kill: 2 };
  return rank[left] >= rank[right] ? left : right;
}

async function controlDecision(
  kv: KVNamespace,
  config: ProvisioningAdmissionConfig,
  stage: ProvisioningAdmissionStage,
  nowMs: number,
): Promise<ProvisioningAdmissionDecision> {
  let stored: ProvisioningControl | null | 'corrupted';
  try {
    stored = parseStoredControl(await kv.get(PROVISIONING_CONTROL_KEY, 'json'), nowMs);
  } catch {
    stored = 'corrupted';
  }
  if (stored === 'corrupted') {
    return { action: 'reject', stage, reason: 'control_invalid', retryAfterSeconds: PROVISIONING_CONTROL_RECHECK_SECONDS };
  }

  const mode = stored ? stricterMode(config.mode, stored.mode) : config.mode;
  const pausedStages = new Set<ProvisioningAdmissionStage>([
    ...config.pausedStages,
    ...(stored?.pausedStages ?? []),
  ]);
  const rejectedStages = new Set<ProvisioningAdmissionStage>([
    ...config.rejectedStages,
    ...(stored?.rejectedStages ?? []),
  ]);
  if (mode === 'kill') {
    return { action: 'reject', stage, reason: 'global_kill', retryAfterSeconds: PROVISIONING_CONTROL_RECHECK_SECONDS };
  }
  if (rejectedStages.has(stage)) {
    return { action: 'reject', stage, reason: 'stage_rejected', retryAfterSeconds: PROVISIONING_CONTROL_RECHECK_SECONDS };
  }
  if (mode === 'pause') {
    return { action: 'pause', stage, reason: 'global_pause', retryAfterSeconds: PROVISIONING_CONTROL_RECHECK_SECONDS };
  }
  if (pausedStages.has(stage)) {
    return { action: 'pause', stage, reason: 'stage_paused', retryAfterSeconds: PROVISIONING_CONTROL_RECHECK_SECONDS };
  }
  return { action: 'allow', stage };
}

async function recordAdmissionDecision(
  env: ProvisioningAdmissionEnv,
  config: ProvisioningAdmissionConfig,
  decision: ProvisioningAdmissionDecision,
  context: { jobId: string; accountId?: number; requestDigest?: string },
  nowMs: number,
): Promise<ProvisioningAdmissionDecision> {
  if (decision.action === 'allow') {
    return decision;
  }

  const expiresAt = nowMs + config.auditTtlSeconds * 1000;
  const audit: ProvisioningAdmissionAuditRecord = {
    version: 1,
    jobId: context.jobId,
    ...(context.accountId === undefined ? {} : { accountId: context.accountId }),
    ...(context.requestDigest === undefined ? {} : { requestDigest: context.requestDigest }),
    stage: decision.stage,
    decision: decision.action,
    reason: decision.reason,
    decidedAt: nowMs,
    expiresAt,
  };
  const auditKey = `${PROVISIONING_AUDIT_PREFIX}${context.jobId}:${decision.stage}:${decision.reason}`;
  if ((await env.JOBS.get(auditKey)) === null) {
    await env.JOBS.put(auditKey, JSON.stringify(audit), { expirationTtl: config.auditTtlSeconds });
  }
  return decision;
}

export async function admitProvisioningStage(
  env: ProvisioningAdmissionEnv,
  config: ProvisioningAdmissionConfig,
  params: { stage: ProvisioningAdmissionStage; jobId: string; accountId?: number },
  nowMs: number,
): Promise<ProvisioningAdmissionDecision> {
  const decision = await controlDecision(env.JOBS, config, params.stage, nowMs);
  return recordAdmissionDecision(env, config, decision, params, nowMs);
}

/** Admit one identified account attempt before any repository mutation. */
export async function admitProvisioningAccount(
  env: ProvisioningAdmissionEnv,
  config: ProvisioningAdmissionConfig,
  params: { accountId: number; jobId: string },
  nowMs: number,
): Promise<ProvisioningAdmissionDecision> {
  const stage = 'github_repository' as const;
  const control = await controlDecision(env.JOBS, config, stage, nowMs);
  if (control.action !== 'allow') return recordAdmissionDecision(env, config, control, params, nowMs);

  const key = provisioningAccountKey(params.accountId);
  const decision = await withKeyLock(key, async (): Promise<ProvisioningAdmissionDecision> => {
    const denial = await env.JOBS.get<ProvisioningIdentityDenialRecord>(provisioningDenialKey(params.accountId), 'json');
    if (denial && denial.version === 1 && denial.expiresAt > nowMs) {
      return { action: 'reject', stage, reason: 'identity_denied', retryAfterSeconds: Math.max(Math.ceil((denial.expiresAt - nowMs) / 1000), 1) };
    }

    const stored = await env.JOBS.get<ProvisioningAccountAdmissionRecord>(key, 'json');
    const valid = stored
      && stored.version === 1
      && stored.accountId === params.accountId
      && Number.isSafeInteger(stored.windowStartedAt)
      && Number.isSafeInteger(stored.expiresAt)
      && Array.isArray(stored.jobIds)
      && stored.jobIds.every((jobId) => typeof jobId === 'string')
      && stored.expiresAt > nowMs;
    if (stored && !valid) {
      return { action: 'reject', stage, reason: 'account_attempt_limit', retryAfterSeconds: config.accountAttemptWindowSeconds };
    }
    const count = valid ? stored!.jobIds.length : 0;
    if (count >= config.accountAttemptLimit) {
      return { action: 'reject', stage, reason: 'account_attempt_limit', retryAfterSeconds: Math.max(Math.ceil((stored!.expiresAt - nowMs) / 1000), 1) };
    }
    const expiresAt = valid ? stored!.expiresAt : nowMs + config.accountAttemptWindowSeconds * 1000;
    const updated: ProvisioningAccountAdmissionRecord = {
      version: 1,
      accountId: params.accountId,
      windowStartedAt: valid ? stored!.windowStartedAt : nowMs,
      expiresAt,
      jobIds: [...(valid ? stored!.jobIds : []), params.jobId],
    };
    await env.JOBS.put(key, JSON.stringify(updated), { expirationTtl: Math.max(Math.ceil((expiresAt - nowMs) / 1000), 60) });
    return { action: 'allow', stage };
  });
  return recordAdmissionDecision(env, config, decision, params, nowMs);
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (octets.some((part, index) => !/^\d{1,3}$/u.test(parts[index]!) || !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return octets;
}

function ipv6Groups(value: string): number[] | null {
  if (!/^[0-9a-f:.]+$/u.test(value)) return null;
  const pieces = value.split('::');
  if (pieces.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const groups: number[] = [];
    const parts = side.split(':');
    for (const [index, part] of parts.entries()) {
      if (part.includes('.')) {
        if (index !== parts.length - 1) return null;
        const ipv4 = parseIpv4(part);
        if (!ipv4) return null;
        groups.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
      } else {
        if (!/^[0-9a-f]{1,4}$/u.test(part)) return null;
        groups.push(Number.parseInt(part, 16));
      }
    }
    return groups;
  };
  const left = parseSide(pieces[0]!);
  const right = parseSide(pieces[1] ?? '');
  if (!left || !right) return null;
  if (pieces.length === 1) return left.length === 8 ? left : null;
  const omitted = 8 - left.length - right.length;
  if (omitted < 1) return null;
  return [...left, ...Array.from({ length: omitted }, () => 0), ...right];
}

function normalizedConnectingIpPrefix(raw: string | null): string {
  const value = raw?.trim().toLowerCase() ?? '';
  const ipv4 = parseIpv4(value);
  if (ipv4) return `ipv4:${ipv4[0]}.${ipv4[1]}.${ipv4[2]}.0/24`;
  const groups = ipv6Groups(value);
  if (!groups) return 'unknown';
  const bytes = groups.flatMap((group) => [group >> 8, group & 0xff]);
  return `ipv6:${bytes.slice(0, 7).map((byte) => byte.toString(16).padStart(2, '0')).join('')}/56`;
}

/** HMAC of an IPv4 /24 or IPv6 /56. The normalized prefix never leaves this function. */
export async function provisioningRequestDigest(request: Request, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(normalizedConnectingIpPrefix(request.headers.get('CF-Connecting-IP'))),
  );
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function admitProvisioningRequest(
  env: ProvisioningAdmissionEnv,
  config: ProvisioningAdmissionConfig,
  params: { request: Request; jobId: string; hmacSecret: string },
  nowMs: number,
): Promise<ProvisioningAdmissionDecision> {
  const stage = 'github_connect';
  const control = await controlDecision(env.JOBS, config, stage, nowMs);
  if (control.action !== 'allow') return recordAdmissionDecision(env, config, control, params, nowMs);

  const requestDigest = await provisioningRequestDigest(params.request, params.hmacSecret);
  const key = provisioningBurstKey(requestDigest);
  const decision = await withKeyLock(key, async (): Promise<ProvisioningAdmissionDecision> => {
    const stored = await env.JOBS.get<ProvisioningRequestBurstRecord>(key, 'json');
    const fresh = !stored
      || stored.version !== 1
      || stored.requestDigest !== requestDigest
      || stored.expiresAt <= nowMs;
    const count = fresh ? 0 : stored.count;
    if (!Number.isSafeInteger(count) || count < 0) {
      return { action: 'reject', stage, reason: 'request_burst', retryAfterSeconds: config.requestBurstWindowSeconds };
    }
    if (count >= config.requestBurstLimit) {
      return {
        action: 'reject',
        stage,
        reason: 'request_burst',
        retryAfterSeconds: Math.max(Math.ceil(((stored?.expiresAt ?? nowMs) - nowMs) / 1000), 1),
      };
    }
    const windowStartedAt = fresh ? nowMs : stored.windowStartedAt;
    const expiresAt = fresh ? nowMs + config.requestBurstWindowSeconds * 1000 : stored.expiresAt;
    const updated: ProvisioningRequestBurstRecord = {
      version: 1,
      requestDigest,
      windowStartedAt,
      expiresAt,
      count: count + 1,
      lastJobId: params.jobId,
    };
    await env.JOBS.put(key, JSON.stringify(updated), { expirationTtl: config.requestBurstWindowSeconds });
    return { action: 'allow', stage };
  });
  return recordAdmissionDecision(env, config, decision, { jobId: params.jobId, requestDigest }, nowMs);
}

export const PROVISIONING_CALLBACK_CLAIM_TTL_SECONDS = 60 * 60;

export async function admitProvisioningCallback(
  env: ProvisioningAdmissionEnv,
  config: ProvisioningAdmissionConfig,
  params: {
    provider: ProvisioningCallbackClaimRecord['provider'];
    phase: ProvisioningCallbackClaimRecord['phase'];
    nonce: string;
    jobId: string;
    stage: 'github_callback' | 'notion_callback';
  },
  nowMs: number,
): Promise<ProvisioningAdmissionDecision> {
  const control = await controlDecision(env.JOBS, config, params.stage, nowMs);
  if (control.action !== 'allow') return recordAdmissionDecision(env, config, control, params, nowMs);

  const key = provisioningCallbackKey(params.provider, params.phase, params.nonce);
  const decision = await withKeyLock(key, async (): Promise<ProvisioningAdmissionDecision> => {
    const stored = await env.JOBS.get<ProvisioningCallbackClaimRecord>(key, 'json');
    if (stored && stored.expiresAt > nowMs) {
      return { action: 'reject', stage: params.stage, reason: 'callback_replay', retryAfterSeconds: null };
    }
    const record: ProvisioningCallbackClaimRecord = {
      version: 1,
      provider: params.provider,
      phase: params.phase,
      jobId: params.jobId,
      claimedAt: nowMs,
      expiresAt: nowMs + PROVISIONING_CALLBACK_CLAIM_TTL_SECONDS * 1000,
    };
    await env.JOBS.put(key, JSON.stringify(record), { expirationTtl: PROVISIONING_CALLBACK_CLAIM_TTL_SECONDS });
    return { action: 'allow', stage: params.stage };
  });
  return recordAdmissionDecision(env, config, decision, params, nowMs);
}

export async function recordProvisioningIdentityDenial(
  kv: KVNamespace,
  config: ProvisioningAdmissionConfig,
  params: { accountId: number; reason: ProvisioningIdentityDenialRecord['reason'] },
  nowMs: number,
): Promise<void> {
  const record: ProvisioningIdentityDenialRecord = {
    version: 1,
    accountId: params.accountId,
    reason: params.reason,
    deniedAt: nowMs,
    expiresAt: nowMs + config.deniedIdentityCooldownSeconds * 1000,
  };
  await withKeyLock(provisioningDenialKey(params.accountId), async () => {
    await kv.put(provisioningDenialKey(params.accountId), JSON.stringify(record), {
      expirationTtl: config.deniedIdentityCooldownSeconds,
    });
  });
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
 * These `ProvisioningStepName` values create or change content on GitHub and
 * therefore consume global budget. The set is typed against the step-name
 * union, so a renamed step fails typecheck. A newly added step defaults to
 * non-budgeted and must be classified here deliberately. `verify_repository`, `await_sync`,
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
  | { action: 'pause'; reason: 'operator_paused' | 'stage_paused'; delaySeconds: number }
  | { action: 'wait'; reason: 'global_throttled'; delaySeconds: number }
  | { action: 'superseded' };

/**
 * One gate pass first checks admission control, then checks the account lease,
 * renews the lease, and consumes budget for a mutation step. It runs for every
 * step so slow inline poll steps keep renewing their lease. Rules:
 * - foreign live lease ⇒ superseded (L2: never steal — the caller
 *   terminal-fails the job);
 * - own, expired, or absent lease ⇒ (re)claim by writing ours;
 * - paused or rejected admission ⇒ pause before the lease or token mint;
 * - budgeted step ⇒ consumeGlobalMutationBudget; a refusal becomes a wait.
 *
 * Caller contract: on 'wait' or 'pause' the queue persists the job unlocked,
 * carries the wait breadcrumb with attempts untouched, and hands the
 * continuation to a fresh message. On 'superseded' the caller saves the
 * terminal record via saveTerminalProvisioningJob and acks.
 */
export async function gateProvisioningStep(
  kv: KVNamespace,
  job: ProvisioningJob,
  step: ProvisioningStepName,
  config: ProvisioningThrottleConfig,
  nowMs: number,
  rng: () => number,
  admission: ProvisioningAdmissionConfig = provisioningAdmissionConfig({}),
): Promise<StepGateDecision> {
  const control = await admitProvisioningStage(
    { JOBS: kv } as ProvisioningAdmissionEnv,
    admission,
    { stage: provisioningQueueStage(step), jobId: job.jobId, accountId: job.identity.id },
    nowMs,
  );
  if (control.action !== 'allow') {
    return { action: 'pause', reason: 'stage_paused', delaySeconds: control.retryAfterSeconds ?? 60 };
  }
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
