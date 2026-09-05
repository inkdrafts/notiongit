/**
 * InkDrafts' edge entrypoint.
 *
 * GitHub's OAuth code and all access tokens are deliberately kept inside the
 * request that uses them. KV contains only signed-state replay markers,
 * validated non-secret Notion schema metadata, and the resulting GitHub
 * identity/installation, destination, and generated repository metadata.
 */

import {
  GithubRepositoryApiError,
  listOwnedGithubRepositories,
  type RepositoryDestination,
} from './repository-naming';
import {
  generateOrReuseRepository,
  type GeneratedRepositoryIdentity,
  type GenerateOrReuseOptions,
} from './repository-generation';
import {
  GithubActionsSecretsError,
  writeGithubActionsSecrets,
} from './actions-secrets';
import {
  createGithubInstallationToken,
  getAppInstallation,
  GithubAppAuthError,
  type GithubInstallationAccount,
} from './github-app-auth';
import {
  createProvisioningJob,
  isSucceededProvisioningJob,
  loadProvisioningJob,
  saveProvisioningJob,
  type NotionTemplateLinks,
} from './provisioning-job';
import { callbackFailure, codedFailureCode, FlowFailure } from './failures';
import {
  assertUsablePersonalInstallation,
  exchangeGithubCode,
  findUserInstallation,
  getAuthenticatedGithubUser,
  GithubApiError,
  getUserInstallation,
} from './github-user-auth';
import { payloadExpired, signSignedPayload, verifySignedPayload } from './signed-payload';
import {
  admitProvisioningAccount,
  admitProvisioningCallback,
  admitProvisioningRequest,
  admitProvisioningStage,
  acquireProvisioningStart,
  admissionFailureCode,
  consumeGlobalMutationBudget,
  ProvisioningAdmissionRefusedError,
  ProvisioningGateRefusedError,
  provisioningAdmissionConfig,
  provisioningThrottleConfig,
  recordProvisioningIdentityDenial,
  releaseProvisioningLeaseIfOwned,
  type ProvisioningThrottleVars,
} from './provisioning-throttle';
import { processProvisioningMessage } from './provisioning-queue';
import { emitProvisioningEvent } from './observability';
import { runObservabilityAlertCheck } from './observability-alerts';
import {
  beginNotionAuthorization,
  finishNotionCallback,
  NotionOAuthError,
  type NotionOAuthContinuationHandler,
  type NotionOAuthErrorCode,
  type NotionOAuthRouteOptions,
} from './notion-oauth';
import {
  NotionTemplateError,
  resolveNotionTemplateDatabases,
  saveNotionTemplateResolution,
} from './notion-template';
import { LANDING_PAGE } from './landing-page';
import { progressPageUrl, projectProvisioning } from './progress';
import { progressPage, type SiteCheckOutcome } from './progress-page';
import { checkPublicSiteReachable } from './site-deployment';
import { isStatusCallbackState, statusCallback, statusHome, statusRerun } from './status';
import { reportError } from './safe-serialize';
export {
  createRepositoryWithRetry,
  GithubRepositoryApiError,
  GithubRepositoryNameCollisionError,
  isGithubRepositoryNameCollision,
  isValidGithubRepositoryName,
  listOwnedGithubRepositories,
  repositoryDestination,
  selectGithubRepositoryDestination,
  selectRepositoryDestination,
} from './repository-naming';
export type { RepositoryDestination } from './repository-naming';

export {
  awaitGeneratedRepositoryCommit,
  findReusableGeneratedRepository,
  GENERATED_REPOSITORY_DESCRIPTION,
  generateOrReuseRepository,
  generateRepositoryFromTemplate,
  getTemplateHead,
  GithubGenerateError,
  isInkdraftsGeneratedRepository,
  reuseCollidingRepository,
  TEMPLATE_REPOSITORY_FULL_NAME,
  TEMPLATE_REPOSITORY_NAME,
  TEMPLATE_REPOSITORY_OWNER,
} from './repository-generation';
export type {
  GeneratedRepositoryIdentity,
  GeneratedRepositoryPollOptions,
  GenerateOrReuseOptions,
  GithubGenerateErrorCode,
} from './repository-generation';

export {
  configureGithubPages,
  getGithubPagesSite,
  GITHUB_PAGES_BUILD_TYPE,
  GITHUB_PAGES_SOURCE,
  GithubPagesError,
  PAGES_INITIAL_DELAY_MS,
  PAGES_MAX_ATTEMPTS,
  PAGES_MAX_DELAY_MS,
} from './github-pages';
export type {
  GithubPagesConfigureOptions,
  GithubPagesErrorCode,
  GithubPagesIdentity,
} from './github-pages';

export {
  ACTIONS_SECRET_NAMES,
  GithubActionsSecretsError,
  getActionsPublicKey,
  getGithubActionsPublicKey,
  sealActionsSecret,
  sealSecret,
  sealGithubActionsSecret,
  writeActionsSecrets,
  writeGithubActionsSecrets,
} from './actions-secrets';
export type {
  ActionsSecretName,
  ActionsSecretsProvisioningPayload,
  ActionsSecretsWriteResult,
  GithubActionsSecretsErrorCode,
  GithubActionsSecretsPayload,
  GithubActionsPublicKey,
} from './actions-secrets';

export {
  CONFIG_PATCH_COMMIT_MESSAGE,
  CONFIG_PATCH_MAX_ATTEMPTS,
  GithubConfigError,
  JEKYLL_CONFIG_BRANCH,
  JEKYLL_CONFIG_PATH,
  patchGeneratedRepositoryConfig,
  patchRepositoryConfig,
} from './repository-config';
export type { ConfigPatchOptions, ConfigPatchResult, GithubConfigErrorCode } from './repository-config';

export {
  awaitNotionSyncRun,
  correlateDispatchedSyncRun,
  dispatchAndCorrelateNotionSync,
  dispatchNotionSyncWorkflow,
  GithubSyncError,
  listWorkflowRunIds,
  SYNC_WORKFLOW_FILE,
} from './notion-sync';
export type {
  GithubSyncErrorCode,
  NotionSyncPollOptions,
  NotionSyncRunIdentity,
} from './notion-sync';

export {
  awaitPagesBuildForCommit,
  checkPublicSiteReachable,
  getRepositoryMainHeadSha,
  verifyPublicSiteReachable,
  GithubDeployError,
  PAGES_BUILD_MAX_POLL_ATTEMPTS,
  SITE_VERIFY_MAX_ATTEMPTS,
} from './site-deployment';
export type {
  GithubDeployErrorCode,
  GithubDeployStatus,
  GithubPagesBuildIdentity,
  PagesBuildPollOptions,
  SiteCheckOptions,
  SiteVerifyOptions,
} from './site-deployment';

export {
  createGithubInstallationToken,
  getAppInstallation,
  GithubAppAuthError,
} from './github-app-auth';
export type { GithubAppAuthEnv, GithubInstallationAccount } from './github-app-auth';

export {
  createProvisioningJob,
  isSucceededProvisioningJob,
  isTerminalProvisioningStatus,
  loadProvisioningJob,
  nextPendingStep,
  provisioningJobKey,
  provisioningRetryDelaySeconds,
  saveProvisioningJob,
  tryAcquireProvisioningLock,
  PROVISIONING_JOB_PREFIX,
  PROVISIONING_JOB_TTL_SECONDS,
  PROVISIONING_JOB_VERSION,
  PROVISIONING_ENQUEUE_RETRY_DELAY_SECONDS,
  PROVISIONING_LOCK_RETRY_DELAY_SECONDS,
  PROVISIONING_LOCK_TTL_MS,
  PROVISIONING_STEP_MAX_ATTEMPTS,
  PROVISIONING_STEP_ORDER,
} from './provisioning-job';
export type {
  CreateProvisioningJobParams,
  NotionSyncProgress,
  NotionTemplateLinks,
  ProvisioningJob,
  ProvisioningJobData,
  ProvisioningJobIdentity,
  ProvisioningJobLock,
  ProvisioningJobStatus,
  ProvisioningStepError,
  ProvisioningStepName,
  ProvisioningStepState,
  ProvisioningStepStatus,
  SiteDeploymentProgress,
  SucceededProvisioningJob,
  SyncDispatchMarker,
} from './provisioning-job';

export { PROVISIONING_STEP_HANDLERS } from './provisioning-steps';
export type { ProvisioningStepHandler, StepRunnerContext } from './provisioning-steps';

export { emitProvisioningEvent, OBSERVABILITY_EVENT_FIELDS } from './observability';
export type {
  ObservabilityEnv,
  ProvisioningEvent,
  ProvisioningEventErrorCode,
} from './observability';

export {
  DEFAULT_ALERT_THRESHOLDS,
  evaluateObservabilityAlerts,
  runObservabilityAlertCheck,
  summarizeAlertWindow,
} from './observability-alerts';
export type {
  AlertCheckEnv,
  AlertThresholds,
  AlertWindowSummary,
  AnalyticsEngineSqlResponse,
  AnalyticsEngineSqlRow,
  ObservabilityAlert,
  StepFailureWindow,
} from './observability-alerts';

export { classifyProvisioningError, processProvisioningMessage } from './provisioning-queue';
export type {
  ProvisioningErrorClassification,
  ProvisioningMessageOutcome,
  ProvisioningQueueEnv,
  ProvisioningRuntimeOptions,
} from './provisioning-queue';

export {
  ACCOUNT_LEASE_PREFIX,
  admitProvisioningAccount,
  admitProvisioningCallback,
  admitProvisioningRequest,
  admitProvisioningStage,
  admissionFailureCode,
  accountLeaseKey,
  acquireProvisioningStart,
  consumeGlobalMutationBudget,
  gateProvisioningStep,
  GLOBAL_RATE_KEY,
  isBudgetedMutationStep,
  jitteredDelaySeconds,
  MAX_RACING_ISOLATES,
  PROVISIONING_ADMISSION_STAGES,
  PROVISIONING_ADMISSION_AUDIT_TTL_DEFAULT_SECONDS,
  PROVISIONING_ACCOUNT_ATTEMPT_LIMIT_DEFAULT,
  PROVISIONING_ACCOUNT_ATTEMPT_WINDOW_DEFAULT_SECONDS,
  PROVISIONING_CONTROL_KEY,
  PROVISIONING_CONTROL_RECHECK_SECONDS,
  PROVISIONING_DENIED_IDENTITY_COOLDOWN_DEFAULT_SECONDS,
  PROVISIONING_REQUEST_BURST_LIMIT_DEFAULT,
  PROVISIONING_REQUEST_BURST_WINDOW_DEFAULT_SECONDS,
  PROVISIONING_LEASE_TTL_DEFAULT_SECONDS,
  PROVISIONING_LEASE_TTL_MAX_SECONDS,
  PROVISIONING_LEASE_TTL_MIN_SECONDS,
  PROVISIONING_MUTATIONS_PER_HOUR_CEILING,
  PROVISIONING_MUTATIONS_PER_HOUR_DEFAULT,
  PROVISIONING_MUTATIONS_PER_MINUTE_CEILING,
  PROVISIONING_MUTATIONS_PER_MINUTE_DEFAULT,
  provisioningThrottleConfig,
  ProvisioningGateRefusedError,
  provisioningAdmissionConfig,
  recordProvisioningIdentityDenial,
  releaseProvisioningLeaseIfOwned,
  saveTerminalProvisioningJob,
} from './provisioning-throttle';
export type {
  AccountLease,
  BudgetDecision,
  GlobalRateState,
  ProvisioningThrottleConfig,
  ProvisioningThrottleVars,
  ProvisioningAdmissionConfig,
  ProvisioningAccountAdmissionRecord,
  ProvisioningAdmissionAuditRecord,
  ProvisioningCallbackClaimRecord,
  ProvisioningAdmissionDecision,
  ProvisioningAdmissionEnv,
  ProvisioningAdmissionReason,
  ProvisioningAdmissionStage,
  ProvisioningAdmissionVars,
  ProvisioningControl,
  ProvisioningIdentityDenialRecord,
  ProvisioningRequestBurstRecord,
  StartGateDecision,
  StepGateDecision,
} from './provisioning-throttle';

export {
  beginNotionAuthorization,
  exchangeNotionAuthorizationCode,
  finishNotionCallback,
  NOTION_API_VERSION,
  NOTION_AUTHORIZATION_URL,
  NOTION_STATE_COOKIE,
  NOTION_STATE_PREFIX,
  NOTION_STATE_REPLAY_TTL_SECONDS,
  NOTION_STATE_TTL_SECONDS,
  NOTION_TOKEN_URL,
  NotionOAuthError,
  signNotionState,
} from './notion-oauth';
export type {
  NotionOAuthContinuation,
  NotionOAuthContinuationHandler,
  NotionOAuthEnv,
  NotionOAuthErrorCode,
  NotionOAuthRouteOptions,
  NotionStatePayload,
} from './notion-oauth';

export {
  progressPageUrl,
  projectProvisioning,
  PROGRESS_STAGE_ORDER,
  PROGRESS_STAGE_REGISTRY,
  STAGE_BY_STEP,
} from './progress';
export type {
  ProgressSnapshot,
  ProgressStageEntry,
  ProgressStageId,
  ProgressStageState,
  ProgressStageView,
  PublicProgress,
} from './progress';

export {
  progressPage,
  PROGRESS_POLL_BASE_INTERVAL_FLOOR,
  PROGRESS_POLL_INTERVAL_MS,
  PROGRESS_POLL_MAX_INTERVAL_MS,
} from './progress-page';
export type { SiteCheckOutcome } from './progress-page';

export {
  admitStatusRerun,
  discoverSite,
  isStatusCallbackState,
  parseSafeSummary,
  projectSiteStatus,
  readStatusSession,
  rerunTokenValid,
  signRerunToken,
  signStatusSession,
  signStatusState,
  statusCallback,
  statusHome,
  statusRerun,
  statusRerunKey,
  statusStatePayload,
  STATUS_RERUN_DAILY_LIMIT,
  STATUS_RERUN_KEY_PREFIX,
  STATUS_RERUN_SPACING_SECONDS,
  STATUS_RERUN_WINDOW_SECONDS,
  STATUS_SESSION_COOKIE,
  STATUS_SESSION_TTL_SECONDS,
  STATUS_STATE_COOKIE,
  STATUS_STATE_TTL_SECONDS,
  STATUS_REFRESH_SECONDS,
} from './status';
export type {
  DeployOutcome,
  SafeSummaryParse,
  SafeSummaryResult,
  SiteDiscovery,
  SiteStatus,
  StatusEnv,
  StatusPageModel,
  StatusRerunAdmission,
  StatusRerunWindow,
  StatusSession,
  StatusStatePayload,
  StatusView,
  SyncOutcome,
} from './status';

export {
  loadNotionTemplateResolution,
  normalizeNotionId,
  notionTemplateResolutionKey,
  NotionTemplateError,
  NOTION_TEMPLATE_RESOLUTION_PREFIX,
  NOTION_TEMPLATE_RESOLUTION_TTL_SECONDS,
  NOTION_TEMPLATE_SCHEMA_VERSION,
  PAGES_FINGERPRINT,
  PAGES_SCHEMA_CONTRACT,
  parseNotionCanonicalUrl,
  POSTS_FINGERPRINT,
  POSTS_SCHEMA_CONTRACT,
  resolveNotionTemplateDatabases,
  RESOLUTION_INITIAL_DELAY_MS,
  RESOLUTION_MAX_ATTEMPTS,
  RESOLUTION_MAX_DELAY_MS,
  saveNotionTemplateResolution,
  validateNotionTemplateSchemas,
  TEMPLATE_MAX_BLOCK_PAGE_FETCHES,
  TEMPLATE_MAX_CANDIDATE_DATABASES,
  TEMPLATE_MAX_WALK_DEPTH,
} from './notion-template';
export type {
  NotionDatabaseSchemaValidation,
  NotionDatabaseSchemaSummary,
  NotionSchemaValidationIssue,
  NotionSchemaValidationIssueCode,
  NotionTemplateSchemaValidation,
  NotionTemplateErrorCode,
  NotionTemplateResolution,
  NotionTemplateResolutionRecord,
  NotionTemplateResolveOptions,
  TemplateDatabaseRole,
} from './notion-template';

export { LANDING_PAGE } from './landing-page';
export interface Env extends ProvisioningThrottleVars {
  /** Durable provisioning-job records. Values are JSON and have a short TTL. */
  JOBS: KVNamespace;
  /** Work queue for resumable provisioning jobs. */
  PROVISIONING_QUEUE: Queue<ProvisioningMessage>;
  /** Aggregate provisioning-funnel metrics (`src/observability.ts`). */
  PROVISIONING_METRICS?: AnalyticsEngineDataset;
  /** Non-secret Cloudflare account ID, read only by the alert check's SQL query. */
  CLOUDFLARE_ACCOUNT_ID?: string;
  /** Non-secret GitHub App identifier from the App settings. */
  GITHUB_APP_ID: string;
  /** Non-secret GitHub App slug used to build the installation URL. */
  GITHUB_APP_SLUG: string;
  /** Server-only secrets configured with `wrangler secret put`. */
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  NOTION_CLIENT_ID: string;
  NOTION_CLIENT_SECRET: string;
}

export interface ProvisioningMessage {
  jobId: string;
}

export interface GithubIdentity {
  id: number;
  login: string;
  accountType: 'User' | 'Organization';
}

const GITHUB_INSTALL_URL = 'https://github.com/apps';
const STATE_TTL_SECONDS = 10 * 60;
const STATE_REPLAY_TTL_SECONDS = 60 * 60;
const STATE_PREFIX = 'github:oauth-state:';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

function admissionResponse(decision: Exclude<Awaited<ReturnType<typeof admitProvisioningRequest>>, { action: 'allow' }>): Response {
  const code = admissionFailureCode(decision.reason);
  const status = decision.reason === 'callback_replay' ? 400
    : decision.reason === 'account_attempt_limit' || decision.reason === 'request_burst' ? 429
      : decision.reason === 'identity_denied' ? 423 : 503;
  const body: Record<string, unknown> = { error: code };
  if (decision.action === 'reject' && decision.retryAfterSeconds !== null) body.retry_after_seconds = decision.retryAfterSeconds;
  const headers: Record<string, string> = decision.action === 'reject' && decision.retryAfterSeconds !== null
    ? { 'retry-after': String(decision.retryAfterSeconds) }
    : {};
  return json(body, status, headers);
}

function html(document: string, status = 200): Response {
  return new Response(document, { status, headers: HTML_HEADERS });
}

type StatePhase = 'pending' | 'setup_received' | 'consumed';

interface SignedStatePayload {
  v: 1;
  jobId: string;
  nonce: string;
  exp: number;
}

interface GithubStateRecord {
  version: 1;
  jobId: string;
  nonce: string;
  expiresAt: number;
  phase: StatePhase;
  installationId?: number;
  identity?: GithubIdentity;
}

/** Exported for tests and for other onboarding entrypoints that share state. */
export async function signGithubState(
  payload: SignedStatePayload,
  secret: string,
): Promise<string> {
  return signSignedPayload(payload, secret);
}

/**
 * A payload with no `k` kind is an install state, so states signed before
 * the status leg shipped keep verifying across a deploy. Status-leg payloads
 * carry a `k` mark and are refused here; the callback dispatches on the
 * payload kind before this verifier runs.
 */
async function verifyGithubState(
  encodedState: string,
  secret: string,
): Promise<SignedStatePayload | null> {
  return verifySignedPayload<SignedStatePayload>(encodedState, secret, (payload) =>
    payload.k === undefined &&
    payload.v === 1 &&
    typeof payload.jobId === 'string' &&
    typeof payload.nonce === 'string' &&
    !payloadExpired(payload.exp, Math.floor(Date.now() / 1000)));
}

function stateSecret(env: Pick<Env, 'GITHUB_CLIENT_SECRET'>): string {
  // The OAuth client secret is already a server-only secret and gives state a
  // stable signing key without adding another credential to deployment config.
  return env.GITHUB_CLIENT_SECRET;
}

function stateKey(nonce: string): string {
  return `${STATE_PREFIX}${nonce}`;
}

function validJobId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function validInstallationId(value: string | null): number | null {
  if (!value || !/^\d{1,20}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function callbackUrl(request: Request): string {
  return new URL('/auth/github/callback', request.url).toString();
}

function authError(error: unknown, request: Request): Response {
  if (error instanceof ProvisioningAdmissionRefusedError) {
    const status = error.code === 'github_account_attempt_limited' ? 429
      : error.code === 'github_identity_temporarily_denied' ? 423
        : error.code === 'github_state_replayed' ? 400 : 503;
    const body: Record<string, unknown> = { error: error.code };
    if (error.retryAfterSeconds !== null) body.retry_after_seconds = error.retryAfterSeconds;
    return json(body, status, error.retryAfterSeconds === null ? {} : { 'retry-after': String(error.retryAfterSeconds) });
  }
  // GithubApiError carries no code, and GithubAppAuthError's derived code
  // reflects what the queue can retry, not what the user should do next:
  // both resolve here from the provider status.
  if (error instanceof GithubApiError || error instanceof GithubAppAuthError) {
    if (error.status === 429) return json({ error: 'github_rate_limited' }, 429);
    if (error.status === 404) return json({ error: 'github_installation_missing' }, 400);
    if (error.status === 400 || error.status === 401) return json({ error: 'github_authorization_failed' }, 400);
    return json({ error: 'github_authorization_unavailable' }, 502);
  }
  if (error instanceof GithubRepositoryApiError && (error.status === 400 || error.status === 401)) {
    return json({ error: 'github_authorization_failed' }, 400);
  }
  if (error instanceof ProvisioningGateRefusedError) {
    // A refused start is not a failure of the flow. A double starter just
    // OAuth'd as the account that holds the slot, so naming that job's
    // progress page is a sound capability grant; a budget refusal names no
    // job and keeps the Retry-After contract GitHub uses.
    if (error.reason === 'account_busy' && error.activeJobId !== null) {
      return new Response(null, {
        status: 303,
        headers: { Location: new URL(progressPageUrl(error.activeJobId), request.url).toString() },
      });
    }
    return json({
      error: error.reason === 'account_busy' ? 'github_provisioning_already_active' : 'github_rate_limited',
      retry_after_seconds: error.retryAfterSeconds,
    }, error.status, { 'retry-after': String(error.retryAfterSeconds) });
  }
  if (error instanceof GithubActionsSecretsError) {
    return json({ error: error.code }, error.status);
  }
  const failure = callbackFailure(error, 'github');
  const body: Record<string, unknown> = { error: failure.code };
  if (failure.retryAfterSeconds !== null) body.retry_after_seconds = failure.retryAfterSeconds;
  // Deliberately do not expose provider response bodies, OAuth codes, tokens,
  // private keys, or exception messages to the browser; the reportError
  // serialization is redacted by construction (see `safe-serialize.ts`).
  if (codedFailureCode(error) === null) reportError('github_callback_failed', error);
  return json(body, failure.status);
}

async function beginGithubInstall(request: Request, env: Partial<Env>): Promise<Response> {
  if (!env.JOBS || !env.GITHUB_APP_SLUG || !env.GITHUB_CLIENT_SECRET) {
    return json({ error: 'github_configuration_missing' }, 500);
  }
  const url = new URL(request.url);
  const requestedJobId = url.searchParams.get('job_id') || url.searchParams.get('jobId');
  const jobId = requestedJobId || crypto.randomUUID();
  if (!validJobId(jobId)) return json({ error: 'invalid_job_id' }, 400);
  const admission = await admitProvisioningRequest(env as Env, provisioningAdmissionConfig(env), {
    request,
    jobId,
    hmacSecret: env.GITHUB_CLIENT_SECRET,
  }, Date.now());
  if (admission.action !== 'allow') return admissionResponse(admission);

  const now = Math.floor(Date.now() / 1000);
  const payload: SignedStatePayload = {
    v: 1,
    jobId,
    nonce: crypto.randomUUID(),
    exp: now + STATE_TTL_SECONDS,
  };
  const state = await signGithubState(payload, stateSecret(env as Pick<Env, 'GITHUB_CLIENT_SECRET'>));
  const record: GithubStateRecord = {
    version: 1,
    jobId,
    nonce: payload.nonce,
    expiresAt: payload.exp,
    phase: 'pending',
  };
  await env.JOBS.put(stateKey(payload.nonce), JSON.stringify(record), { expirationTtl: STATE_TTL_SECONDS });

  const installationUrl = new URL(`${GITHUB_INSTALL_URL}/${encodeURIComponent(env.GITHUB_APP_SLUG)}/installations/new`);
  installationUrl.searchParams.set('state', state);
  return Response.redirect(installationUrl.toString(), 302);
}

async function finishGithubCallback(request: Request, env: Partial<Env>): Promise<Response> {
  if (!env.JOBS || !env.GITHUB_APP_ID || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return json({ error: 'github_configuration_missing' }, 500);
  }
  const url = new URL(request.url);
  const encodedState = url.searchParams.get('state');
  // Purpose dispatch runs before the shared error check: each leg's state
  // verifies only against its own kind, so the status leg finishes here —
  // including its own denied-callback page — while install states fall
  // through to the KV-backed flow below. No redirect-URI registration change.
  if (encodedState && await isStatusCallbackState(encodedState, stateSecret(env as Pick<Env, 'GITHUB_CLIENT_SECRET'>))) {
    return statusCallback(request, env);
  }
  if (url.searchParams.has('error')) {
    return json({ error: 'github_authorization_denied' }, 400);
  }
  if (!encodedState) return json({ error: 'github_state_missing' }, 400);
  const payload = await verifyGithubState(encodedState, stateSecret(env as Pick<Env, 'GITHUB_CLIENT_SECRET'>));
  if (!payload) return json({ error: 'github_state_invalid' }, 400);

  const record = await env.JOBS.get<GithubStateRecord>(stateKey(payload.nonce), 'json');
  if (!record || record.jobId !== payload.jobId || record.nonce !== payload.nonce || record.version !== 1) {
    return json({ error: 'github_state_invalid' }, 400);
  }
  if (record.phase === 'consumed') return json({ error: 'github_state_replayed' }, 400);
  if (record.expiresAt <= Math.floor(Date.now() / 1000)) return json({ error: 'github_state_expired' }, 400);

  const admissionConfig = provisioningAdmissionConfig(env);
  const control = await admitProvisioningStage(env as Env, admissionConfig, {
    stage: 'github_callback',
    jobId: record.jobId,
  }, Date.now());
  if (control.action !== 'allow') return admissionResponse(control);

  const installationId = validInstallationId(url.searchParams.get('installation_id'));
  const code = url.searchParams.get('code');
  if (!installationId && !record.installationId && !code) {
    return json({ error: 'github_installation_missing' }, 400);
  }
  if (url.searchParams.has('setup_action') && !['install', 'update'].includes(url.searchParams.get('setup_action') || '')) {
    return json({ error: 'github_setup_invalid' }, 400);
  }
  const replay = await admitProvisioningCallback(env as Env, admissionConfig, {
    provider: 'github',
    phase: code ? 'oauth' : 'setup',
    nonce: payload.nonce,
    stage: 'github_callback',
    jobId: record.jobId,
  }, Date.now());
  if (replay.action !== 'allow') return admissionResponse(replay);

  try {
    let identity: GithubIdentity | undefined;
    let repository: RepositoryDestination | undefined;
    let generatedRepository: GeneratedRepositoryIdentity | undefined;
    let selectedInstallationId = installationId || record.installationId;

    if (code) {
      const userToken = await exchangeGithubCode(code, env as Pick<Env, 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET'>, callbackUrl(request));
      // The token is scoped to this request. It is never logged, returned, or
      // passed to KV; it leaves the Secret only at these provider-call
      // unwraps. The GitHub code is likewise never persisted.
      const authenticatedUser = await getAuthenticatedGithubUser(userToken.bearer());
      if (authenticatedUser.accountType !== 'User') throw new FlowFailure('github_organization_installation_not_supported');
      const jobs = env.JOBS;
      const throttleConfig = provisioningThrottleConfig(env);
      const start = await acquireProvisioningStart(jobs, { accountId: authenticatedUser.id, jobId: record.jobId }, throttleConfig, Date.now());
      if (!start.granted) throw new ProvisioningGateRefusedError(start);
      // L5: the lease belongs to this request until the job record is durably
      // saved; from then on the job owns it and its first queue gate pass
      // renews it. If anything below fails, release it before returning, so a
      // crashed request never locks the account out for a full TTL.
      let leaseHandedOff = false;
      try {
        // GitHub normally includes installation_id during OAuth-on-install, but
        // the OAuth callback contract also permits code-only callbacks. Discover
        // this App's installation from the authenticated user's installations in
        // that case rather than trusting an unverified query parameter.
        const accountAdmission = await admitProvisioningAccount(env as Env, admissionConfig, {
          accountId: authenticatedUser.id,
          jobId: record.jobId,
        }, Date.now());
        if (accountAdmission.action !== 'allow') throw new ProvisioningAdmissionRefusedError(accountAdmission, 'github');
        if (!selectedInstallationId) {
          selectedInstallationId = await findUserInstallation(userToken.bearer(), env.GITHUB_APP_ID as string);
        }
        let userInstallation: GithubInstallationAccount;
        try {
          userInstallation = await getUserInstallation(userToken.bearer(), selectedInstallationId);
        } catch (error) {
          if (error instanceof GithubApiError && error.status === 403) {
            await recordProvisioningIdentityDenial(jobs, admissionConfig, { accountId: authenticatedUser.id, reason: 'provider_denied' }, Date.now());
          }
          throw error;
        }
        try {
          identity = assertUsablePersonalInstallation(userInstallation, authenticatedUser);
        } catch (error) {
          if (error instanceof FlowFailure && error.code === 'github_installation_suspended') {
            await recordProvisioningIdentityDenial(jobs, admissionConfig, { accountId: authenticatedUser.id, reason: 'suspended' }, Date.now());
          }
          throw error;
        }
        // Generation happens while the short-lived OAuth token is in memory:
        // creating a repository from the template requires user-to-server
        // authentication. An earlier attempt's generated repository is reused
        // instead of duplicated. Only non-secret destination and repository
        // identity metadata is retained in the job record.
        const ownedRepositories = await listOwnedGithubRepositories(userToken.raw);
        ({ destination: repository, identity: generatedRepository } = await generateOrReuseRepository(
          userToken.raw,
          identity.login,
          ownedRepositories,
          fetch,
          {
            beforeCreate: async () => {
              const createControl = await admitProvisioningStage(env as Env, admissionConfig, {
                stage: 'github_repository',
                jobId: record.jobId,
                accountId: identity!.id,
              }, Date.now());
              if (createControl.action !== 'allow') throw new ProvisioningAdmissionRefusedError(createControl, 'github');
              const budget = await consumeGlobalMutationBudget(jobs, throttleConfig, Date.now(), Math.random);
              if (!budget.admitted) {
                throw new ProvisioningGateRefusedError({
                  granted: false,
                  reason: budget.reason,
                  retryAfterSeconds: budget.delaySeconds,
                });
              }
            },
          },
        ));
        if (!identity || !repository || !generatedRepository) return json({ error: 'github_identity_missing' }, 400);

        // Everything after this point — verifying the generated repository is
        // readable, patching its config, enabling Pages, dispatching and
        // awaiting the Notion sync, and awaiting the resulting deploy — no
        // longer needs the short-lived OAuth token in memory: each step mints
        // its own installation token from `selectedInstallationId`, a durable,
        // non-secret identifier. So it moves off this request and onto the
        // durable provisioning queue, which can retry any step independently
        // and survives this Worker restarting mid-pipeline. The queue is not
        // told about the job here: the Notion callback enqueues it once the
        // repository's Actions secrets exist (see `continueNotionOnboarding`).
        const job = createProvisioningJob({
          jobId: record.jobId,
          installationId: selectedInstallationId,
          identity,
          repository,
          generatedRepository,
          now: Date.now(),
        });
        await saveProvisioningJob(env.JOBS, job);
        await env.JOBS.put(
          stateKey(payload.nonce),
          JSON.stringify({ ...record, phase: 'consumed', installationId: selectedInstallationId, identity }),
          { expirationTtl: STATE_REPLAY_TTL_SECONDS },
        );
        leaseHandedOff = true;

        const notionAuthorization = new URL('/connect/notion', request.url);
        notionAuthorization.searchParams.set('job_id', job.jobId);
        return Response.redirect(notionAuthorization.toString(), 302);
      } finally {
        if (!leaseHandedOff) await releaseProvisioningLeaseIfOwned(jobs, authenticatedUser.id, record.jobId);
      }
    } else {
      // This supports a setup callback arriving before the OAuth callback. The
      // App JWT proves that the installation belongs to this App; the later
      // OAuth callback still proves that it belongs to the authenticated user.
      if (!selectedInstallationId) return json({ error: 'github_installation_missing' }, 400);
      const appInstallation = await getAppInstallation(env as Pick<Env, 'GITHUB_APP_ID' | 'GITHUB_APP_PRIVATE_KEY'>, selectedInstallationId);
      assertUsablePersonalInstallation(appInstallation);
      const nextRecord: GithubStateRecord = {
        ...record,
        phase: 'setup_received',
        installationId: selectedInstallationId,
      };
      await env.JOBS.put(stateKey(payload.nonce), JSON.stringify(nextRecord), { expirationTtl: STATE_REPLAY_TTL_SECONDS });
      return json({ status: 'awaiting_authorization', job_id: record.jobId }, 202);
    }
  } catch (error) {
    return authError(error, request);
  }
}

/**
 * The production Notion onboarding continuation: while the short-lived access
 * token is still in this request's scope, resolve the duplicated template root
 * into the Pages and Posts database IDs and write all three Actions secrets
 * into the repository the GitHub callback already created. This is the only
 * place the Notion token exists, so it is also the only place those secrets
 * can be written; the token itself is never persisted, queued, or returned.
 * The job reaches the provisioning queue only after that write is durable, so
 * no queue step can run against a repository whose sync workflow would have no
 * credentials. Template-resolution failures surface as distinct, actionable
 * Notion OAuth errors; the programmatic database-creation fallback for a
 * non-duplicated authorization (ADR 0002 §2) is deliberately not implemented
 * yet, so that case fails with `notion_template_not_duplicated`.
 */
export function continueNotionOnboarding(
  env: Partial<Env>,
  runtime: { fetcher?: typeof fetch; sleep?: (milliseconds: number) => Promise<void> } = {},
): NotionOAuthContinuationHandler {
  return async ({ jobId, accessToken, duplicatedTemplateId }) => {
    if (!env.JOBS || !env.PROVISIONING_QUEUE || !env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
      throw new NotionOAuthError('notion_configuration_missing', 500);
    }
    const job = await loadProvisioningJob(env.JOBS, jobId);
    if (!job) throw new NotionOAuthError('provisioning_job_missing', 409, { connect_url: '/connect/github' });
    // Any later status means this job was already handed to the queue, so a
    // duplicate callback must not write secrets or enqueue it again.
    if (job.status !== 'awaiting_notion') return;
    const admission = await admitProvisioningStage(env as Env, provisioningAdmissionConfig(env), {
      stage: 'notion_secrets',
      jobId,
      accountId: job.identity.id,
    }, Date.now());
    if (admission.action !== 'allow') {
      throw new NotionOAuthError(admissionFailureCode(admission.reason) as NotionOAuthErrorCode, 503, {
        retry_after_seconds: admission.retryAfterSeconds,
      });
    }

    let ready = job;
    if (!ready.data.notionSecretsWrittenAt) {
      let notionLinks: NotionTemplateLinks | null = null;
      try {
        if (!duplicatedTemplateId) throw new NotionTemplateError('notion_template_not_duplicated', 400);
        // Resolved fresh every time, never from the stored record: a second
        // authorization duplicates the template again, so the stored database
        // IDs can belong to the previous duplicate and would pair this token
        // with databases the user is no longer writing in.
        const resolution = await resolveNotionTemplateDatabases(accessToken.raw, duplicatedTemplateId, {
          fetcher: runtime.fetcher,
          sleep: runtime.sleep,
        });
        // Only the API-returned canonical URLs travel with the job record —
        // never the database IDs, which remain server-side sync credentials.
        notionLinks = {
          pagesUrl: resolution.pagesUrl,
          postsUrl: resolution.postsUrl,
          templateRootUrl: resolution.templateRootUrl,
        };
        await saveNotionTemplateResolution(env.JOBS, { version: 1, jobId, resolution });
        const beforeSecrets = await admitProvisioningStage(env as Env, provisioningAdmissionConfig(env), {
          stage: 'notion_secrets',
          jobId,
          accountId: job.identity.id,
        }, Date.now());
        if (beforeSecrets.action !== 'allow') {
          throw new NotionOAuthError(admissionFailureCode(beforeSecrets.reason) as NotionOAuthErrorCode, 503, {
            retry_after_seconds: beforeSecrets.retryAfterSeconds,
          });
        }
        const installationToken = await createGithubInstallationToken(
          env as Pick<Env, 'GITHUB_APP_ID' | 'GITHUB_APP_PRIVATE_KEY'>,
          job.installationId,
          runtime.fetcher,
        );
        await writeGithubActionsSecrets(
          installationToken.raw,
          {
            repositoryFullName: job.data.generatedRepository.fullName,
            secrets: {
              NOTION_TOKEN: accessToken.raw,
              NOTION_PAGES_DATABASE_ID: resolution.pagesDatabaseId,
              NOTION_POSTS_DATABASE_ID: resolution.postsDatabaseId,
            },
          },
          runtime.fetcher,
        );
      } catch (error) {
        if (error instanceof NotionTemplateError) throw new NotionOAuthError(error.code, error.status, error.details);
        if (error instanceof GithubActionsSecretsError) throw new NotionOAuthError(error.code, error.status);
        throw error;
      }
      const writtenAt = Date.now();
      ready = {
        ...job,
        data: { ...job.data, notionLinks, notionSecretsWrittenAt: writtenAt },
        updatedAt: writtenAt,
      };
      await saveProvisioningJob(env.JOBS, ready);
    }

    try {
      await env.PROVISIONING_QUEUE.send({ jobId });
    } catch {
      // The status deliberately stays `awaiting_notion`: the secrets are
      // already durable, so re-authorizing Notion for this job comes back
      // here and retries only the handoff. Marking the job dead — or
      // reporting success — would strand it with nothing able to advance it.
      emitProvisioningEvent(env, {
        type: 'job_enqueue_failed',
        jobId,
        ts: Date.now(),
        errorCode: 'provisioning_enqueue_failed',
      });
      throw new NotionOAuthError('provisioning_handoff_failed', 502, {
        retry_url: `/connect/notion?job_id=${encodeURIComponent(jobId)}`,
      });
    }

    // Re-read before advancing the status: the queue may already have picked
    // the job up and taken its lock, and KV has no compare-and-swap to write
    // through (see `tryAcquireProvisioningLock`).
    const queuedAt = Date.now();
    const handedOff = await loadProvisioningJob(env.JOBS, jobId);
    if (handedOff?.status === 'awaiting_notion') {
      await saveProvisioningJob(env.JOBS, { ...handedOff, status: 'queued', updatedAt: queuedAt });
    }
    emitProvisioningEvent(env, { type: 'job_queued', jobId, ts: queuedAt });
  };
}

/**
 * Notion authorization is the second half of onboarding, so it only starts
 * for a job the GitHub callback already created. Without this an old
 * bookmark walks the user through a full Notion consent for a job that can
 * never finish: there is no repository to write the secrets into.
 */
async function beginNotionForJob(request: Request, env: Partial<Env>): Promise<Response> {
  if (!env.JOBS || !env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) {
    return json({ error: 'notion_configuration_missing' }, 500);
  }
  const url = new URL(request.url);
  const jobId = url.searchParams.get('job_id') || url.searchParams.get('jobId');
  const job = jobId && validJobId(jobId) ? await loadProvisioningJob(env.JOBS, jobId) : null;
  if (!jobId || !validJobId(jobId) || !job) {
    return json({
      error: 'provisioning_job_missing',
      message: 'Connect GitHub first.',
      connect_url: '/connect/github',
    }, 409);
  }
  const admission = await admitProvisioningStage(env as Env, provisioningAdmissionConfig(env), {
    stage: 'notion_callback',
    jobId,
    accountId: job.identity.id,
  }, Date.now());
  if (admission.action !== 'allow') return admissionResponse(admission);
  return beginNotionAuthorization(request, env);
}

async function progressPageResponse(request: Request, env: Partial<Env>): Promise<Response> {
  const url = new URL(request.url);
  const jobId = url.searchParams.get('job_id') ?? '';
  const job = validJobId(jobId) && env.JOBS ? await loadProvisioningJob(env.JOBS, jobId) : null;
  // No-JS retry: only an explicit ?check=1 on a succeeded job probes, and the
  // probe is the same one-shot the site-check endpoint runs. A plain render
  // never fetches, so it never adds latency.
  const succeeded = job !== null && isSucceededProvisioningJob(job) ? job : null;
  const siteCheck: SiteCheckOutcome | null = succeeded && url.searchParams.get('check') === '1'
    ? { reachable: await checkPublicSiteReachable(succeeded.data.repository.url), checkedAt: Date.now() }
    : null;
  // An absent, malformed, or unknown id renders the same missing page; only
  // the status differs, so a bookmark of an expired job still reads as gone.
  return html(progressPage(jobId, projectProvisioning(job, Date.now()), siteCheck), job ? 200 : 404);
}

async function progressSiteCheckResponse(request: Request, env: Partial<Env>): Promise<Response> {
  const url = new URL(request.url);
  const jobId = url.searchParams.get('job_id') ?? '';
  // The job id is the bearer capability, so missing, malformed, unknown, and
  // non-succeeded jobs all read as the same not-found; there is no distinction
  // to leak. The probed URL comes from the record, never from the request.
  const job = validJobId(jobId) && env.JOBS ? await loadProvisioningJob(env.JOBS, jobId) : null;
  if (job === null || !isSucceededProvisioningJob(job)) return json({ error: 'not_found' }, 404);
  const reachable = await checkPublicSiteReachable(job.data.repository.url);
  return json({ reachable, checkedAt: Date.now() });
}

async function progressStatusResponse(request: Request, env: Partial<Env>): Promise<Response> {
  const url = new URL(request.url);
  const jobId = url.searchParams.get('job_id');
  if (!jobId || !validJobId(jobId)) return json({ error: 'invalid_job_id' }, 400);
  const job = env.JOBS ? await loadProvisioningJob(env.JOBS, jobId) : null;
  return json(projectProvisioning(job, Date.now()));
}

export function route(
  request: Request,
  env: Partial<Env> = {},
  options: NotionOAuthRouteOptions = {},
): Response | Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/') {
    return html(LANDING_PAGE);
  }

  if (request.method === 'GET' && url.pathname === '/healthz') {
    return json({ ok: true, service: 'notiongit' });
  }

  if (request.method === 'GET' && url.pathname === '/connect/github') {
    return beginGithubInstall(request, env);
  }

  if (request.method === 'GET' && url.pathname === '/connect/notion') {
    return beginNotionForJob(request, env);
  }

  if (request.method === 'GET' && url.pathname === '/progress') {
    return progressPageResponse(request, env);
  }

  if (request.method === 'GET' && url.pathname === '/progress/status') {
    return progressStatusResponse(request, env);
  }

  if (request.method === 'GET' && url.pathname === '/progress/site-check') {
    return progressSiteCheckResponse(request, env);
  }

  if (request.method === 'GET' && url.pathname === '/status') {
    return statusHome(request, env);
  }

  if (request.method === 'POST' && url.pathname === '/status/rerun') {
    return statusRerun(request, env);
  }

  if (request.method === 'GET' && url.pathname === '/auth/github/callback') {
    return finishGithubCallback(request, env);
  }

  if (request.method === 'GET' && url.pathname === '/auth/notion/callback') {
    return finishNotionCallback(request, env, options);
  }

  return json(
    {
      error: 'not_found',
      message: 'The requested route does not exist.',
    },
    404,
  );
}

const worker: ExportedHandler<Env, ProvisioningMessage> = {
  fetch(request, env) {
    // The deployed worker resolves the duplicated template and writes the
    // repository's Actions secrets inside the Notion callback; `route` keeps
    // the continuation injectable for tests.
    return route(request, env, { continueOnboarding: continueNotionOnboarding(env) });
  },

  async queue(batch, env) {
    // Do not log message bodies: they may reference a job whose future
    // steps carry provider identifiers.
    for (const message of batch.messages) {
      try {
        const jobId = message.body?.jobId;
        if (typeof jobId !== 'string' || !validJobId(jobId)) {
          message.ack();
          continue;
        }
        const outcome = await processProvisioningMessage(jobId, env, {});
        if (outcome.outcome === 'retry') message.retry({ delaySeconds: outcome.delaySeconds });
        else message.ack();
      } catch (error) {
        // An unexpected failure means this job's KV record could not be
        // read or written. Retry it: Cloudflare's own backoff and
        // max_retries/dead-letter-queue act as the outer safety net for
        // this, rather than the application-level classification in
        // `processProvisioningMessage`.
        reportError('provisioning_message_failed', error);
        message.retry();
      }
    }
  },

  // Inert until the alert secrets are set, and `wrangler.toml` ships its cron
  // trigger commented out, so nothing invokes this on a schedule yet.
  async scheduled(_controller, env) {
    await runObservabilityAlertCheck(env);
  },
};

export default worker;
