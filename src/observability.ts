import type { NotionOAuthErrorCode } from './notion-oauth';
import type { ProvisioningStepError, ProvisioningStepName } from './provisioning-job';

export type ProvisioningEventErrorCode = ProvisioningStepError['code'];

export interface ProvisioningEventBase {
  jobId: string;
  /** Epoch milliseconds, from the caller's injected clock. */
  ts: number;
}

export interface ConsentStartedEvent extends ProvisioningEventBase {
  type: 'consent_started';
  provider: 'notion';
}

export interface ConsentCompletedEvent extends ProvisioningEventBase {
  type: 'consent_completed';
  provider: 'notion';
  templateDuplicated: boolean;
}

export interface ConsentFailedEvent extends ProvisioningEventBase {
  type: 'consent_failed';
  provider: 'notion';
  errorCode: NotionOAuthErrorCode;
}

export interface JobQueuedEvent extends ProvisioningEventBase {
  type: 'job_queued';
}

export interface JobEnqueueFailedEvent extends ProvisioningEventBase {
  type: 'job_enqueue_failed';
  errorCode: 'provisioning_enqueue_failed';
}

export interface StepStartedEvent extends ProvisioningEventBase {
  type: 'step_started';
  step: ProvisioningStepName;
  attempt: number;
}

export interface StepSucceededEvent extends ProvisioningEventBase {
  type: 'step_succeeded';
  step: ProvisioningStepName;
  attempt: number;
  durationMs: number;
}

export interface StepFailedEvent extends ProvisioningEventBase {
  type: 'step_failed';
  step: ProvisioningStepName;
  attempt: number;
  errorCode: ProvisioningEventErrorCode;
  retryable: boolean;
  terminal: boolean;
  durationMs: number;
}

export interface RateLimitedEvent extends ProvisioningEventBase {
  type: 'rate_limited';
  step: ProvisioningStepName;
  errorCode: ProvisioningEventErrorCode;
  retryAfterSeconds: number;
}

export interface JobSucceededEvent extends ProvisioningEventBase {
  type: 'job_succeeded';
  totalDurationMs: number;
}

export interface JobDeadLetteredEvent extends ProvisioningEventBase {
  type: 'job_dead_lettered';
  step: ProvisioningStepName;
  errorCode: ProvisioningEventErrorCode;
  totalDurationMs: number;
}

/** No variant may carry a caught `Error`, a provider body, or a user identity.
 * `OBSERVABILITY_EVENT_FIELDS` below makes that a typecheck, not a convention. */
export type ProvisioningEvent =
  | ConsentStartedEvent
  | ConsentCompletedEvent
  | ConsentFailedEvent
  | JobQueuedEvent
  | JobEnqueueFailedEvent
  | StepStartedEvent
  | StepSucceededEvent
  | StepFailedEvent
  | RateLimitedEvent
  | JobSucceededEvent
  | JobDeadLetteredEvent;

/** Adding a field to any variant without listing its name here fails
 * `bun run typecheck` at `AllowlistedEventFields`. That failure is the prompt
 * to ask whether the new field can carry free text. */
export const OBSERVABILITY_EVENT_FIELDS = [
  'type',
  'jobId',
  'ts',
  'provider',
  'templateDuplicated',
  'errorCode',
  'step',
  'attempt',
  'durationMs',
  'retryable',
  'terminal',
  'retryAfterSeconds',
  'totalDurationMs',
] as const;

type AllowedEventField = (typeof OBSERVABILITY_EVENT_FIELDS)[number];

type EventFieldName = ProvisioningEvent extends infer Variant
  ? Variant extends object ? keyof Variant : never
  : never;

type AllowlistedEventFields<Field extends AllowedEventField> = Field;

type _EveryEventFieldIsAllowlisted = AllowlistedEventFields<EventFieldName>;

export interface ObservabilityEnv {
  PROVISIONING_METRICS?: AnalyticsEngineDataset;
}

function eventDataPoint(event: ProvisioningEvent): AnalyticsEngineDataPoint {
  const indexes = [event.type];
  switch (event.type) {
    case 'consent_started':
      return { blobs: [event.type, event.jobId, event.provider], doubles: [event.ts], indexes };
    case 'consent_completed':
      return {
        blobs: [event.type, event.jobId, event.provider],
        doubles: [event.ts, event.templateDuplicated ? 1 : 0],
        indexes,
      };
    case 'consent_failed':
      return {
        blobs: [event.type, event.jobId, event.errorCode, event.provider],
        doubles: [event.ts],
        indexes,
      };
    case 'job_queued':
      return { blobs: [event.type, event.jobId], doubles: [event.ts], indexes };
    case 'job_enqueue_failed':
      return { blobs: [event.type, event.jobId, event.errorCode], doubles: [event.ts], indexes };
    case 'step_started':
      return { blobs: [event.type, event.jobId, event.step], doubles: [event.ts, event.attempt], indexes };
    case 'step_succeeded':
      return {
        blobs: [event.type, event.jobId, event.step],
        doubles: [event.ts, event.attempt, event.durationMs],
        indexes,
      };
    case 'step_failed':
      return {
        blobs: [event.type, event.jobId, event.step, event.errorCode],
        doubles: [event.ts, event.attempt, event.durationMs, event.retryable ? 1 : 0, event.terminal ? 1 : 0],
        indexes,
      };
    case 'rate_limited':
      return {
        blobs: [event.type, event.jobId, event.step, event.errorCode],
        doubles: [event.ts, event.retryAfterSeconds],
        indexes,
      };
    case 'job_succeeded':
      // `verify_deploy` is last in `PROVISIONING_STEP_ORDER`, so this event is
      // also the funnel's first-successful-deploy metric.
      return { blobs: [event.type, event.jobId], doubles: [event.ts, event.totalDurationMs], indexes };
    case 'job_dead_lettered':
      return {
        blobs: [event.type, event.jobId, event.step, event.errorCode],
        doubles: [event.ts, event.totalDurationMs],
        indexes,
      };
  }
}

/** Record one funnel event to both sinks. Never throws. */
export function emitProvisioningEvent(env: ObservabilityEnv, event: ProvisioningEvent): void {
  console.log(JSON.stringify(event));

  const dataset = env.PROVISIONING_METRICS;
  if (!dataset) return;
  try {
    dataset.writeDataPoint(eventDataPoint(event));
  } catch {
    // A metrics sink must never fail the operation it observes; the log line
    // above already recorded this event.
  }
}
