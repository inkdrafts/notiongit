/**
 * Queue consumer for durable provisioning jobs.
 *
 * A message only ever names a job (`{ jobId }`); the KV record is the
 * authoritative source of progress, so a redelivered, duplicated, or
 * out-of-order message always resumes from whatever the record already
 * reflects rather than repeating a completed step. Each invocation advances
 * at most one step, then either enqueues a continuation message (more steps
 * remain), asks the queue to redeliver the same message later (a retryable
 * step failure, a lock held by another in-flight attempt, a record not yet
 * visible through KV's eventual consistency, or a step that succeeded but
 * whose continuation failed to enqueue — the saved success is kept and a
 * retryable `provisioning_enqueue_failed` breadcrumb is left on the step now
 * waiting, so the record never reads as healthy while nothing can advance
 * it), or acks (the job just reached a terminal status).
 */

import { createGithubInstallationToken, type GithubAppAuthEnv } from './github-app-auth';
import { classifyProvisioningError, type ProvisioningErrorClassification } from './failures';
import { emitProvisioningEvent, type ObservabilityEnv } from './observability';
import { PROVISIONING_STEP_HANDLERS, type StepRunnerContext } from './provisioning-steps';
import type { Secret } from './secret';
import {
  isTerminalProvisioningStatus,
  loadProvisioningJob,
  nextPendingStep,
  provisioningRetryDelaySeconds,
  saveProvisioningJob,
  tryAcquireProvisioningLock,
  PROVISIONING_ENQUEUE_RETRY_DELAY_SECONDS,
  PROVISIONING_LOCK_RETRY_DELAY_SECONDS,
  PROVISIONING_RATE_LIMIT_MAX_ATTEMPTS,
  PROVISIONING_STEP_MAX_ATTEMPTS,
  type ProvisioningJob,
  type ProvisioningStepName,
} from './provisioning-job';
import {
  gateProvisioningStep,
  jitteredDelaySeconds,
  provisioningThrottleConfig,
  saveTerminalProvisioningJob,
  type ProvisioningThrottleVars,
} from './provisioning-throttle';

export { classifyProvisioningError };
export type { ProvisioningErrorClassification };

export interface ProvisioningQueueEnv extends GithubAppAuthEnv, ObservabilityEnv, ProvisioningThrottleVars {
  JOBS: KVNamespace;
  PROVISIONING_QUEUE: Queue<{ jobId: string }>;
}

export interface ProvisioningRuntimeOptions {
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  lockOwner?: () => string;
  /** Injectable [0,1) random source for bounded backoff jitter; tests pin
   * delays by injecting a constant. */
  rng?: () => number;
}

export type ProvisioningMessageOutcome =
  | { outcome: 'acked' }
  | { outcome: 'retry'; delaySeconds: number };

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function recordStepFailure(
  env: Pick<ProvisioningQueueEnv, 'JOBS' | 'PROVISIONING_QUEUE' | 'PROVISIONING_METRICS'>,
  job: ProvisioningJob,
  step: ProvisioningStepName,
  error: unknown,
  now: number,
  rng: () => number,
  stepStartedMs: number,
): Promise<ProvisioningMessageOutcome> {
  const classification = classifyProvisioningError(error);
  const { retryAfterSeconds } = classification;
  // The step handler may have persisted data directly to KV after this
  // attempt's snapshot was taken — the sync dispatch marker is written this
  // way exactly so it survives an ambiguous dispatch failure. Re-read the
  // record and move only the step bookkeeping onto it; wiping `data` here
  // would make the retry dispatch a second Notion sync run.
  const persisted = await loadProvisioningJob(env.JOBS, job.jobId);
  const base = persisted ?? job;
  const attempts = base.steps[step].attempts + 1;
  const terminal = !classification.retryable
    || attempts >= (retryAfterSeconds !== null ? PROVISIONING_RATE_LIMIT_MAX_ATTEMPTS : PROVISIONING_STEP_MAX_ATTEMPTS);

  const updated: ProvisioningJob = {
    ...base,
    status: terminal ? 'dead_letter' : 'queued',
    steps: {
      ...base.steps,
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
  if (terminal) {
    await saveTerminalProvisioningJob(env, updated);
  } else {
    await saveProvisioningJob(env.JOBS, updated);
  }
  emitProvisioningEvent(env, {
    type: 'step_failed',
    jobId: base.jobId,
    ts: now,
    step,
    attempt: attempts,
    errorCode: classification.code,
    retryable: classification.retryable,
    terminal,
    durationMs: now - stepStartedMs,
  });
  if (retryAfterSeconds !== null) {
    emitProvisioningEvent(env, {
      type: 'rate_limited',
      jobId: base.jobId,
      ts: now,
      step,
      errorCode: classification.code,
      retryAfterSeconds,
    });
  }
  if (terminal) {
    emitProvisioningEvent(env, {
      type: 'job_dead_lettered',
      jobId: base.jobId,
      ts: now,
      step,
      errorCode: classification.code,
      totalDurationMs: now - base.createdAt,
    });
    return { outcome: 'acked' };
  }
  if (retryAfterSeconds !== null) {
    // Rate-limited failures ride the fresh-message transport, like gate
    // waits: message.retry() would let the platform's max_retries=6
    // dead-letter a healthy job after six genuine GitHub rate limits.
    const delaySeconds = jitteredDelaySeconds(retryAfterSeconds, rng, 0.05);
    try {
      await env.PROVISIONING_QUEUE.send({ jobId: job.jobId }, { delaySeconds });
      return { outcome: 'acked' };
    } catch {
      return { outcome: 'retry', delaySeconds };
    }
  }
  return { outcome: 'retry', delaySeconds: jitteredDelaySeconds(provisioningRetryDelaySeconds(attempts), rng) };
}

/**
 * Persist the fact that a succeeded step's continuation could not be
 * enqueued. Mirrors `finishGithubCallback`'s `provisioning_enqueue_failed`
 * handling one level up, but stays retryable and non-terminal on purpose:
 * the step's success is already durable, so the only thing lost is the
 * handoff, and redelivery — or a manually re-sent `{ jobId }` — resumes from
 * the record exactly where it stopped. The breadcrumb is written onto the
 * next pending step and disappears when that step is next booked (either it
 * runs, or `recordStepFailure` rebuilds its bookkeeping), so it can never
 * outlive the stall it describes. A sustained producer outage still ends at
 * the platform's `max_retries`/dead-letter queue, which this breadcrumb
 * turns from an invisible stall into a visible one.
 */
async function recordEnqueueFailure(
  env: Pick<ProvisioningQueueEnv, 'JOBS'>,
  finalJob: ProvisioningJob,
  pendingStep: ProvisioningStepName,
  now: number,
): Promise<ProvisioningMessageOutcome> {
  const updated: ProvisioningJob = {
    ...finalJob,
    steps: {
      ...finalJob.steps,
      [pendingStep]: {
        ...finalJob.steps[pendingStep],
        lastError: { code: 'provisioning_enqueue_failed', retryable: true },
        updatedAt: now,
      },
    },
  };
  await saveProvisioningJob(env.JOBS, updated);
  return { outcome: 'retry', delaySeconds: PROVISIONING_ENQUEUE_RETRY_DELAY_SECONDS };
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
    rng = Math.random,
  } = runtime;

  const job = await loadProvisioningJob(env.JOBS, jobId);
  if (!job) {
    // KV is eventually consistent across locations, and a message may be
    // delivered before the record written just before it was enqueued is
    // visible. Redeliver rather than ack: a job that never materializes is
    // dead-lettered by the platform's retry ceiling instead of silently
    // dropped after its onboarding response already said "provisioning".
    return { outcome: 'retry', delaySeconds: PROVISIONING_LOCK_RETRY_DELAY_SECONDS };
  }
  if (isTerminalProvisioningStatus(job.status)) return { outcome: 'acked' };
  if (!job.data.notionSecretsWrittenAt) {
    // Unreachable through the normal path: a job is only ever enqueued after
    // the Notion callback has written the secrets. A message that arrives
    // anyway (a hand-sent `{ jobId }`, a stale KV read) waits rather than
    // running steps whose sync workflow would have no credentials.
    return { outcome: 'retry', delaySeconds: PROVISIONING_LOCK_RETRY_DELAY_SECONDS };
  }

  const locked = tryAcquireProvisioningLock(job, lockOwner(), now());
  if (!locked) return { outcome: 'retry', delaySeconds: PROVISIONING_LOCK_RETRY_DELAY_SECONDS };
  await saveProvisioningJob(env.JOBS, locked);

  const step = nextPendingStep(locked);
  if (!step) {
    const finishedMs = now();
    await saveTerminalProvisioningJob(env, { ...locked, status: 'succeeded', lock: null, completedAt: finishedMs, updatedAt: finishedMs });
    emitProvisioningEvent(env, {
      type: 'job_succeeded',
      jobId,
      ts: finishedMs,
      totalDurationMs: finishedMs - locked.createdAt,
    });
    return { outcome: 'acked' };
  }

  const gate = await gateProvisioningStep(env.JOBS, locked, step, provisioningThrottleConfig(env), now(), rng);
  if (gate.action === 'superseded') {
    const supersededMs = now();
    await saveTerminalProvisioningJob(env, {
      ...locked,
      status: 'failed',
      steps: {
        ...locked.steps,
        [step]: {
          ...locked.steps[step],
          status: 'failed',
          updatedAt: supersededMs,
          lastError: { code: 'github_provisioning_superseded', retryable: false },
        },
      },
      lock: null,
      updatedAt: supersededMs,
      completedAt: supersededMs,
    });
    return { outcome: 'acked' };
  }
  if (gate.action === 'wait') {
    const waitMs = now();
    await saveProvisioningJob(env.JOBS, {
      ...locked,
      status: 'queued',
      lock: null,
      wait: { reason: gate.reason, untilMs: waitMs + gate.delaySeconds * 1000, updatedAt: waitMs },
    });
    try {
      await env.PROVISIONING_QUEUE.send({ jobId }, { delaySeconds: gate.delaySeconds });
      return { outcome: 'acked' };
    } catch {
      return { outcome: 'retry', delaySeconds: gate.delaySeconds };
    }
  }

  // Before the token mint, so a mint failure still pairs a `step_started` with
  // a `step_failed` over the same interval every other failure path reports.
  const stepStartedMs = now();
  emitProvisioningEvent(env, {
    type: 'step_started',
    jobId,
    ts: stepStartedMs,
    step,
    attempt: locked.steps[step].attempts + 1,
  });

  let installationToken: Secret<'github-installation'>;
  try {
    installationToken = await createGithubInstallationToken(env, locked.installationId, fetcher);
  } catch (error) {
    return recordStepFailure(env, locked, step, error, now(), rng, stepStartedMs);
  }

  const inProgressMs = now();
  const inProgress: ProvisioningJob = {
    ...locked,
    wait: null,
    steps: { ...locked.steps, [step]: { ...locked.steps[step], status: 'in_progress', updatedAt: inProgressMs } },
  };
  await saveProvisioningJob(env.JOBS, inProgress);

  const ctx: StepRunnerContext = { jobs: env.JOBS, installationToken, fetcher, sleep, now };
  let stepSucceeded: ProvisioningJob;
  try {
    const patch = await PROVISIONING_STEP_HANDLERS[step](inProgress, ctx);
    const completionMs = now();
    stepSucceeded = {
      ...inProgress,
      data: { ...inProgress.data, ...patch },
      steps: {
        ...inProgress.steps,
        [step]: { status: 'succeeded', attempts: inProgress.steps[step].attempts + 1, updatedAt: completionMs, lastError: null },
      },
      lock: null,
      updatedAt: completionMs,
    };
  } catch (error) {
    return recordStepFailure(env, inProgress, step, error, now(), rng, stepStartedMs);
  }

  const remainingStep = nextPendingStep(stepSucceeded);
  const finalJob: ProvisioningJob = remainingStep
    ? { ...stepSucceeded, status: 'queued' }
    : { ...stepSucceeded, status: 'succeeded', completedAt: stepSucceeded.updatedAt };
  try {
    if (remainingStep) {
      await saveProvisioningJob(env.JOBS, finalJob);
    } else {
      // The job just reached its terminal status, so the terminal ⇒ release
      // invariant applies: this save also frees the account's provisioning
      // lease (and drops any wait breadcrumb).
      await saveTerminalProvisioningJob(env, finalJob);
    }
  } catch (error) {
    // Unlike the enqueue failure below, a KV write failure here means the
    // success was never persisted, so the step genuinely has to re-run:
    // route it through the standard failure path, which releases the lock
    // and resets the step to `pending`. That re-run is safe — six steps are
    // idempotent and `dispatch_sync`'s marker was persisted by the handler
    // itself, before its external call.
    return recordStepFailure(env, inProgress, step, error, now(), rng, stepStartedMs);
  }

  // After the save, not before: a KV write failure routes to
  // `recordStepFailure`, so one attempt never both succeeds and fails.
  emitProvisioningEvent(env, {
    type: 'step_succeeded',
    jobId,
    ts: stepSucceeded.updatedAt,
    step,
    attempt: stepSucceeded.steps[step].attempts,
    durationMs: stepSucceeded.updatedAt - stepStartedMs,
  });
  if (!remainingStep) {
    emitProvisioningEvent(env, {
      type: 'job_succeeded',
      jobId,
      ts: finalJob.updatedAt,
      totalDurationMs: finalJob.updatedAt - finalJob.createdAt,
    });
  }

  if (remainingStep) {
    try {
      await env.PROVISIONING_QUEUE.send({ jobId });
      return { outcome: 'acked' };
    } catch {
      // The step itself succeeded and that is already durable (saved just
      // above); only handing off the continuation failed. Ask the queue to
      // redeliver this same message rather than recording a step failure —
      // on redelivery the just-completed step is found already 'succeeded'
      // and is not re-run, so a transient enqueue failure does not double
      // the step's external effect, discard its result, or inflate its
      // attempt count. (If the redelivery's KV read is stale enough to
      // predate the saved success, the step re-runs — the handlers'
      // idempotency and the dispatch marker contain that case, exactly as
      // for the eventual-consistency redelivery at the top of this file.)
      return recordEnqueueFailure(env, finalJob, remainingStep, now());
    }
  }
  return { outcome: 'acked' };
}
