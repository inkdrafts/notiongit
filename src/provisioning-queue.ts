/**
 * Queue consumer for durable provisioning jobs.
 *
 * A message only ever names a job (`{ jobId }`); the KV record is the
 * authoritative source of progress, so a redelivered, duplicated, or
 * out-of-order message always resumes from whatever the record already
 * reflects rather than repeating a completed step. Each invocation advances
 * at most one step, then either enqueues a continuation message (more steps
 * remain), asks the queue to redeliver the same message later (a retryable
 * failure or a lock held by another in-flight attempt), or does neither
 * (the job just reached a terminal status).
 */

import {
  createGithubInstallationToken,
  GithubAppAuthError,
  type GithubAppAuthEnv,
} from './github-app-auth';
import { GithubConfigError } from './repository-config';
import { GithubPagesError } from './github-pages';
import { GithubSyncError } from './notion-sync';
import { GithubDeployError } from './site-deployment';
import { GithubGenerateError } from './repository-generation';
import { PROVISIONING_STEP_HANDLERS, type StepRunnerContext } from './provisioning-steps';
import {
  isTerminalProvisioningStatus,
  loadProvisioningJob,
  nextPendingStep,
  provisioningRetryDelaySeconds,
  saveProvisioningJob,
  tryAcquireProvisioningLock,
  PROVISIONING_LOCK_RETRY_DELAY_SECONDS,
  PROVISIONING_STEP_MAX_ATTEMPTS,
  type ProvisioningJob,
  type ProvisioningStepName,
} from './provisioning-job';

export interface ProvisioningQueueEnv extends GithubAppAuthEnv {
  JOBS: KVNamespace;
  PROVISIONING_QUEUE: Queue<{ jobId: string }>;
}

export interface ProvisioningRuntimeOptions {
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  lockOwner?: () => string;
}

export type ProvisioningMessageOutcome =
  | { outcome: 'acked' }
  | { outcome: 'retry'; delaySeconds: number };

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export interface ProvisioningErrorClassification {
  code: string;
  retryable: boolean;
  retryAfterSeconds: number | null;
}

const RETRYABLE_SYNC_CODES = new Set([
  'github_sync_dispatch_unavailable',
  'github_sync_rate_limited',
  'github_sync_correlate_timeout',
  'github_sync_run_timeout',
  'github_sync_unavailable',
]);

const RETRYABLE_PAGES_CODES = new Set(['github_pages_rate_limited', 'github_pages_unavailable']);

const RETRYABLE_CONFIG_CODES = new Set(['github_config_conflict', 'github_config_unavailable']);

const RETRYABLE_GENERATE_CODES = new Set([
  'github_generate_rate_limited',
  'github_generate_timeout',
  'github_generate_unavailable',
]);

const RETRYABLE_DEPLOY_CODES = new Set([
  'github_deploy_url_unreachable',
  'github_deploy_timeout',
  'github_deploy_unavailable',
]);

/** Maps every provisioning error this queue can encounter to a retry decision. */
export function classifyProvisioningError(error: unknown): ProvisioningErrorClassification {
  if (error instanceof GithubConfigError) {
    return { code: error.code, retryable: RETRYABLE_CONFIG_CODES.has(error.code), retryAfterSeconds: null };
  }
  if (error instanceof GithubPagesError) {
    return { code: error.code, retryable: RETRYABLE_PAGES_CODES.has(error.code), retryAfterSeconds: error.retryAfterSeconds };
  }
  if (error instanceof GithubSyncError) {
    return { code: error.code, retryable: RETRYABLE_SYNC_CODES.has(error.code), retryAfterSeconds: error.retryAfterSeconds };
  }
  if (error instanceof GithubDeployError) {
    // A build GitHub reports as errored for this exact commit will not fix
    // itself; url-unreachable, the bounded build timeout, and a transient
    // unavailable are all worth another pass.
    return { code: error.code, retryable: RETRYABLE_DEPLOY_CODES.has(error.code), retryAfterSeconds: null };
  }
  if (error instanceof GithubGenerateError) {
    return { code: error.code, retryable: RETRYABLE_GENERATE_CODES.has(error.code), retryAfterSeconds: error.retryAfterSeconds };
  }
  if (error instanceof GithubAppAuthError) {
    return { code: 'github_app_auth_failed', retryable: error.status >= 500 || error.status === 429, retryAfterSeconds: null };
  }
  // An unrecognized error (a network throw, a bug) is treated as transient.
  // The per-step attempt ceiling still bounds it to a handful of tries
  // before the job goes to dead_letter, so this can never retry forever.
  return { code: 'provisioning_step_failed', retryable: true, retryAfterSeconds: null };
}

async function recordStepFailure(
  env: Pick<ProvisioningQueueEnv, 'JOBS'>,
  job: ProvisioningJob,
  step: ProvisioningStepName,
  error: unknown,
  now: number,
): Promise<ProvisioningMessageOutcome> {
  const classification = classifyProvisioningError(error);
  const attempts = job.steps[step].attempts + 1;
  const terminal = !classification.retryable || attempts >= PROVISIONING_STEP_MAX_ATTEMPTS;

  const updated: ProvisioningJob = {
    ...job,
    status: terminal ? 'dead_letter' : 'queued',
    steps: {
      ...job.steps,
      [step]: {
        status: terminal ? 'failed' : 'pending',
        attempts,
        updatedAt: now,
        lastError: { code: classification.code, retryable: classification.retryable },
      },
    },
    lock: null,
    updatedAt: now,
    completedAt: terminal ? now : null,
  };
  await saveProvisioningJob(env.JOBS, updated);

  if (terminal) return { outcome: 'acked' };
  const delaySeconds = classification.retryAfterSeconds ?? provisioningRetryDelaySeconds(attempts);
  return { outcome: 'retry', delaySeconds };
}

/**
 * Advance one job by exactly one step. Safe to call for a duplicate,
 * out-of-order, or post-completion delivery of the same `jobId`: a job that
 * is already terminal or currently locked by a live attempt is left
 * untouched.
 */
export async function processProvisioningMessage(
  jobId: string,
  env: ProvisioningQueueEnv,
  runtime: ProvisioningRuntimeOptions = {},
): Promise<ProvisioningMessageOutcome> {
  const {
    fetcher = fetch,
    sleep = defaultSleep,
    now = () => Date.now(),
    lockOwner = () => crypto.randomUUID(),
  } = runtime;

  const job = await loadProvisioningJob(env.JOBS, jobId);
  if (!job) return { outcome: 'acked' };
  if (isTerminalProvisioningStatus(job.status)) return { outcome: 'acked' };

  const locked = tryAcquireProvisioningLock(job, lockOwner(), now());
  if (!locked) return { outcome: 'retry', delaySeconds: PROVISIONING_LOCK_RETRY_DELAY_SECONDS };
  await saveProvisioningJob(env.JOBS, locked);

  const step = nextPendingStep(locked);
  if (!step) {
    const finishedMs = now();
    await saveProvisioningJob(env.JOBS, { ...locked, status: 'succeeded', lock: null, completedAt: finishedMs, updatedAt: finishedMs });
    return { outcome: 'acked' };
  }

  let installationToken: string;
  try {
    installationToken = await createGithubInstallationToken(env, locked.installationId, fetcher);
  } catch (error) {
    return recordStepFailure(env, locked, step, error, now());
  }

  const inProgressMs = now();
  const inProgress: ProvisioningJob = {
    ...locked,
    steps: { ...locked.steps, [step]: { ...locked.steps[step], status: 'in_progress', updatedAt: inProgressMs } },
  };
  await saveProvisioningJob(env.JOBS, inProgress);

  const ctx: StepRunnerContext = { jobs: env.JOBS, installationToken, fetcher, sleep, now };
  try {
    const patch = await PROVISIONING_STEP_HANDLERS[step](inProgress, ctx);
    const completionMs = now();
    const stepSucceeded: ProvisioningJob = {
      ...inProgress,
      data: { ...inProgress.data, ...patch },
      steps: {
        ...inProgress.steps,
        [step]: { status: 'succeeded', attempts: inProgress.steps[step].attempts + 1, updatedAt: completionMs, lastError: null },
      },
      lock: null,
      updatedAt: completionMs,
    };

    const remainingStep = nextPendingStep(stepSucceeded);
    const finalJob: ProvisioningJob = remainingStep
      ? { ...stepSucceeded, status: 'queued' }
      : { ...stepSucceeded, status: 'succeeded', completedAt: completionMs };
    await saveProvisioningJob(env.JOBS, finalJob);
    if (remainingStep) await env.PROVISIONING_QUEUE.send({ jobId });
    return { outcome: 'acked' };
  } catch (error) {
    return recordStepFailure(env, inProgress, step, error, now());
  }
}
