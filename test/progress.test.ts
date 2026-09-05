import { describe, expect, test } from 'bun:test';

import { FAILURE_REGISTRY, userCopy, type ProvisioningFailureCode } from '../src/failures';
import {
  createProvisioningJob,
  PROVISIONING_STEP_ORDER,
  type ProvisioningJob,
  type ProvisioningJobStatus,
  type ProvisioningStepName,
} from '../src/provisioning-job';
import {
  projectProvisioning,
  progressPageUrl,
  PROGRESS_STAGE_ORDER,
  STAGE_BY_STEP,
  type ProgressSnapshot,
} from '../src/progress';

const NOW = 1_000_000;

/** Values that must never reach the projection, planted where the record
 * carries them. */
const SENTINELS = {
  installationId: 987654321,
  login: 'sentinel-login',
  lockOwner: 'sentinel-lock-owner',
  runId: 555444333,
  commitSha: 'sentinel-commit-sha',
};

interface JobOptions {
  completedSteps?: number;
  failedStep?: ProvisioningStepName;
  code?: ProvisioningFailureCode;
  waitUntilMs?: number | null;
  waitReason?: 'global_throttled' | 'operator_paused' | 'stage_paused';
  secretsWritten?: boolean;
  kind?: 'apex' | 'project';
  notionLinks?: { pagesUrl: string | null; postsUrl: string | null; templateRootUrl: string | null };
}

function makeJob(status: ProvisioningJobStatus, options: JobOptions = {}): ProvisioningJob {
  const project = options.kind === 'project';
  const job = createProvisioningJob({
    jobId: 'job-123',
    installationId: SENTINELS.installationId,
    identity: { id: 42, login: SENTINELS.login, accountType: 'User' },
    repository: project
      ? { name: 'alice-inkdrafts', url: 'https://alice.github.io/alice-inkdrafts', baseurl: '/alice-inkdrafts', kind: 'project' }
      : { name: 'alice.github.io', url: 'https://alice.github.io', baseurl: '', kind: 'apex' },
    generatedRepository: {
      id: 1001,
      fullName: project ? 'alice/alice-inkdrafts' : 'alice/alice.github.io',
      name: project ? 'alice-inkdrafts' : 'alice.github.io',
      htmlUrl: project ? 'https://github.com/alice/alice-inkdrafts' : 'https://github.com/alice/alice.github.io',
      defaultBranch: 'main',
      templateFullName: 'inkdrafts/notiongit-template',
      templateHeadSha: 'template-head-sha',
      templateHeadTreeSha: 'template-tree-sha',
      headSha: null,
      headTreeSha: null,
      reused: false,
    },
    now: NOW,
  });

  const completed = options.completedSteps ?? 0;
  const steps = { ...job.steps };
  PROVISIONING_STEP_ORDER.forEach((step, index) => {
    if (index < completed) steps[step] = { ...steps[step], status: 'succeeded', attempts: 1 };
  });
  if (options.failedStep) {
    const code = options.code ?? 'provisioning_step_failed';
    steps[options.failedStep] = {
      ...steps[options.failedStep],
      status: 'failed',
      attempts: 5,
      lastError: { code, retryable: FAILURE_REGISTRY[code].retryable },
    };
  }

  const enqueued = status !== 'awaiting_notion';
  return {
    ...job,
    status,
    steps,
    lock: enqueued ? { owner: SENTINELS.lockOwner, acquiredAt: NOW, expiresAt: NOW + 300_000 } : null,
    wait: options.waitUntilMs === undefined && options.waitReason === undefined ? null : {
      reason: options.waitReason ?? 'global_throttled',
      untilMs: options.waitUntilMs === undefined ? NOW + 90_000 : options.waitUntilMs,
      updatedAt: NOW,
    },
    data: {
      ...job.data,
      notionSecretsWrittenAt: (options.secretsWritten ?? enqueued) ? NOW + 1 : null,
      notionLinks: options.notionLinks ?? null,
      sync: { runId: SENTINELS.runId, htmlUrl: 'sentinel-run-url', conclusion: null },
      deployment: { commitSha: SENTINELS.commitSha, buildId: null, status: 'building', verifiedAt: null },
    },
    updatedAt: NOW + 2,
    completedAt: status === 'succeeded' || status === 'failed' || status === 'dead_letter' ? NOW + 2 : null,
  };
}

function stageStates(snapshot: ProgressSnapshot): string[] {
  return snapshot.progress.stages.map((stage) => stage.state);
}

const ALL_PENDING = ['pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending'];

describe('progress projection', () => {
  test('every job status and a missing record project onto their public variant', () => {
    const enqueuedPattern = ['done', 'done', 'done', 'current', 'pending', 'pending', 'pending'];

    const missing = projectProvisioning(null, NOW);
    expect(missing).toEqual({
      updatedAt: 0,
      progress: {
        status: 'missing',
        message: userCopy('provisioning_job_missing').message,
        action: userCopy('provisioning_job_missing').action,
        restartUrl: '/connect/github',
      },
    });

    const awaiting = projectProvisioning(makeJob('awaiting_notion', { secretsWritten: false }), NOW);
    expect(awaiting.progress.status).toBe('awaiting_notion');
    expect(stageStates(awaiting)).toEqual(['done', 'done', 'current', ...ALL_PENDING.slice(3)]);
    expect(awaiting.updatedAt).toBe(NOW + 2);

    expect(stageStates(projectProvisioning(makeJob('awaiting_notion', { secretsWritten: true }), NOW)))
      .toEqual(['done', 'done', 'done', 'current', 'pending', 'pending', 'pending']);

    for (const status of ['queued', 'running', 'paused'] as const) {
      const active = projectProvisioning(makeJob(status), NOW);
      expect(active.progress.status).toBe('active');
      expect(stageStates(active)).toEqual(enqueuedPattern);
    }

    const running = projectProvisioning(makeJob('running', { completedSteps: 3 }), NOW);
    expect(stageStates(running)).toEqual(['done', 'done', 'done', 'done', 'done', 'current', 'pending']);

    const succeeded = projectProvisioning(makeJob('succeeded', { completedSteps: 7 }), NOW);
    expect(succeeded.progress.status).toBe('succeeded');
    expect(stageStates(succeeded)).toEqual(ALL_PENDING.map(() => 'done'));
  });

  test('succeeded exposes only the allowlisted identity, site, and canonical Notion links', () => {
    const snapshot = projectProvisioning(makeJob('succeeded', {
      completedSteps: 7,
      notionLinks: {
        pagesUrl: 'https://www.notion.so/alice/Pages-1',
        postsUrl: 'https://www.notion.so/alice/Posts-2',
        templateRootUrl: 'https://www.notion.so/alice/Home-3',
      },
    }), NOW);
    expect(snapshot.progress).toEqual({
      status: 'succeeded',
      stages: expect.any(Array),
      repository: { name: 'alice.github.io', url: 'https://github.com/alice/alice.github.io' },
      site: { url: 'https://alice.github.io' },
      notionLinks: {
        pagesUrl: 'https://www.notion.so/alice/Pages-1',
        postsUrl: 'https://www.notion.so/alice/Posts-2',
        templateRootUrl: 'https://www.notion.so/alice/Home-3',
      },
    });
  });

  test('a succeeded record written before URL capture projects all-null links', () => {
    const snapshot = projectProvisioning(makeJob('succeeded', { completedSteps: 7 }), NOW);
    expect(snapshot.progress).toMatchObject({
      status: 'succeeded',
      notionLinks: { pagesUrl: null, postsUrl: null, templateRootUrl: null },
    });
  });

  test('apex and project destinations each expose their own site URL branch', () => {
    const apex = projectProvisioning(makeJob('succeeded', { completedSteps: 7, kind: 'apex' }), NOW);
    expect(apex.progress).toMatchObject({
      status: 'succeeded',
      site: { url: 'https://alice.github.io' },
      repository: { name: 'alice.github.io', url: 'https://github.com/alice/alice.github.io' },
    });

    const project = projectProvisioning(makeJob('succeeded', { completedSteps: 7, kind: 'project' }), NOW);
    expect(project.progress).toMatchObject({
      status: 'succeeded',
      site: { url: 'https://alice.github.io/alice-inkdrafts' },
      repository: { name: 'alice-inkdrafts', url: 'https://github.com/alice/alice-inkdrafts' },
    });
  });

  test('a gate wait reports the wait sentence and a server cadence hint', () => {
    const waiting = projectProvisioning(makeJob('queued', { waitUntilMs: NOW + 90_000 }), NOW);
    expect(waiting.progress).toMatchObject({
      status: 'active',
      notice: {
        message: 'Your setup is waiting for a free provisioning slot and will continue automatically.',
        action: 'No action is needed. This page updates itself.',
      },
      pollAfterSeconds: 90,
    });

    const openEnded = projectProvisioning(makeJob('queued', { waitUntilMs: null }), NOW);
    expect(openEnded.progress).toMatchObject({ status: 'active', pollAfterSeconds: null });

    const overdue = projectProvisioning(makeJob('queued', { waitUntilMs: NOW - 5_000 }), NOW);
    expect(overdue.progress).toMatchObject({ status: 'active', pollAfterSeconds: 1 });

    const plain = projectProvisioning(makeJob('running'), NOW);
    expect(plain.progress).toMatchObject({ status: 'active', notice: null, pollAfterSeconds: null });
  });

  test('a retryable step failure surfaces as taxonomy copy while the job stays active', () => {
    const job = { ...makeJob('running'), wait: null };
    job.steps.verify_repository = {
      ...job.steps.verify_repository,
      lastError: { code: 'github_rate_limited', retryable: true },
    };

    const snapshot = projectProvisioning(job, NOW);
    expect(snapshot.progress).toMatchObject({
      status: 'active',
      notice: userCopy('github_rate_limited'),
      pollAfterSeconds: null,
    });
  });

  test('taxonomy copy wins over the wait sentence when both apply', () => {
    const job = makeJob('queued', { waitUntilMs: NOW + 90_000 });
    job.steps.verify_repository = {
      ...job.steps.verify_repository,
      lastError: { code: 'github_config_unavailable', retryable: true },
    };
    expect(projectProvisioning(job, NOW).progress).toMatchObject({ notice: userCopy('github_config_unavailable') });
  });

  test('terminal failures show the failed stage as blocked with taxonomy copy and a recovery-dependent restart', () => {
    const pattern = ['done', 'done', 'done', 'blocked', 'pending', 'pending', 'pending'];

    const retryable = projectProvisioning(
      makeJob('dead_letter', { failedStep: 'verify_repository', code: 'github_rate_limited' }),
      NOW,
    );
    expect(retryable.progress.status).toBe('failed');
    expect(stageStates(retryable)).toEqual(pattern);
    expect(retryable.progress).toMatchObject({
      message: userCopy('github_rate_limited').message,
      action: userCopy('github_rate_limited').action,
      restartUrl: null,
    });

    const restarting = projectProvisioning(
      makeJob('dead_letter', { failedStep: 'await_sync', code: 'github_sync_run_failed' }),
      NOW,
    );
    expect(stageStates(restarting)).toEqual([
      'done', 'done', 'done', 'done', 'done', 'blocked', 'pending',
    ]);
    expect(restarting.progress).toMatchObject({ restartUrl: '/connect/github' });
  });

  test('a superseded job is a failure without a restart link', () => {
    const superseded = projectProvisioning(
      makeJob('failed', { failedStep: 'dispatch_sync', code: 'github_provisioning_superseded' }),
      NOW,
    );
    expect(superseded.progress.status).toBe('failed');
    expect(superseded.progress).toMatchObject({
      message: userCopy('github_provisioning_superseded').message,
      restartUrl: null,
    });
  });

  test('a failed record with no failed step still projects total copy from the fallback code', () => {
    const snapshot = projectProvisioning(
      { ...makeJob('failed', { secretsWritten: true }), steps: makeJob('queued').steps },
      NOW,
    );
    expect(snapshot.progress.status).toBe('failed');
    expect(snapshot.progress).toMatchObject(userCopy('provisioning_step_failed'));
  });

  test('every taxonomy code yields its own exact copy on a dead-letter record', () => {
    for (const code of Object.keys(FAILURE_REGISTRY) as ProvisioningFailureCode[]) {
      const snapshot = projectProvisioning(
        makeJob('dead_letter', { failedStep: 'verify_repository', code }),
        NOW,
      );
      expect(snapshot.progress.status).toBe('failed');
      expect(snapshot.progress).toMatchObject({
        message: userCopy(code).message,
        action: userCopy(code).action,
      });
    }
  });

  test('no field outside the allowlist reaches the serialized snapshot', () => {
    const statuses = ['awaiting_notion', 'queued', 'running', 'paused', 'succeeded', 'failed', 'dead_letter'] as const;
    for (const status of statuses) {
      const job = makeJob(status, { completedSteps: 3, failedStep: status === 'failed' ? 'dispatch_sync' : undefined });
      const serialized = JSON.stringify(projectProvisioning(job, NOW));
      expect(serialized).not.toContain(String(SENTINELS.installationId));
      expect(serialized).not.toContain(SENTINELS.login);
      expect(serialized).not.toContain(SENTINELS.lockOwner);
      expect(serialized).not.toContain(String(SENTINELS.runId));
      expect(serialized).not.toContain(SENTINELS.commitSha);
      expect(serialized).not.toContain('sentinel-run-url');
    }
  });

  test('the step-to-stage mapping is pinned so a remap is a visible diff', () => {
    const expected: Array<[ProvisioningStepName, string]> = [
      ['verify_repository', 'settings_prepared'],
      ['patch_config', 'settings_prepared'],
      ['configure_pages', 'publishing_enabled'],
      ['dispatch_sync', 'content_synced'],
      ['await_sync', 'content_synced'],
      ['await_deploy_build', 'site_published'],
      ['verify_deploy', 'site_published'],
    ];
    expect(Object.keys(STAGE_BY_STEP).sort()).toEqual([...PROVISIONING_STEP_ORDER].sort());
    for (const [step, stage] of expected) {
      expect(STAGE_BY_STEP[step]).toBe(stage);
      const job = makeJob('running', { completedSteps: PROVISIONING_STEP_ORDER.indexOf(step) });
      const current = projectProvisioning(job, NOW).progress.stages.find((entry) => entry.state === 'current');
      expect(current?.id).toBe(stage);
    }
    expect(PROGRESS_STAGE_ORDER).toHaveLength(7);
  });

  test('the progress page URL has one home and encodes the job id', () => {
    expect(progressPageUrl('job-123')).toBe('/progress?job_id=job-123');
    expect(progressPageUrl('a/b c')).toBe('/progress?job_id=a%2Fb%20c');
  });
});
