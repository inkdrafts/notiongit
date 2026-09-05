/**
 * Public progress projection over a durable provisioning job.
 *
 * The KV job record is the sole source of truth for progress; this module is
 * the only place job state becomes browser-facing copy. Leak safety is
 * structural: every string in the projection is a registry label or headline,
 * verbatim taxonomy copy, the fixed wait sentence, or one of the allowlisted
 * repository/site identity fields the flow already exposes. Nothing else from
 * the record — installation id, identity, lock, provider breadcrumbs — has a
 * path into the output.
 */

import {
  nextPendingStep,
  PROVISIONING_STEP_ORDER,
  type ProvisioningJob,
  type ProvisioningStepName,
} from './provisioning-job';
import { FAILURE_REGISTRY, userCopy, type ProvisioningFailureCode } from './failures';

export const PROGRESS_STAGE_ORDER = [
  'github_connected', 'repository_created', 'notion_connected',
  'settings_prepared', 'publishing_enabled', 'content_synced', 'site_published',
] as const;

export type ProgressStageId = (typeof PROGRESS_STAGE_ORDER)[number];

export interface ProgressStageEntry {
  readonly label: string;
  readonly headline: string;
}

export const PROGRESS_STAGE_REGISTRY: { [S in ProgressStageId]: ProgressStageEntry } = {
  github_connected: { label: 'Connect GitHub', headline: 'Connecting your GitHub account.' },
  repository_created: { label: 'Create your repository', headline: 'Creating your repository.' },
  notion_connected: { label: 'Connect Notion', headline: 'Connecting Notion.' },
  settings_prepared: { label: 'Prepare site settings', headline: 'Preparing your site settings.' },
  publishing_enabled: { label: 'Enable publishing', headline: 'Enabling GitHub Pages publishing.' },
  content_synced: { label: 'Copy your content', headline: 'Copying your Notion content.' },
  site_published: { label: 'Publish your site', headline: 'Publishing your site.' },
};

/** Machine step to public stage. A new step fails typecheck until it declares
 * its human stage here, so the checklist can never miss one. */
export const STAGE_BY_STEP: { [S in ProvisioningStepName]: ProgressStageId } = {
  verify_repository: 'settings_prepared',
  patch_config: 'settings_prepared',
  configure_pages: 'publishing_enabled',
  dispatch_sync: 'content_synced',
  await_sync: 'content_synced',
  await_deploy_build: 'site_published',
  verify_deploy: 'site_published',
};

export type ProgressStageState = 'done' | 'current' | 'pending' | 'blocked';

export interface ProgressStageView {
  readonly id: ProgressStageId;
  readonly label: string;
  readonly state: ProgressStageState;
}

export type PublicProgress =
  | { readonly status: 'awaiting_notion'; readonly stages: readonly ProgressStageView[] }
  | { readonly status: 'active'; readonly stages: readonly ProgressStageView[];
      readonly notice: { readonly message: string; readonly action: string } | null;
      readonly pollAfterSeconds: number | null }
  | { readonly status: 'succeeded'; readonly stages: readonly ProgressStageView[];
      readonly repository: { readonly name: string; readonly url: string };
      readonly site: { readonly url: string };
      readonly notionLinks: {
        readonly pagesUrl: string | null;
        readonly postsUrl: string | null;
        readonly templateRootUrl: string | null;
      } }
  | { readonly status: 'failed'; readonly stages: readonly ProgressStageView[];
      readonly message: string; readonly action: string;
      readonly restartUrl: string | null }
  | { readonly status: 'missing'; readonly message: string; readonly action: string;
      readonly restartUrl: string };

export interface ProgressSnapshot {
  /** `job.updatedAt`; 0 when missing. The client's monotonic guard against
   * stale KV reads. */
  readonly updatedAt: number;
  readonly progress: PublicProgress;
}

/** A wait is a stall the queue resolves on its own, never a failure, so it
 * gets its own sentence instead of taxonomy copy. */
const WAIT_NOTICE: { readonly message: string; readonly action: string } = {
  message: 'Your setup is waiting for a free provisioning slot and will continue automatically.',
  action: 'No action is needed. This page updates itself.',
};

const MISSING_COPY = userCopy('provisioning_job_missing');
const RESTART_URL = '/connect/github';
const LAST_STEP = PROVISIONING_STEP_ORDER[PROVISIONING_STEP_ORDER.length - 1];

/** Stand-in for a job resolved before canonical-URL capture existed: every
 * Notion link renders as its linkless fallback copy. */
const NULL_NOTION_LINKS: Extract<PublicProgress, { status: 'succeeded' }>['notionLinks'] = {
  pagesUrl: null,
  postsUrl: null,
  templateRootUrl: null,
};

export function progressPageUrl(jobId: string): string {
  return `/progress?job_id=${encodeURIComponent(jobId)}`;
}

function stageIndex(id: ProgressStageId): number {
  return PROGRESS_STAGE_ORDER.indexOf(id);
}

function stageViewsAt(currentIndex: number, blocked = false): ProgressStageView[] {
  return PROGRESS_STAGE_ORDER.map((id, index) => ({
    id,
    label: PROGRESS_STAGE_REGISTRY[id].label,
    state: index < currentIndex ? 'done'
      : index === currentIndex ? (blocked ? 'blocked' : 'current')
        : 'pending',
  }));
}

function stageViews(currentStageId: ProgressStageId, blocked = false): ProgressStageView[] {
  return stageViewsAt(stageIndex(currentStageId), blocked);
}

function failedStepOf(job: ProvisioningJob): ProvisioningStepName | null {
  return PROVISIONING_STEP_ORDER.find((step) => job.steps[step].status === 'failed') ?? null;
}

export function projectProvisioning(job: ProvisioningJob | null, now: number): ProgressSnapshot {
  if (!job) {
    return {
      updatedAt: 0,
      progress: {
        status: 'missing',
        message: MISSING_COPY.message,
        action: MISSING_COPY.action,
        restartUrl: RESTART_URL,
      },
    };
  }

  if (job.status === 'succeeded') {
    return {
      updatedAt: job.updatedAt,
      progress: {
        status: 'succeeded',
        stages: stageViewsAt(PROGRESS_STAGE_ORDER.length),
        repository: { name: job.data.generatedRepository.name, url: job.data.generatedRepository.htmlUrl },
        site: { url: job.data.repository.url },
        notionLinks: job.data.notionLinks ?? NULL_NOTION_LINKS,
      },
    };
  }

  if (job.status === 'failed' || job.status === 'dead_letter') {
    // Both dead-lettering and the supersession gate write status 'failed' on
    // the step, so the step search is the one lookup; the fallback code keeps
    // the projection total for a record that predates its own failure.
    const step = failedStepOf(job) ?? nextPendingStep(job) ?? LAST_STEP;
    const code = job.steps[step].lastError?.code ?? 'provisioning_step_failed';
    const copy = userCopy(code);
    return {
      updatedAt: job.updatedAt,
      progress: {
        status: 'failed',
        stages: stageViews(STAGE_BY_STEP[step], true),
        message: copy.message,
        action: copy.action,
        restartUrl: FAILURE_REGISTRY[code].recovery === 'restart_flow' ? RESTART_URL : null,
      },
    };
  }

  if (job.status === 'awaiting_notion') {
    // The secrets timestamp, not the status, says whether the Notion stage is
    // finished: a stale read may still show it as current, but a written job
    // never shows it as pending.
    const current: ProgressStageId = job.data.notionSecretsWrittenAt ? 'settings_prepared' : 'notion_connected';
    return {
      updatedAt: job.updatedAt,
      progress: { status: 'awaiting_notion', stages: stageViews(current) },
    };
  }

  // queued, running, and paused are live states: the job is advancing or
  // parked on a wait the queue resolves by itself.
  const step = nextPendingStep(job) ?? LAST_STEP;
  const stepError = job.steps[step].lastError;
  const notice = stepError ? userCopy(stepError.code) : job.wait ? WAIT_NOTICE : null;
  const pollAfterSeconds = job.wait?.untilMs == null
    ? null
    : Math.max(1, Math.ceil((job.wait.untilMs - now) / 1000));
  return {
    updatedAt: job.updatedAt,
    progress: {
      status: 'active',
      stages: stageViews(STAGE_BY_STEP[step]),
      notice,
      pollAfterSeconds,
    },
  };
}
