/**
 * Step handlers for the durable provisioning queue.
 *
 * Every handler receives a freshly minted installation token (never
 * persisted — see `github-app-auth.ts`) and the job's current non-secret
 * state, and returns only the fields of `ProvisioningJobData` it advances.
 * Every handler other than `runDispatchSync` is a thin wrapper around an
 * already-idempotent provider call: retrying it after a crash reproduces
 * the same result instead of a duplicate mutation.
 */

import { patchRepositoryConfig } from './repository-config';
import { configureGithubPages } from './github-pages';
import { awaitGeneratedRepositoryCommit } from './repository-generation';
import {
  awaitNotionSyncRun,
  correlateDispatchedSyncRun,
  dispatchNotionSyncWorkflow,
  listWorkflowRunIds,
} from './notion-sync';
import {
  awaitPagesBuildForCommit,
  getRepositoryMainHeadSha,
  verifyPublicSiteReachable,
  GithubDeployError,
} from './site-deployment';
import {
  saveProvisioningJob,
  type ProvisioningJob,
  type ProvisioningJobData,
  type ProvisioningStepName,
} from './provisioning-job';
import type { Secret } from './secret';

export interface StepRunnerContext {
  jobs: KVNamespace;
  installationToken: Secret<'github-installation'>;
  fetcher: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
}

export type ProvisioningStepHandler = (
  job: ProvisioningJob,
  ctx: StepRunnerContext,
) => Promise<Partial<ProvisioningJobData>>;

async function runVerifyRepository(job: ProvisioningJob, ctx: StepRunnerContext): Promise<Partial<ProvisioningJobData>> {
  const usable = await awaitGeneratedRepositoryCommit(
    ctx.installationToken.bearer(),
    job.data.generatedRepository.fullName,
    { fetcher: ctx.fetcher, sleep: ctx.sleep },
  );
  return {
    generatedRepository: {
      ...job.data.generatedRepository,
      headSha: usable.headSha,
      headTreeSha: usable.headTreeSha,
    },
  };
}

async function runPatchConfig(job: ProvisioningJob, ctx: StepRunnerContext): Promise<Partial<ProvisioningJobData>> {
  await patchRepositoryConfig(
    ctx.installationToken.raw,
    job.data.generatedRepository.fullName,
    job.data.repository,
    { fetcher: ctx.fetcher },
  );
  return {};
}

async function runConfigurePages(job: ProvisioningJob, ctx: StepRunnerContext): Promise<Partial<ProvisioningJobData>> {
  const pages = await configureGithubPages(
    ctx.installationToken.raw,
    job.data.generatedRepository.fullName,
    { fetcher: ctx.fetcher, sleep: ctx.sleep },
  );
  return { pages };
}

async function runDispatchSync(job: ProvisioningJob, ctx: StepRunnerContext): Promise<Partial<ProvisioningJobData>> {
  // The sync workflow reads the three Actions secrets. Without them GitHub
  // runs it anyway and reports success, so fail loudly instead.
  if (!job.data.notionSecretsWrittenAt) throw new Error('dispatch_sync ran before Notion secrets were written');
  const fullName = job.data.generatedRepository.fullName;
  if (job.data.sync) return {};

  const marker = job.data.syncDispatchMarker;
  if (marker) {
    // A previous attempt reached (or was about to reach) the dispatch call
    // and crashed before recording the correlated run. Resume by
    // correlating the persisted window instead of dispatching again.
    const correlated = await correlateDispatchedSyncRun(
      ctx.installationToken.raw,
      fullName,
      new Set(marker.excludedRunIds),
      marker.dispatchedAtMs,
      { fetcher: ctx.fetcher, sleep: ctx.sleep },
    );
    return {
      sync: { runId: correlated.runId, htmlUrl: correlated.htmlUrl, conclusion: null },
      syncDispatchMarker: null,
    };
  }

  const excludedRunIds = await listWorkflowRunIds(ctx.installationToken.raw, fullName, ctx.fetcher);
  const dispatchedAtMs = ctx.now();
  // Persist the marker before dispatching. A crash after the POST succeeds
  // but before this function returns still resumes by correlating the same
  // window on the *next sequential attempt* — never by dispatching a
  // second run. (A crash between this write and the POST itself is the one
  // gap this cannot close without a transactional outbox: the next attempt
  // will see the marker, find no matching run, and time out. That is a
  // bounded, visible failure — not a silent duplicate.) This does not
  // protect against two invocations that are genuinely in flight at the
  // same time: each reads the job's marker as `null` from its own
  // in-memory snapshot before either has written, so both can reach this
  // branch. See the compare-and-swap limitation documented on
  // `tryAcquireProvisioningLock` in `provisioning-job.ts`.
  await saveProvisioningJob(ctx.jobs, {
    ...job,
    data: { ...job.data, syncDispatchMarker: { excludedRunIds: [...excludedRunIds], dispatchedAtMs } },
    updatedAt: ctx.now(),
  });
  await dispatchNotionSyncWorkflow(ctx.installationToken.raw, fullName, ctx.fetcher);
  const correlated = await correlateDispatchedSyncRun(
    ctx.installationToken.raw,
    fullName,
    excludedRunIds,
    dispatchedAtMs,
    { fetcher: ctx.fetcher, sleep: ctx.sleep },
  );
  return {
    sync: { runId: correlated.runId, htmlUrl: correlated.htmlUrl, conclusion: null },
    syncDispatchMarker: null,
  };
}

async function runAwaitSync(job: ProvisioningJob, ctx: StepRunnerContext): Promise<Partial<ProvisioningJobData>> {
  const sync = job.data.sync;
  if (!sync) throw new Error('await_sync ran before dispatch_sync recorded a run');
  const run = await awaitNotionSyncRun(
    ctx.installationToken.raw,
    job.data.generatedRepository.fullName,
    sync.runId,
    { fetcher: ctx.fetcher, sleep: ctx.sleep },
  );
  return { sync: { runId: run.runId, htmlUrl: run.htmlUrl, conclusion: run.conclusion } };
}

async function runAwaitDeployBuild(job: ProvisioningJob, ctx: StepRunnerContext): Promise<Partial<ProvisioningJobData>> {
  const fullName = job.data.generatedRepository.fullName;
  const commitSha = await getRepositoryMainHeadSha(ctx.installationToken.raw, fullName, ctx.fetcher);
  const build = await awaitPagesBuildForCommit(
    ctx.installationToken.raw,
    fullName,
    commitSha,
    { fetcher: ctx.fetcher, sleep: ctx.sleep },
  );
  return { deployment: { commitSha, buildId: build.buildId, status: build.status, verifiedAt: null } };
}

async function runVerifyDeploy(job: ProvisioningJob, ctx: StepRunnerContext): Promise<Partial<ProvisioningJobData>> {
  const htmlUrl = job.data.pages?.htmlUrl;
  const deployment = job.data.deployment;
  if (!htmlUrl || !deployment) throw new GithubDeployError('github_deploy_unavailable', 502);
  await verifyPublicSiteReachable(htmlUrl, { fetcher: ctx.fetcher, sleep: ctx.sleep });
  return { deployment: { ...deployment, verifiedAt: ctx.now() } };
}

export const PROVISIONING_STEP_HANDLERS: Record<ProvisioningStepName, ProvisioningStepHandler> = {
  verify_repository: runVerifyRepository,
  patch_config: runPatchConfig,
  configure_pages: runConfigurePages,
  dispatch_sync: runDispatchSync,
  await_sync: runAwaitSync,
  await_deploy_build: runAwaitDeployBuild,
  verify_deploy: runVerifyDeploy,
};
