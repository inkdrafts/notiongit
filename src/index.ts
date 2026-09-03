/**
 * InkDrafts' edge entrypoint.
 *
 * GitHub's OAuth code and all access tokens are deliberately kept inside the
 * request that uses them. KV contains only the signed-state replay marker and
 * the resulting GitHub identity/installation, destination, and generated
 * repository metadata.
 */

import {
  GithubRepositoryApiError,
  listOwnedGithubRepositories,
  type RepositoryDestination,
} from './repository-naming';
import {
  generateOrReuseRepository,
  GithubGenerateError,
  type GeneratedRepositoryIdentity,
} from './repository-generation';
import {
  GithubActionsSecretsError,
} from './actions-secrets';
import {
  getAppInstallation,
  GithubAppAuthError,
  type GithubInstallationAccount,
} from './github-app-auth';
import {
  createProvisioningJob,
  nextPendingStep,
  saveProvisioningJob,
} from './provisioning-job';
import { processProvisioningMessage } from './provisioning-queue';
import {
  beginNotionAuthorization,
  finishNotionCallback,
  NotionOAuthError,
  type NotionOAuthContinuationHandler,
  type NotionOAuthRouteOptions,
} from './notion-oauth';
import {
  NotionTemplateError,
  resolveNotionTemplateDatabases,
  saveNotionTemplateResolution,
} from './notion-template';
import { LANDING_PAGE } from './landing-page';


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
  PROVISIONING_LOCK_RETRY_DELAY_SECONDS,
  PROVISIONING_LOCK_TTL_MS,
  PROVISIONING_STEP_MAX_ATTEMPTS,
  PROVISIONING_STEP_ORDER,
} from './provisioning-job';
export type {
  CreateProvisioningJobParams,
  NotionSyncProgress,
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
  SyncDispatchMarker,
} from './provisioning-job';

export { PROVISIONING_STEP_HANDLERS } from './provisioning-steps';
export type { ProvisioningStepHandler, StepRunnerContext } from './provisioning-steps';

export { classifyProvisioningError, processProvisioningMessage } from './provisioning-queue';
export type {
  ProvisioningErrorClassification,
  ProvisioningMessageOutcome,
  ProvisioningQueueEnv,
  ProvisioningRuntimeOptions,
} from './provisioning-queue';

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
  NotionOAuthSummary,
  NotionStatePayload,
} from './notion-oauth';

export {
  loadNotionTemplateResolution,
  normalizeNotionId,
  notionTemplateResolutionKey,
  NotionTemplateError,
  NOTION_TEMPLATE_RESOLUTION_PREFIX,
  NOTION_TEMPLATE_RESOLUTION_TTL_SECONDS,
  NOTION_TEMPLATE_SCHEMA_VERSION,
  PAGES_FINGERPRINT,
  POSTS_FINGERPRINT,
  resolveNotionTemplateDatabases,
  RESOLUTION_INITIAL_DELAY_MS,
  RESOLUTION_MAX_ATTEMPTS,
  RESOLUTION_MAX_DELAY_MS,
  saveNotionTemplateResolution,
  TEMPLATE_MAX_BLOCK_PAGE_FETCHES,
  TEMPLATE_MAX_CANDIDATE_DATABASES,
  TEMPLATE_MAX_WALK_DEPTH,
} from './notion-template';
export type {
  NotionDatabaseSchemaSummary,
  NotionTemplateErrorCode,
  NotionTemplateResolution,
  NotionTemplateResolutionRecord,
  NotionTemplateResolveOptions,
  TemplateDatabaseRole,
} from './notion-template';

export { LANDING_PAGE } from './landing-page';

export interface Env {
  /** Durable provisioning-job records. Values are JSON and have a short TTL. */
  JOBS: KVNamespace;
  /** Work queue for resumable provisioning jobs. */
  PROVISIONING_QUEUE: Queue<ProvisioningMessage>;
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

const GITHUB_API = 'https://api.github.com';
const GITHUB_INSTALL_URL = 'https://github.com/apps';
const GITHUB_API_VERSION = '2022-11-28';
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
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS,
  });
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

interface GithubUserResponse {
  id?: number;
  login?: string;
  type?: string;
}

interface GithubInstallationsResponse {
  installations?: Array<{ id?: number; app_id?: number; app_slug?: string }>;
}

interface GithubAccessTokenResponse {
  access_token?: string;
  error?: string;
}

interface GithubApiErrorShape {
  status: number;
}

class GithubApiError extends Error implements GithubApiErrorShape {
  readonly status: number;

  constructor(status: number) {
    super('GitHub request failed');
    this.name = 'GithubApiError';
    this.status = status;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('invalid base64url');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

const textEncoder = new TextEncoder();

async function hmacSign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

/** Exported for tests and for other onboarding entrypoints that share state. */
export async function signGithubState(
  payload: SignedStatePayload,
  secret: string,
): Promise<string> {
  const encodedPayload = base64UrlEncode(textEncoder.encode(JSON.stringify(payload)));
  return `${encodedPayload}.${await hmacSign(encodedPayload, secret)}`;
}

async function verifyGithubState(
  encodedState: string,
  secret: string,
): Promise<SignedStatePayload | null> {
  const parts = encodedState.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  try {
    const expectedSignature = await hmacSign(parts[0], secret);
    const expected = textEncoder.encode(expectedSignature);
    const actual = textEncoder.encode(parts[1]);
    if (expected.length !== actual.length) return null;

    // HMAC verification is done by WebCrypto as well; the equal-length check
    // avoids using a non-constant-time string comparison for the signature.
    const key = await crypto.subtle.importKey(
      'raw',
      textEncoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecode(parts[1]),
      textEncoder.encode(parts[0]),
    );
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]))) as SignedStatePayload;
    if (
      payload.v !== 1 ||
      typeof payload.jobId !== 'string' ||
      typeof payload.nonce !== 'string' ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
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

function githubHeaders(authorization?: string): Headers {
  const headers = new Headers({
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  });
  if (authorization) headers.set('Authorization', authorization);
  return headers;
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function githubRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(githubHeaders());
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) throw new GithubApiError(response.status);
  const body = await readJson<T>(response);
  if (body === null) throw new GithubApiError(502);
  return body;
}

async function exchangeGithubCode(
  code: string,
  env: Pick<Env, 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET'>,
  redirectUri: string,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    client_secret: env.GITHUB_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
  });
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const token = await readJson<GithubAccessTokenResponse>(response);
  if (!response.ok || !token?.access_token || token.error) throw new GithubApiError(response.status || 502);
  return token.access_token;
}

async function getAuthenticatedGithubUser(accessToken: string): Promise<GithubIdentity> {
  const user = await githubRequest<GithubUserResponse>('/user', {
    headers: githubHeaders(`Bearer ${accessToken}`),
  });
  if (!Number.isSafeInteger(user.id) || !user.login || (user.type !== 'User' && user.type !== 'Organization')) {
    throw new GithubApiError(502);
  }
  const { id, login, type } = user;
  return { id: id as number, login: login as string, accountType: type as 'User' | 'Organization' };
}

async function getUserInstallation(
  accessToken: string,
  installationId: number,
): Promise<GithubInstallationAccount> {
  return githubRequest<GithubInstallationAccount>(`/user/installations/${installationId}`, {
    headers: githubHeaders(`Bearer ${accessToken}`),
  });
}

async function findUserInstallation(
  accessToken: string,
  appId: string,
): Promise<number> {
  const response = await githubRequest<GithubInstallationsResponse>('/user/installations', {
    headers: githubHeaders(`Bearer ${accessToken}`),
  });
  const installation = response.installations?.find(
    (candidate) => Number(candidate.app_id) === Number(appId) && Number.isSafeInteger(candidate.id) && candidate.id! > 0,
  );
  if (!installation?.id) throw new GithubApiError(404);
  return installation.id;
}

function installationIdentity(
  installation: GithubInstallationAccount,
): GithubIdentity {
  const account = installation.account;
  if (!account || !Number.isSafeInteger(account.id) || !account.login) throw new GithubApiError(502);
  if (account.type !== 'User' && account.type !== 'Organization') throw new GithubApiError(502);
  const { id, login, type } = account;
  return { id: id as number, login: login as string, accountType: type as 'User' | 'Organization' };
}

function assertUsablePersonalInstallation(
  installation: GithubInstallationAccount,
  authenticatedUser?: GithubIdentity,
): GithubIdentity {
  if (installation.suspended_at || installation.suspended_by) {
    throw new Error('github_installation_suspended');
  }
  const identity = installationIdentity(installation);
  if (identity.accountType === 'Organization') {
    throw new Error('github_organization_installation_not_supported');
  }
  if (
    authenticatedUser &&
    (identity.id !== authenticatedUser.id || identity.login.toLowerCase() !== authenticatedUser.login.toLowerCase())
  ) {
    throw new Error('github_account_mismatch');
  }
  return identity;
}

function authError(error: unknown): Response {
  if (error instanceof Error) {
    switch (error.message) {
      case 'github_installation_suspended': return json({ error: error.message }, 403);
      case 'github_organization_installation_not_supported': return json({ error: error.message }, 403);
      case 'github_account_mismatch': return json({ error: error.message }, 403);
    }
  }
  if (error instanceof GithubApiError || error instanceof GithubAppAuthError) {
    if (error.status === 404) return json({ error: 'github_installation_missing' }, 400);
    if (error.status === 400 || error.status === 401) return json({ error: 'github_authorization_failed' }, 400);
  }
  if (error instanceof GithubRepositoryApiError) {
    if (error.status === 400 || error.status === 401) return json({ error: 'github_authorization_failed' }, 400);
  }
  if (error instanceof GithubGenerateError) {
    // Timeout, rate limit, and unavailable are distinct on purpose: each has a
    // different recovery path and all are resumable by restarting the flow,
    // which reuses an already-generated repository instead of duplicating it.
    const body: Record<string, unknown> = { error: error.code };
    if (error.retryAfterSeconds !== null) body.retry_after_seconds = error.retryAfterSeconds;
    return json(body, error.status);
  }
  if (error instanceof GithubActionsSecretsError) {
    return json({ error: error.code }, error.status);
  }
  // Pages, config-patch, sync-dispatch, and deploy failures no longer surface
  // here: those steps run in the durable provisioning queue (see
  // `provisioning-queue.ts`), not inside this synchronous request.
  // Deliberately do not expose provider response bodies, OAuth codes, tokens,
  // private keys, or exception messages to the browser.
  return json({ error: 'github_authorization_unavailable' }, 502);
}

async function beginGithubInstall(request: Request, env: Partial<Env>): Promise<Response> {
  if (!env.JOBS || !env.GITHUB_APP_SLUG || !env.GITHUB_CLIENT_SECRET) {
    return json({ error: 'github_configuration_missing' }, 500);
  }
  const url = new URL(request.url);
  const requestedJobId = url.searchParams.get('job_id') || url.searchParams.get('jobId');
  const jobId = requestedJobId || crypto.randomUUID();
  if (!validJobId(jobId)) return json({ error: 'invalid_job_id' }, 400);

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
  if (!env.JOBS || !env.PROVISIONING_QUEUE || !env.GITHUB_APP_ID || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return json({ error: 'github_configuration_missing' }, 500);
  }
  const url = new URL(request.url);
  if (url.searchParams.has('error')) {
    return json({ error: 'github_authorization_denied' }, 400);
  }

  const encodedState = url.searchParams.get('state');
  if (!encodedState) return json({ error: 'github_state_missing' }, 400);
  const payload = await verifyGithubState(encodedState, stateSecret(env as Pick<Env, 'GITHUB_CLIENT_SECRET'>));
  if (!payload) return json({ error: 'github_state_invalid' }, 400);

  const record = await env.JOBS.get<GithubStateRecord>(stateKey(payload.nonce), 'json');
  if (!record || record.jobId !== payload.jobId || record.nonce !== payload.nonce || record.version !== 1) {
    return json({ error: 'github_state_invalid' }, 400);
  }
  if (record.phase === 'consumed') return json({ error: 'github_state_replayed' }, 400);
  if (record.expiresAt <= Math.floor(Date.now() / 1000)) return json({ error: 'github_state_expired' }, 400);

  const installationId = validInstallationId(url.searchParams.get('installation_id'));
  const code = url.searchParams.get('code');
  if (!installationId && !record.installationId && !code) {
    return json({ error: 'github_installation_missing' }, 400);
  }
  if (url.searchParams.has('setup_action') && !['install', 'update'].includes(url.searchParams.get('setup_action') || '')) {
    return json({ error: 'github_setup_invalid' }, 400);
  }

  try {
    let identity: GithubIdentity | undefined;
    let repository: RepositoryDestination | undefined;
    let generatedRepository: GeneratedRepositoryIdentity | undefined;
    let selectedInstallationId = installationId || record.installationId;

    if (code) {
      const accessToken = await exchangeGithubCode(code, env as Pick<Env, 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET'>, callbackUrl(request));
      // The token is scoped to this request. It is never logged, returned, or
      // passed to KV. The GitHub code is likewise never persisted.
      const authenticatedUser = await getAuthenticatedGithubUser(accessToken);
      if (authenticatedUser.accountType !== 'User') throw new Error('github_organization_installation_not_supported');
      // GitHub normally includes installation_id during OAuth-on-install, but
      // the OAuth callback contract also permits code-only callbacks. Discover
      // this App's installation from the authenticated user's installations in
      // that case rather than trusting an unverified query parameter.
      if (!selectedInstallationId) {
        selectedInstallationId = await findUserInstallation(accessToken, env.GITHUB_APP_ID as string);
      }
      const userInstallation = await getUserInstallation(accessToken, selectedInstallationId);
      const installationIdentityForUser = assertUsablePersonalInstallation(userInstallation, authenticatedUser);
      identity = installationIdentityForUser;
      // Generation happens while the short-lived OAuth token is in memory:
      // creating a repository from the template requires user-to-server
      // authentication. An earlier attempt's generated repository is reused
      // instead of duplicated. Only non-secret destination and repository
      // identity metadata is retained in the job record.
      const ownedRepositories = await listOwnedGithubRepositories(accessToken);
      ({ destination: repository, identity: generatedRepository } = await generateOrReuseRepository(
        accessToken,
        identity.login,
        ownedRepositories,
      ));
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

    if (!identity || !repository || !generatedRepository) return json({ error: 'github_identity_missing' }, 400);

    // Everything after this point — verifying the generated repository is
    // readable, patching its config, enabling Pages, dispatching and
    // awaiting the Notion sync, and awaiting the resulting deploy — no
    // longer needs the short-lived OAuth token in memory: each step mints
    // its own installation token from `selectedInstallationId`, a durable,
    // non-secret identifier. So it moves off this request and onto the
    // durable provisioning queue, which can retry any step independently
    // and survives this Worker restarting mid-pipeline.
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
    try {
      await env.PROVISIONING_QUEUE.send({ jobId: job.jobId });
    } catch (enqueueError) {
      // Without a message nothing will ever process this job, but its record
      // would otherwise sit `queued` until the TTL with no trace of why. Mark
      // the enqueue failure on the job so durable state reflects reality,
      // then let the request surface as a 502.
      const failedStep = nextPendingStep(job);
      if (failedStep) {
        await saveProvisioningJob(env.JOBS, {
          ...job,
          status: 'dead_letter',
          steps: {
            ...job.steps,
            [failedStep]: {
              ...job.steps[failedStep],
              status: 'failed',
              lastError: { code: 'provisioning_enqueue_failed', retryable: false },
            },
          },
          completedAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      throw enqueueError;
    }

    return json({
      ok: true,
      status: 'provisioning',
      job_id: job.jobId,
      installation_id: job.installationId,
      github: { id: identity.id, login: identity.login },
      repository: {
        name: repository.name,
        url: repository.url,
        baseurl: repository.baseurl,
        id: generatedRepository.id,
        html_url: generatedRepository.htmlUrl,
        default_branch: generatedRepository.defaultBranch,
      },
    }, 202);
  } catch (error) {
    return authError(error);
  }
}

/**
 * The production Notion onboarding continuation: while the short-lived access
 * token is still in this request's scope, resolve the duplicated template
 * root into the Pages and Posts database IDs and persist that non-secret
 * resolution for the later provisioning steps. The token itself is never
 * written anywhere. Template-resolution failures surface as distinct,
 * actionable Notion OAuth errors; the programmatic database-creation fallback
 * for a non-duplicated authorization (ADR 0002 §2) is deliberately not
 * implemented yet, so that case fails with `notion_template_not_duplicated`.
 */
export function continueNotionOnboarding(
  env: Partial<Env>,
  runtime: { fetcher?: typeof fetch; sleep?: (milliseconds: number) => Promise<void> } = {},
): NotionOAuthContinuationHandler {
  return async ({ jobId, accessToken, duplicatedTemplateId }) => {
    if (!env.JOBS) throw new NotionOAuthError('notion_configuration_missing', 500);
    try {
      if (!duplicatedTemplateId) throw new NotionTemplateError('notion_template_not_duplicated', 400);
      const resolution = await resolveNotionTemplateDatabases(accessToken, duplicatedTemplateId, {
        fetcher: runtime.fetcher,
        sleep: runtime.sleep,
      });
      await saveNotionTemplateResolution(env.JOBS, { version: 1, jobId, resolution });
    } catch (error) {
      if (error instanceof NotionTemplateError) {
        throw new NotionOAuthError(error.code, error.status, error.details);
      }
      throw error;
    }
  };
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
    return beginNotionAuthorization(request, env);
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
    // The deployed worker resolves the duplicated template inside the Notion
    // callback; `route` keeps the continuation injectable for tests.
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
      } catch {
        // An unexpected failure means this job's KV record could not be
        // read or written. Retry it: Cloudflare's own backoff and
        // max_retries/dead-letter-queue act as the outer safety net for
        // this, rather than the application-level classification in
        // `processProvisioningMessage`.
        message.retry();
      }
    }
  },
};

export default worker;
