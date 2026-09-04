/**
 * Durable provisioning job schema and KV persistence.
 *
 * A job is the single source of truth for one provisioning attempt: which
 * steps have completed, their non-secret results, and enough bookkeeping to
 * resume after a crash or process a duplicate/out-of-order queue delivery
 * safely. No OAuth code, user access token, or installation token is ever
 * part of this record — every step mints its own installation token from
 * the durable, non-secret `installationId` and discards it when the step
 * returns.
 */

import type { GeneratedRepositoryIdentity } from './repository-generation';
import type { GithubPagesIdentity } from './github-pages';
import type { RepositoryDestination } from './repository-naming';
import { isProvisioningFailureCode, type ProvisioningFailureCode } from './failures';

export const PROVISIONING_JOB_VERSION = 1;
export const PROVISIONING_JOB_TTL_SECONDS = 24 * 60 * 60;
export const PROVISIONING_JOB_PREFIX = 'github:onboarding-job:';
export const PROVISIONING_STEP_MAX_ATTEMPTS = 5;
/**
 * Attempt ceiling for failures that carry GitHub's own Retry-After. Honoring
 * the provider's pacing must not dead-letter the job through the regular
 * five-attempt ceiling, so rate-limited attempts get their own, much larger
 * bound before the job gives up.
 */
export const PROVISIONING_RATE_LIMIT_MAX_ATTEMPTS = 24;
export const PROVISIONING_LOCK_TTL_MS = 5 * 60 * 1000;
export const PROVISIONING_LOCK_RETRY_DELAY_SECONDS = 30;
/** Short backoff for redelivery after a step succeeded but handing the
 * continuation to the queue itself failed — expected to be rare and
 * transient, unlike a provider-classified step failure. */
export const PROVISIONING_ENQUEUE_RETRY_DELAY_SECONDS = 10;

/**
 * One entry per synchronous chain this project's `finishGithubCallback` used
 * to run inline. Each name maps 1:1 to an existing, independently-idempotent
 * provider call (see `provisioning-steps.ts`), so a step can be retried on
 * its own without re-running the steps before it.
 */
export const PROVISIONING_STEP_ORDER = [
  'verify_repository',
  'patch_config',
  'configure_pages',
  'dispatch_sync',
  'await_sync',
  'await_deploy_build',
  'verify_deploy',
] as const;

export type ProvisioningStepName = (typeof PROVISIONING_STEP_ORDER)[number];

export type ProvisioningStepStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed';

export interface ProvisioningStepError {
  code: ProvisioningFailureCode;
  retryable: boolean;
}

export interface ProvisioningStepState {
  status: ProvisioningStepStatus;
  attempts: number;
  updatedAt: number;
  lastError: ProvisioningStepError | null;
}

export interface ProvisioningJobLock {
  owner: string;
  acquiredAt: number;
  expiresAt: number;
}

/**
 * Non-secret breadcrumb that a delivery was throttled or paused rather than
 * failed: reason and time only — never identity, provider text, or a token. A
 * wait is not an error, so `lastError` stays reserved for failures.
 */
export interface ProvisioningJobWait {
  reason: 'global_throttled' | 'operator_paused' | 'stage_paused';
  /** Epoch ms after which the next delivery should re-evaluate; null re-evaluates now. */
  untilMs: number | null;
  updatedAt: number;
}

export type ProvisioningJobStatus =
  | 'awaiting_notion'
  | 'queued'
  | 'paused'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'dead_letter';

/**
 * Non-secret marker persisted before dispatching the Notion sync workflow.
 * Dispatch is the one call in this pipeline that is not naturally
 * idempotent — a second POST starts a second workflow run — so a crash
 * between the dispatch call and recording its correlated run must resume by
 * correlating the same window, never by dispatching again.
 */
export interface SyncDispatchMarker {
  excludedRunIds: number[];
  dispatchedAtMs: number;
}

export interface NotionSyncProgress {
  runId: number;
  htmlUrl: string;
  conclusion: string | null;
}

export interface SiteDeploymentProgress {
  commitSha: string;
  buildId: number | null;
  status: 'built' | 'building' | 'errored';
  verifiedAt: number | null;
}

export interface ProvisioningJobData {
  repository: RepositoryDestination;
  generatedRepository: GeneratedRepositoryIdentity;
  pages: GithubPagesIdentity | null;
  sync: NotionSyncProgress | null;
  syncDispatchMarker: SyncDispatchMarker | null;
  deployment: SiteDeploymentProgress | null;
  /**
   * When the repository's three Actions secrets were written by the Notion
   * OAuth callback — a timestamp, never the values. Until it is set the job
   * is not enqueued at all, so no step can reach `dispatch_sync` and record
   * GitHub Actions' missing-credentials no-op as a success.
   */
  notionSecretsWrittenAt: number | null;
}

/** Structurally identical to `Env`'s `GithubIdentity`; duplicated here so this
 * module never imports from `index.ts` (which imports this module). */
export interface ProvisioningJobIdentity {
  id: number;
  login: string;
  accountType: 'User' | 'Organization';
}

export interface ProvisioningJob {
  version: 1;
  jobId: string;
  installationId: number;
  identity: ProvisioningJobIdentity;
  status: ProvisioningJobStatus;
  steps: Record<ProvisioningStepName, ProvisioningStepState>;
  data: ProvisioningJobData;
  lock: ProvisioningJobLock | null;
  /** Set while the job is parked behind a throttle or admission control;
   * cleared when the step next books and on every terminal save. Absent in
   * pre-throttle records. */
  wait: ProvisioningJobWait | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export function provisioningJobKey(jobId: string): string {
  return `${PROVISIONING_JOB_PREFIX}${jobId}`;
}

export function isTerminalProvisioningStatus(status: ProvisioningJobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'dead_letter';
}

/** The first step that has not yet succeeded, or `null` once every step has. */
export function nextPendingStep(job: ProvisioningJob): ProvisioningStepName | null {
  return PROVISIONING_STEP_ORDER.find((step) => job.steps[step].status !== 'succeeded') ?? null;
}

/** Exponential backoff for a retryable step failure: 30s, 60s, 120s, ... capped at 15 minutes. */
export function provisioningRetryDelaySeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempts - 1), 900);
}

function initialStepState(now: number): ProvisioningStepState {
  return { status: 'pending', attempts: 0, updatedAt: now, lastError: null };
}

export interface CreateProvisioningJobParams {
  jobId: string;
  installationId: number;
  identity: ProvisioningJobIdentity;
  repository: RepositoryDestination;
  generatedRepository: GeneratedRepositoryIdentity;
  now: number;
}

/**
 * Build a fresh job record with every step `pending`. The job starts
 * `awaiting_notion`: the Notion OAuth callback writes the Actions secrets and
 * only then hands the job to the queue.
 */
export function createProvisioningJob(params: CreateProvisioningJobParams): ProvisioningJob {
  const steps = Object.fromEntries(
    PROVISIONING_STEP_ORDER.map((step) => [step, initialStepState(params.now)]),
  ) as Record<ProvisioningStepName, ProvisioningStepState>;

  return {
    version: PROVISIONING_JOB_VERSION,
    jobId: params.jobId,
    installationId: params.installationId,
    identity: params.identity,
    status: 'awaiting_notion',
    steps,
    data: {
      repository: params.repository,
      generatedRepository: params.generatedRepository,
      pages: null,
      sync: null,
      syncDispatchMarker: null,
      deployment: null,
      notionSecretsWrittenAt: null,
    },
    lock: null,
    wait: null,
    createdAt: params.now,
    updatedAt: params.now,
    completedAt: null,
  };
}

/**
 * `lastError.code` is written only from the closed taxonomy by current code,
 * but a record persisted by an older or differently-deployed version can
 * carry any string. Normalize on read so every consumer can trust the union,
 * keeping the recorded retry decision. Forensics caveat: the stored code is
 * replaced in the returned record, so inspecting a historical value means
 * reading the raw JSON out of KV, not this function's result.
 */
function sanitizedStepErrors(job: ProvisioningJob): ProvisioningJob['steps'] {
  const steps = { ...job.steps };
  for (const step of PROVISIONING_STEP_ORDER) {
    const lastError = steps[step].lastError;
    if (lastError && !isProvisioningFailureCode(lastError.code)) {
      steps[step] = { ...steps[step], lastError: { code: 'provisioning_step_failed', retryable: lastError.retryable } };
    }
  }
  return steps;
}

export async function loadProvisioningJob(kv: KVNamespace, jobId: string): Promise<ProvisioningJob | null> {
  const job = await kv.get<ProvisioningJob>(provisioningJobKey(jobId), 'json');
  if (!job || job.version !== PROVISIONING_JOB_VERSION) return null;
  // Records written before the throttle existed carry no `wait`; the version
  // stays 1 because the 24h TTL drains them without a migration.
  return { ...job, steps: sanitizedStepErrors(job), wait: job.wait ?? null };
}

/** Persist a job with the same rolling TTL used everywhere else in this project — the
 * record (and any sensitive-adjacent transient state it carries, like the sync
 * dispatch marker) is removed on schedule rather than lingering indefinitely. */
export async function saveProvisioningJob(
  kv: KVNamespace,
  job: ProvisioningJob,
  ttlSeconds = PROVISIONING_JOB_TTL_SECONDS,
): Promise<void> {
  await kv.put(provisioningJobKey(job.jobId), JSON.stringify(job), { expirationTtl: ttlSeconds });
}

/**
 * Acquire the job's lock for this processing attempt, or return `null` when
 * a still-live attempt already holds it.
 *
 * Workers KV has no compare-and-swap, so two invocations that read the job
 * at the same instant can both observe no lock and both write one — closing
 * that race completely would need a Durable Object, which this queue's
 * throughput does not justify. For six of the seven steps that is a
 * contained accepted trade-off: each is idempotent, so the rare double
 * acquisition wastes a redundant step execution rather than corrupting job
 * state or double-mutating an external system. `dispatch_sync` is the
 * documented exception: its before-dispatch marker (see `runDispatchSync`
 * in `provisioning-steps.ts`) makes a *sequential* crash-then-retry safe,
 * but does not by itself prevent two invocations that are both genuinely
 * in flight at once — each reading `syncDispatchMarker` as `null` from its
 * own in-memory snapshot before either has written — from both taking the
 * fresh-dispatch branch and starting two real workflow runs. Closing that
 * specific gap needs the same compare-and-swap this function lacks; it is
 * an accepted, documented limitation rather than a silent one, and a
 * candidate for a Durable-Object-backed lock if genuine concurrent
 * redelivery of the same job is ever observed in practice.
 */
export function tryAcquireProvisioningLock(
  job: ProvisioningJob,
  owner: string,
  now: number,
): ProvisioningJob | null {
  if (job.lock && job.lock.expiresAt > now) return null;
  return {
    ...job,
    status: 'running',
    lock: { owner, acquiredAt: now, expiresAt: now + PROVISIONING_LOCK_TTL_MS },
    updatedAt: now,
  };
}
