/**
 * Post-install status surface.
 *
 * The worker keeps no durable account-to-site binding (the provisioning job
 * record expires and is never an input here), so a returning owner re-proves
 * ownership with a fresh GitHub OAuth authorization, every render re-derives
 * site truth from GitHub with an installation token minted on the spot, and
 * the only retained state is the short-lived signed session cookie in the
 * browser plus the per-account rerun window. Sync and deploy results render
 * from the workflow run conclusion: the versioned run summary is emitted only
 * into in-run step outputs with no REST read-back.
 */

import {
  createGithubInstallationToken,
  getAppInstallation,
  GithubAppAuthError,
  listInstallationRepositories,
  type GithubAppAuthEnv,
  type GithubInstallationAccount,
} from './github-app-auth';
import { userCopy, type ProvisioningFailureCode } from './failures';
import { dispatchNotionSyncWorkflow, GithubSyncError, latestDispatchedSyncRun, latestSyncRun, type NotionSyncRunIdentity } from './notion-sync';
import {
  admitProvisioningRequest,
  admitProvisioningStage,
  consumeGlobalMutationBudget,
  provisioningAdmissionConfig,
  provisioningThrottleConfig,
  withKeyLock,
  type ProvisioningThrottleVars,
} from './provisioning-throttle';
import {
  findReusableGeneratedRepository,
  type GeneratedRepositoryIdentity,
} from './repository-generation';
import { repositoryDestination } from './repository-naming';
import { latestPagesBuild, type GithubPagesBuildIdentity } from './site-deployment';
import { payloadExpired, signSignedPayload, verifySignedPayload } from './signed-payload';
import type { Secret } from './secret';
import { statusPage, statusRefusalPage, type StatusPageChrome } from './status-page';
import {
  exchangeGithubCode,
  findUserInstallation,
  getAuthenticatedGithubUser,
  GithubApiError,
} from './github-user-auth';

/** The bindings and secrets the status surface needs; structurally part of
 * `Env`, declared here so this module never imports `index.ts`. The throttle
 * vars ride along because the rerun POST feeds the whole env to the shared
 * admission and budget config parsers. */
export interface StatusEnv extends GithubAppAuthEnv, ProvisioningThrottleVars {
  JOBS: KVNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

export const STATUS_SESSION_COOKIE = '__Host-status-session';
export const STATUS_STATE_COOKIE = '__Host-status-state';
export const STATUS_SESSION_TTL_SECONDS = 8 * 60 * 60;
export const STATUS_STATE_TTL_SECONDS = 10 * 60;
/** Meta-refresh cadence while a sync run is in flight; no-JS-safe polling. */
export const STATUS_REFRESH_SECONDS = 30;
/** A dispatch run still non-completed after this long is treated as stuck:
 * the page stops auto-refreshing and a manual re-run is allowed to proceed
 * rather than answering `already_running` forever. */
export const STATUS_RUN_STUCK_SECONDS = 60 * 60;

/**
 * Signed browser session. No secrets inside: every field is identity GitHub
 * proved during the authorize leg, and the HMAC key (GITHUB_CLIENT_SECRET)
 * never leaves the server. The cookie is the only durable-ish artifact the
 * status surface creates, and it lives in the browser, not in KV.
 */
export interface StatusSession {
  v: 1;
  /** GitHub numeric user id proved by the authorize leg. */
  accountId: number;
  login: string;
  /** Installation of our GitHub App that GitHub proved this account holds. */
  installationId: number;
  /** Epoch seconds. Hard expiry; no sliding renewal. */
  exp: number;
}

const SESSION_KIND = 'status-session';
const STATE_KIND = 'status-state';
const FORM_KIND = 'status-form';

/** Authorize-leg state. The `k` kind marks it so an install-state token can
 * never verify as a status payload. */
export interface StatusStatePayload {
  v: 1;
  k: typeof STATE_KIND;
  nonce: string;
  exp: number;
}

export function statusStatePayload(nowSeconds: number): StatusStatePayload {
  return {
    v: 1,
    k: STATE_KIND,
    nonce: crypto.randomUUID(),
    exp: nowSeconds + STATUS_STATE_TTL_SECONDS,
  };
}

export function signStatusState(payload: StatusStatePayload, secret: string): Promise<string> {
  return signSignedPayload(payload, secret);
}

/** Signature, kind, and shape only — no expiry check, so an expired state
 * still routes to the status finisher, which reports it as a failed sign-in
 * instead of the install leg's generic refusal. */
export async function isStatusCallbackState(encoded: string, secret: string): Promise<boolean> {
  return (await verifySignedPayload<StatusStatePayload>(encoded, secret, (payload) =>
    payload.k === STATE_KIND &&
    payload.v === 1 &&
    typeof payload.nonce === 'string')) !== null;
}

export async function verifyStatusState(
  encoded: string,
  secret: string,
  nowSeconds: number,
): Promise<StatusStatePayload | null> {
  return verifySignedPayload<StatusStatePayload>(encoded, secret, (payload) =>
    payload.k === STATE_KIND &&
    payload.v === 1 &&
    typeof payload.nonce === 'string' &&
    !payloadExpired(payload.exp, nowSeconds));
}

export async function signStatusSession(session: StatusSession, secret: string): Promise<string> {
  return signSignedPayload({ k: SESSION_KIND, ...session }, secret);
}

/** Verify signature, expiry, and field shapes once at the cookie boundary;
 * inside the request the session type is trusted. */
export async function readStatusSession(request: Request, secret: string): Promise<StatusSession | null> {
  const encoded = cookieValue(request, STATUS_SESSION_COOKIE);
  if (encoded === null) return null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = await verifySignedPayload<StatusSession & { k: string }>(encoded, secret, (candidate) =>
    candidate.k === SESSION_KIND &&
    candidate.v === 1 &&
    Number.isSafeInteger(candidate.accountId) && (candidate.accountId as number) > 0 &&
    typeof candidate.login === 'string' && (candidate.login as string).length >= 1 && (candidate.login as string).length <= 100 &&
    Number.isSafeInteger(candidate.installationId) && (candidate.installationId as number) > 0 &&
    !payloadExpired(candidate.exp, nowSeconds));
  if (payload === null) return null;
  const { v, accountId, login, installationId, exp } = payload;
  return { v, accountId, login, installationId, exp };
}

/** Stateless CSRF proof for the rerun form, bound to the session it serves:
 * the token carries the session's account id and expiry, so a token from an
 * expired or foreign session never verifies. */
export async function signRerunToken(session: StatusSession, secret: string): Promise<string> {
  return signSignedPayload({ v: 1, k: FORM_KIND, accountId: session.accountId, exp: session.exp }, secret);
}

export async function rerunTokenValid(
  token: string,
  session: StatusSession,
  secret: string,
  nowSeconds: number,
): Promise<boolean> {
  const payload = await verifySignedPayload<{ accountId: number; exp: number }>(token, secret, (candidate) =>
    candidate.k === FORM_KIND &&
    candidate.v === 1 &&
    candidate.accountId === session.accountId &&
    candidate.exp === session.exp);
  return payload !== null && !payloadExpired(payload.exp, nowSeconds);
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(value.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export type SyncOutcome =
  | { kind: 'never_ran' }
  | { kind: 'running'; startedAtMs: number | null; runUrl: string | null }
  | { kind: 'succeeded'; finishedAtMs: number | null; runUrl: string | null }
  | { kind: 'failed'; conclusion: string; finishedAtMs: number | null; runUrl: string | null };

export type DeployOutcome =
  | { kind: 'never_built' }
  | { kind: 'building' }
  | { kind: 'built'; commitSha: string | null }
  | { kind: 'errored' };

/** One page render's worth of GitHub truth. Parsed at the provider-reader
 * boundary; the projection never sees raw provider shapes. `accountLogin` is
 * the installation account's login as GitHub just reported it, so a rename
 * between sign-ins renders correctly instead of failing the cross-check. */
export type SiteDiscovery =
  | {
      ok: true;
      accountLogin: string;
      repository: GeneratedRepositoryIdentity;
      syncRun: NotionSyncRunIdentity | null;
      build: GithubPagesBuildIdentity | null;
    }
  | {
      ok: false;
      reason: 'installation_gone' | 'installation_suspended' | 'no_site' | 'unavailable';
      retryAfterSeconds: number | null;
    };

export interface SiteStatus {
  repository: { name: string; url: string };
  site: { url: string };
  sync: SyncOutcome;
  deploy: DeployOutcome;
  /** Meta-refresh hint; non-null only while a sync run is in flight. */
  refreshAfterSeconds: number | null;
}

/** The discriminated union of every page state a signed-in visitor can reach.
 * Rendering is total over it. `auth_failed` is produced only by the callback
 * and rerun refusals, never by the projection. */
export type StatusView =
  | { kind: 'session'; viewer: { login: string }; site: SiteStatus }
  | { kind: 'no_site'; viewer: { login: string } }
  | { kind: 'installation_gone'; viewer: { login: string } }
  | { kind: 'installation_suspended'; viewer: { login: string } }
  | { kind: 'github_unavailable'; retryAfterSeconds: number | null }
  | { kind: 'auth_failed'; reason: 'denied' | 'state_invalid' | 'no_installation' };

/** The entry page (no session) joins the union so one renderer covers all. */
export type StatusPageModel = { kind: 'entry' } | StatusView;

function epochMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parse-guard for the versioned run summary (notiongit-sync, schema v1). No
 * src caller exists because GitHub exposes no read-back for step outputs or
 * step summaries; the notiongit-sync summary-channel follow-up calls this
 * once a readable channel exists. Non-JSON, non-object, or shape-violating
 * payloads are `malformed`; a documented shape carrying a different
 * `schema_version` is `unsupported_version`; within v1 an unknown `code` is
 * accepted as-is and the caller falls back on `result` alone.
 */
export type SafeSummaryResult = 'success' | 'no_op' | 'failure';

export type SafeSummaryParse =
  | { ok: true; source: 'summary_v1'; result: SafeSummaryResult; code: string | null; finishedAtMs: number | null }
  | { ok: false; reason: 'malformed' | 'unsupported_version' };

export function parseSafeSummary(text: string): SafeSummaryParse {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (payload === null || typeof payload !== 'object') return { ok: false, reason: 'malformed' };
  const record = payload as Record<string, unknown>;
  if (typeof record.schema_version !== 'number') return { ok: false, reason: 'malformed' };
  if (record.schema_version !== 1) return { ok: false, reason: 'unsupported_version' };
  if (record.result !== 'success' && record.result !== 'no_op' && record.result !== 'failure') {
    return { ok: false, reason: 'malformed' };
  }
  return {
    ok: true,
    source: 'summary_v1',
    result: record.result,
    code: typeof record.code === 'string' ? record.code : null,
    finishedAtMs: typeof record.finished_at === 'string' ? epochMs(record.finished_at) : null,
  };
}

function syncOutcomeOf(run: NotionSyncRunIdentity): SyncOutcome {
  const runUrl = run.htmlUrl || null;
  if (run.status !== 'completed') {
    return { kind: 'running', startedAtMs: run.createdAtMs, runUrl };
  }
  if (run.conclusion === 'success') {
    return { kind: 'succeeded', finishedAtMs: run.updatedAtMs ?? run.createdAtMs, runUrl };
  }
  return {
    kind: 'failed',
    conclusion: run.conclusion ?? 'unknown',
    finishedAtMs: run.updatedAtMs ?? run.createdAtMs,
    runUrl,
  };
}

function deployOutcomeOf(build: GithubPagesBuildIdentity | null): DeployOutcome {
  if (build === null) return { kind: 'never_built' };
  if (build.status === 'building') return { kind: 'building' };
  if (build.status === 'errored') return { kind: 'errored' };
  return { kind: 'built', commitSha: build.commitSha };
}

/** The Pages URL policy fails only on a login or repository name outside
 * GitHub's own shape; both come from GitHub here, so the fallback is a
 * near-unreachable guard that keeps the projection total. */
function siteUrl(login: string, repositoryName: string, fallback: string): string {
  try {
    return repositoryDestination(login, repositoryName).url;
  } catch {
    return fallback;
  }
}

/** The pure projection: total, env-free, the unit that makes rendering
 * provable. `nowMs` ages the
 * in-flight run: past `STATUS_RUN_STUCK_SECONDS` the meta-refresh hint is
 * dropped so an open tab stops polling, while the panel keeps saying the run
 * is in flight — only GitHub can prove otherwise. */
export function projectSiteStatus(discovery: SiteDiscovery, session: StatusSession, nowMs: number): StatusView {
  const viewerLogin = discovery.ok ? discovery.accountLogin : session.login;
  if (!discovery.ok) {
    if (discovery.reason === 'unavailable') {
      return { kind: 'github_unavailable', retryAfterSeconds: discovery.retryAfterSeconds };
    }
    return { kind: discovery.reason, viewer: { login: viewerLogin } };
  }
  const syncRunning = discovery.syncRun !== null && discovery.syncRun.status !== 'completed';
  const runStuck = discovery.syncRun !== null && syncRunning && !runIsFreshlyInFlight(discovery.syncRun, nowMs);
  return {
    kind: 'session',
    viewer: { login: viewerLogin },
    site: {
      repository: { name: discovery.repository.name, url: discovery.repository.htmlUrl },
      site: { url: siteUrl(viewerLogin, discovery.repository.name, discovery.repository.htmlUrl) },
      sync: discovery.syncRun === null ? { kind: 'never_ran' } : syncOutcomeOf(discovery.syncRun),
      deploy: deployOutcomeOf(discovery.build),
      refreshAfterSeconds: syncRunning && !runStuck ? STATUS_REFRESH_SECONDS : null,
    },
  };
}

/** True when a run of the sync workflow is in flight and young enough that
 * waiting is still the right answer; the rerun convergence check and the
 * projection's refresh hint share this definition of "in flight". */
export function runIsFreshlyInFlight(run: NotionSyncRunIdentity, nowMs: number): boolean {
  if (run.status === 'completed') return false;
  const startedAgoMs = run.createdAtMs !== null ? nowMs - run.createdAtMs : 0;
  return startedAgoMs <= STATUS_RUN_STUCK_SECONDS * 1000;
}

function discoveryFailure(error: unknown): SiteDiscovery {
  if (error instanceof GithubAppAuthError) {
    if (error.status === 404) return { ok: false, reason: 'installation_gone', retryAfterSeconds: null };
    return { ok: false, reason: 'unavailable', retryAfterSeconds: error.retryAfterSeconds };
  }
  return { ok: false, reason: 'unavailable', retryAfterSeconds: null };
}

/**
 * The one place GitHub reads happen, shared by render and rerun, in
 * fail-fast order. A stale cookie cannot ride a transferred or reinstalled
 * installation: the installation's account id must still be the session's.
 * The login is not re-checked — the id is the identity GitHub proved, and a
 * rename between sign-ins would otherwise deny a real owner for the life of
 * the session; the fresh login rides back to the projection instead. A
 * failed read is distinct from a successful read with zero rows — only the
 * latter yields `no_site` / `never_ran` / `never_built`, so a GitHub
 * brownout never renders as "you have no site".
 */
export async function discoverSite(
  appAuth: GithubAppAuthEnv,
  session: StatusSession,
  fetcher: typeof fetch = fetch,
): Promise<SiteDiscovery> {
  let installation: GithubInstallationAccount;
  try {
    installation = await getAppInstallation(appAuth, session.installationId, fetcher);
  } catch (error) {
    return discoveryFailure(error);
  }
  if (installation.suspended_at || installation.suspended_by) {
    return { ok: false, reason: 'installation_suspended', retryAfterSeconds: null };
  }
  const account = installation.account;
  if (!account || account.id !== session.accountId) {
    return { ok: false, reason: 'installation_gone', retryAfterSeconds: null };
  }
  const accountLogin = typeof account.login === 'string' && account.login ? account.login : session.login;

  let installationToken: Secret<'github-installation'>;
  try {
    installationToken = await createGithubInstallationToken(appAuth, session.installationId, fetcher);
  } catch (error) {
    return discoveryFailure(error);
  }

  let repository: GeneratedRepositoryIdentity | null;
  try {
    repository = findReusableGeneratedRepository(
      await listInstallationRepositories(installationToken.raw, fetcher),
      session.login,
    );
  } catch (error) {
    return discoveryFailure(error);
  }
  if (repository === null) {
    return { ok: false, reason: 'no_site', retryAfterSeconds: null };
  }

  let syncRun: NotionSyncRunIdentity | null;
  let build: GithubPagesBuildIdentity | null;
  try {
    [syncRun, build] = await Promise.all([
      latestDispatchedSyncRun(installationToken.raw, repository.fullName, fetcher),
      latestPagesBuild(installationToken.raw, repository.fullName, fetcher),
    ]);
  } catch (error) {
    return discoveryFailure(error);
  }
  return { ok: true, accountLogin, repository, syncRun, build };
}

/**
 * Fixed limits for the manual re-run. Plain constants rather than the
 * throttle's env-var pattern: the rerun shares the provisioning mutation
 * budget already, and these two numbers have no operator tuning story.
 */
export const STATUS_RERUN_SPACING_SECONDS = 300;
export const STATUS_RERUN_DAILY_LIMIT = 10;
export const STATUS_RERUN_WINDOW_SECONDS = 24 * 60 * 60;

export const STATUS_RERUN_KEY_PREFIX = 'status:rerun:';

/** Value of `status:rerun:<accountId>`. Numeric account id only — never a login or token. */
export interface StatusRerunWindow {
  version: 1;
  windowStartedAt: number;
  lastRerunAt: number;
  count: number;
}

export function statusRerunKey(accountId: number): string {
  return `${STATUS_RERUN_KEY_PREFIX}${accountId}`;
}

export type StatusRerunAdmission =
  | { admitted: true }
  | { admitted: false; reason: 'spacing' | 'daily_cap' | 'unavailable'; retryAfterSeconds: number };

function validRerunWindow(value: unknown): value is StatusRerunWindow {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    Number.isSafeInteger(record.windowStartedAt) &&
    Number.isSafeInteger(record.lastRerunAt) &&
    Number.isSafeInteger(record.count) &&
    (record.count as number) >= 0
  );
}

/**
 * Consume one slot in the account's rerun window, written BEFORE the caller
 * dispatches so a crash in between overcounts — the conservative direction,
 * the same budget pattern the provisioning throttle uses. Within a window,
 * two reruns must sit at least `STATUS_RERUN_SPACING_SECONDS` apart and the
 * window admits at most `STATUS_RERUN_DAILY_LIMIT` of them; rolling to a
 * fresh window resets both (the cap, not the spacing, is the abuse bound).
 * A corrupted or unreadable record fails closed: a missed manual re-run only
 * delays a sync, while admitting on one could defeat the cap.
 */
export async function admitStatusRerun(
  kv: KVNamespace,
  accountId: number,
  nowMs: number,
): Promise<StatusRerunAdmission> {
  const key = statusRerunKey(accountId);
  return withKeyLock(key, async (): Promise<StatusRerunAdmission> => {
    let stored: StatusRerunWindow | null | 'corrupted';
    try {
      const value: unknown = await kv.get(key, 'json');
      stored = value === null || validRerunWindow(value) ? (value as StatusRerunWindow | null) : 'corrupted';
    } catch {
      stored = 'corrupted';
    }
    if (stored === 'corrupted') {
      return { admitted: false, reason: 'unavailable', retryAfterSeconds: STATUS_RERUN_SPACING_SECONDS };
    }

    let windowStartedAt: number;
    let count: number;
    let lastRerunAt: number;
    if (stored === null || stored.windowStartedAt + STATUS_RERUN_WINDOW_SECONDS * 1000 <= nowMs) {
      windowStartedAt = nowMs;
      count = 0;
      lastRerunAt = 0;
    } else {
      windowStartedAt = stored.windowStartedAt;
      count = stored.count;
      lastRerunAt = stored.lastRerunAt;
    }
    const windowEndsAt = windowStartedAt + STATUS_RERUN_WINDOW_SECONDS * 1000;
    if (count >= STATUS_RERUN_DAILY_LIMIT) {
      return {
        admitted: false,
        reason: 'daily_cap',
        retryAfterSeconds: Math.max(Math.ceil((windowEndsAt - nowMs) / 1000), 1),
      };
    }
    if (nowMs < lastRerunAt + STATUS_RERUN_SPACING_SECONDS * 1000) {
      return {
        admitted: false,
        reason: 'spacing',
        retryAfterSeconds: Math.max(Math.ceil((lastRerunAt + STATUS_RERUN_SPACING_SECONDS * 1000 - nowMs) / 1000), 1),
      };
    }

    const updated: StatusRerunWindow = { version: 1, windowStartedAt, lastRerunAt: nowMs, count: count + 1 };
    await kv.put(key, JSON.stringify(updated), {
      expirationTtl: Math.max(Math.ceil((windowEndsAt - nowMs) / 1000), 60),
    });
    return { admitted: true };
  });
}

function statusHtml(document: string, status = 200, cookies: string[] = [], retryAfterSeconds: number | null = null): Response {
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  if (retryAfterSeconds !== null) headers.set('retry-after', String(retryAfterSeconds));
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(document, { status, headers });
}

function redirectResponse(status: 302 | 303, location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status, headers });
}

function configMissingResponse(): Response {
  return new Response(JSON.stringify({ error: 'github_configuration_missing' }), {
    status: 500,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function stateCookie(nonce: string): string {
  return `${STATUS_STATE_COOKIE}=${encodeURIComponent(nonce)}; Max-Age=${STATUS_STATE_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

const CLEAR_STATE_COOKIE = `${STATUS_STATE_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

function sessionCookie(token: string): string {
  return `${STATUS_SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${STATUS_SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function noticeOf(url: URL): StatusPageChrome['notice'] {
  const notice = url.searchParams.get('notice');
  return notice === 'signin_required' || notice === 'sync_triggered' || notice === 'already_running' ? notice : null;
}

function refusedResponse(code: ProvisioningFailureCode, status: number, retryAfterSeconds: number | null): Response {
  const copy = userCopy(code);
  return statusHtml(
    statusRefusalPage({ title: copy.message, body: copy.action, retryAfterSeconds }),
    status,
    [],
    retryAfterSeconds,
  );
}

/** `GET /status`. No session renders the entry page (or the authorize
 * redirect for `?connect=1`); a session re-derives the site from GitHub. */
export async function statusHome(request: Request, env: Partial<StatusEnv>): Promise<Response> {
  const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY } = env;
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET || !GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    return configMissingResponse();
  }
  const url = new URL(request.url);
  // `?connect=1` is handled before the session read, not only for
  // sessionless visitors: re-running the authorize leg with a live session is
  // the "sign in as a different account" path that the no-site page's
  // remediation copy points at.
  if (url.searchParams.get('connect') === '1') {
    const payload = statusStatePayload(Math.floor(Date.now() / 1000));
    const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
    authorizeUrl.searchParams.set('client_id', GITHUB_CLIENT_ID);
    authorizeUrl.searchParams.set('redirect_uri', new URL('/auth/github/callback', request.url).toString());
    authorizeUrl.searchParams.set('state', await signStatusState(payload, GITHUB_CLIENT_SECRET));
    return redirectResponse(302, authorizeUrl.toString(), [stateCookie(payload.nonce)]);
  }

  const session = await readStatusSession(request, GITHUB_CLIENT_SECRET);
  if (!session) {
    return statusHtml(statusPage({ kind: 'entry' }, { notice: noticeOf(url), rerunFormToken: null }));
  }

  const discovery = await discoverSite({ GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY }, session);
  const view = projectSiteStatus(discovery, session, Date.now());
  return statusHtml(statusPage(view, {
    notice: noticeOf(url),
    rerunFormToken: await signRerunToken(session, GITHUB_CLIENT_SECRET),
  }));
}

/**
 * The status leg of the shared GitHub OAuth callback, dispatched from
 * `finishGithubCallback` when the signed state proves its `status` kind.
 * Everything the session carries — account, login, installation — derives
 * from the identity GitHub just proved; nothing is trusted from the state
 * payload beyond its kind and nonce, so a session can never name another
 * user's installation. Zero KV writes: the state nonce lives only in the
 * double-submit cookie, cleared on every response, which is the replay
 * defense. The user access token dies inside this request.
 */
export async function statusCallback(request: Request, env: Partial<StatusEnv>): Promise<Response> {
  const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_APP_ID } = env;
  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET || !GITHUB_APP_ID) {
    return configMissingResponse();
  }
  const authFailed = (reason: 'denied' | 'state_invalid' | 'no_installation' = 'state_invalid'): Response =>
    statusHtml(statusPage({ kind: 'auth_failed', reason }, { notice: null, rerunFormToken: null }), 400, [CLEAR_STATE_COOKIE]);
  const githubUnavailable = (): Response =>
    statusHtml(
      statusPage({ kind: 'github_unavailable', retryAfterSeconds: null }, { notice: null, rerunFormToken: null }),
      502,
      [CLEAR_STATE_COOKIE],
    );

  const url = new URL(request.url);
  if (url.searchParams.has('error')) return authFailed('denied');
  const encodedState = url.searchParams.get('state');
  if (!encodedState) return authFailed();
  const payload = await verifyStatusState(encodedState, GITHUB_CLIENT_SECRET, Math.floor(Date.now() / 1000));
  if (!payload) return authFailed();
  if (cookieValue(request, STATUS_STATE_COOKIE) !== payload.nonce) return authFailed();
  const code = url.searchParams.get('code');
  if (!code) return authFailed();

  try {
    const userToken = await exchangeGithubCode(
      code,
      { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET },
      new URL('/auth/github/callback', request.url).toString(),
    );
    const authenticatedUser = await getAuthenticatedGithubUser(userToken.bearer());
    const installationId = await findUserInstallation(userToken.bearer(), GITHUB_APP_ID, authenticatedUser.id);
    const session: StatusSession = {
      v: 1,
      accountId: authenticatedUser.id,
      login: authenticatedUser.login,
      installationId,
      exp: Math.floor(Date.now() / 1000) + STATUS_SESSION_TTL_SECONDS,
    };
    return redirectResponse(303, new URL('/status', request.url).toString(), [
      sessionCookie(await signStatusSession(session, GITHUB_CLIENT_SECRET)),
      CLEAR_STATE_COOKIE,
    ]);
  } catch (error) {
    // GitHub auth failures are a failed sign-in; a rate limit or outage is
    // GitHub being unreachable. No provider detail reaches either page.
    if (!(error instanceof GithubApiError) || error.status === 429 || error.status >= 500) return githubUnavailable();
    if (error.status === 404) return authFailed('no_installation');
    return authFailed();
  }
}

/**
 * `POST /status/rerun`. Gate order: origin, session, form token, IP burst,
 * admission stage, discovery (failure arms render as pages, since there is
 * then nothing to re-run), live-run convergence (a stuck run does not gate —
 * waiting forever is worse than a rare double dispatch), global budget, then
 * the per-account window immediately before the dispatch. The window slot is
 * consumed before the dispatch so a crash overcounts conservatively, and
 * after the budget check so an infrastructure refusal never spends one of
 * the account's own daily slots.
 */
export async function statusRerun(request: Request, env: Partial<StatusEnv>): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== url.origin) {
    return statusHtml(statusPage({ kind: 'auth_failed', reason: 'state_invalid' }, { notice: null, rerunFormToken: null }), 403);
  }

  const { JOBS, GITHUB_CLIENT_SECRET, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY } = env;
  if (!JOBS || !GITHUB_CLIENT_SECRET || !GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY) {
    return configMissingResponse();
  }

  const session = await readStatusSession(request, GITHUB_CLIENT_SECRET);
  if (!session) {
    return redirectResponse(303, new URL('/status?notice=signin_required', request.url).toString());
  }

  const form = await request.formData().catch(() => null);
  const token = form?.get('token');
  if (
    typeof token !== 'string' ||
    !(await rerunTokenValid(token, session, GITHUB_CLIENT_SECRET, Math.floor(Date.now() / 1000)))
  ) {
    return statusHtml(statusPage({ kind: 'auth_failed', reason: 'state_invalid' }, { notice: null, rerunFormToken: null }), 403);
  }

  const admissionConfig = provisioningAdmissionConfig(env);
  // No jobId exists on this leg; the burst bucket needs a per-request label
  // only, so its audit rows stay keyed without inventing a durable id.
  const requestLabel = crypto.randomUUID();
  const burst = await admitProvisioningRequest(env as StatusEnv, admissionConfig, {
    request,
    jobId: requestLabel,
    hmacSecret: GITHUB_CLIENT_SECRET,
  }, Date.now(), 'status_rerun');
  if (burst.action !== 'allow') {
    return statusThrottleRefusal(burst.reason, burst.retryAfterSeconds);
  }
  const stage = await admitProvisioningStage(env as StatusEnv, admissionConfig, {
    stage: 'status_rerun',
    jobId: requestLabel,
    accountId: session.accountId,
  }, Date.now());
  if (stage.action !== 'allow') {
    return statusThrottleRefusal(stage.reason, stage.retryAfterSeconds);
  }

  const discovery = await discoverSite({ GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY }, session);
  if (!discovery.ok) {
    return statusHtml(statusPage(projectSiteStatus(discovery, session, Date.now()), { notice: null, rerunFormToken: null }));
  }
  const repository = discovery.repository;

  // The convergence check: a live dispatch run means this click would only
  // duplicate it. The read is unfiltered so a scheduled run mid-flight also
  // converges, and a run stuck non-completed past STATUS_RUN_STUCK_SECONDS
  // stops gating — the owner can force a fresh dispatch.
  if (discovery.syncRun !== null && runIsFreshlyInFlight(discovery.syncRun, Date.now())) {
    return redirectResponse(303, new URL('/status?notice=already_running', request.url).toString());
  }
  try {
    const installationToken = await createGithubInstallationToken({ GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY }, session.installationId);
    const anyLiveRun = await latestSyncRun(installationToken.raw, repository.fullName);
    if (anyLiveRun !== null && runIsFreshlyInFlight(anyLiveRun, Date.now())) {
      return redirectResponse(303, new URL('/status?notice=already_running', request.url).toString());
    }
  } catch {
    // The convergence read is best-effort; the dispatch path below classifies
    // its own failures.
  }

  const budget = await consumeGlobalMutationBudget(JOBS, provisioningThrottleConfig(env), Date.now(), Math.random);
  if (!budget.admitted) {
    return refusedResponse('github_rate_limited', 429, budget.delaySeconds);
  }

  const rerunWindow = await admitStatusRerun(JOBS, session.accountId, Date.now());
  if (!rerunWindow.admitted) {
    // Status-specific copy: this window is the status page's own quota, not a
    // provider or provisioning limit, so the registry copy would misname it.
    const copy = {
      spacing: {
        title: 'That was quick',
        body: 'You just started a sync. Give it a few minutes before starting another.',
      },
      daily_cap: {
        title: 'That is all the syncs for today',
        body: 'This site has used its manual syncs for today. The scheduled sync still runs as usual.',
      },
      unavailable: {
        title: 'We could not check your sync limit',
        body: 'InkDrafts could not read this site\u2019s manual-sync quota just now, so it held off rather than risk exceeding it. Try again in a few minutes; the scheduled sync is unaffected.',
      },
    } as const;
    const refusal = copy[rerunWindow.reason];
    return statusHtml(
      statusRefusalPage({ ...refusal, retryAfterSeconds: rerunWindow.retryAfterSeconds }),
      rerunWindow.reason === 'unavailable' ? 503 : 429,
      [],
      rerunWindow.retryAfterSeconds,
    );
  }

  try {
    const installationToken = await createGithubInstallationToken({ GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY }, session.installationId);
    await dispatchNotionSyncWorkflow(installationToken.raw, repository.fullName);
  } catch (error) {
    if (error instanceof GithubSyncError) {
      return refusedResponse(error.code, error.status, error.retryAfterSeconds);
    }
    if (error instanceof GithubAppAuthError) {
      return refusedResponse(error.code, error.status === 429 ? 429 : 502, error.retryAfterSeconds);
    }
    return refusedResponse('github_app_unavailable', 502, null);
  }

  return redirectResponse(303, new URL('/status?notice=sync_triggered', request.url).toString());
}

/** Throttle refusals on this surface are about syncing, not about setup, so
 * they carry status-local copy and the canonical status: operator pause or
 * kill is 503 (do not retry into an emergency stop), a burst or budget hit is
 * 429. `reason` is the throttle's reason union, not a failure-code. */
function statusThrottleRefusal(reason: string, retryAfterSeconds: number | null): Response {
  const paused = reason !== 'request_burst';
  const copy = paused
    ? { title: 'Manual syncing is paused', body: 'InkDrafts has paused manual syncs right now. The scheduled sync is unaffected; try again later.' }
    : { title: 'Too many requests', body: 'A burst of requests just came through, so this one was held back. Wait a moment and try again.' };
  return statusHtml(
    statusRefusalPage({ ...copy, retryAfterSeconds }),
    paused ? 503 : 429,
    [],
    retryAfterSeconds,
  );
}
