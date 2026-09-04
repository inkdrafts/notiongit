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
 * into in-run step outputs with no REST read-back, so `parseSafeSummary` here
 * is the tested boundary for a future summary channel, not a live path.
 */

import {
  createGithubInstallationToken,
  getAppInstallation,
  GithubAppAuthError,
  listInstallationRepositories,
  type GithubAppAuthEnv,
  type GithubInstallationAccount,
} from './github-app-auth';
import {
  findReusableGeneratedRepository,
  type GeneratedRepositoryIdentity,
} from './repository-generation';
import { repositoryDestination } from './repository-naming';
import { latestDispatchedSyncRun, type NotionSyncRunIdentity } from './notion-sync';
import { latestPagesBuild, type GithubPagesBuildIdentity } from './site-deployment';
import { payloadExpired, signSignedPayload, verifySignedPayload } from './signed-payload';
import { withKeyLock } from './provisioning-throttle';
import type { Secret } from './secret';

/** The bindings and secrets the status surface needs; structurally part of
 * `Env`, declared here so this module never imports `index.ts`. */
export interface StatusEnv extends GithubAppAuthEnv {
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
 * never verify as a status payload and vice versa; `purpose` restates the leg
 * for symmetry with the install state's absent-means-install rule. */
export interface StatusStatePayload {
  v: 1;
  k: typeof STATE_KIND;
  purpose: 'status';
  nonce: string;
  exp: number;
}

export function statusStatePayload(nowSeconds: number): StatusStatePayload {
  return {
    v: 1,
    k: STATE_KIND,
    purpose: 'status',
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
    payload.purpose === 'status' &&
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
    payload.purpose === 'status' &&
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

/** Where a rendered sync result came from. Today the page can only derive
 * results from the workflow run conclusion; `parseSafeSummary` is the tested
 * boundary for a future summary channel, whose `no_op` result has no
 * representation in `SyncOutcome` — a conclusion alone cannot distinguish a
 * no-op from a content-bearing success, so the fallback never claims one. */
export type SyncResultSource = 'conclusion_fallback';

export type SyncOutcome =
  | { kind: 'never_ran' }
  | { kind: 'running'; startedAtMs: number | null; runUrl: string | null }
  | { kind: 'succeeded'; source: SyncResultSource; finishedAtMs: number | null; runUrl: string | null }
  | { kind: 'failed'; source: SyncResultSource; conclusion: string; finishedAtMs: number | null; runUrl: string | null };

export type DeployOutcome =
  | { kind: 'never_built' }
  | { kind: 'building' }
  | { kind: 'built'; commitSha: string | null }
  | { kind: 'errored' };

/** One page render's worth of GitHub truth. Parsed at the provider-reader
 * boundary; the projection never sees raw provider shapes. */
export type SiteDiscovery =
  | {
      ok: true;
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
  | { kind: 'auth_failed'; reason: 'denied' | 'state_invalid' };

/** The entry page (no session) joins the union so one renderer covers all. */
export type StatusPageModel = { kind: 'entry' } | StatusView;

function epochMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parse-guard for the versioned run summary (notiongit-sync, schema v1).
 * Today no src caller exists: the summary is emitted only into step outputs
 * and the step summary, neither retrievable after the run, so this is the
 * documented boundary for the notiongit-sync follow-up that will publish it
 * somewhere readable. Non-JSON, non-object, or shape-violating payloads are
 * `malformed`; a documented shape carrying a different `schema_version` is
 * `unsupported_version`; within v1 an unknown `code` is accepted as-is and
 * the caller falls back on `result` alone.
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
    return { kind: 'succeeded', source: 'conclusion_fallback', finishedAtMs: run.updatedAtMs ?? run.createdAtMs, runUrl };
  }
  return {
    kind: 'failed',
    source: 'conclusion_fallback',
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
 * provable. The `succeeded` arm has exactly one construction site — the
 * `conclusion === 'success'` comparison in `syncOutcomeOf`. */
export function projectSiteStatus(discovery: SiteDiscovery, session: StatusSession): StatusView {
  if (!discovery.ok) {
    if (discovery.reason === 'unavailable') {
      return { kind: 'github_unavailable', retryAfterSeconds: discovery.retryAfterSeconds };
    }
    return { kind: discovery.reason, viewer: { login: session.login } };
  }
  const syncRunning = discovery.syncRun !== null && discovery.syncRun.status !== 'completed';
  return {
    kind: 'session',
    viewer: { login: session.login },
    site: {
      repository: { name: discovery.repository.name, url: discovery.repository.htmlUrl },
      site: { url: siteUrl(session.login, discovery.repository.name, discovery.repository.htmlUrl) },
      sync: discovery.syncRun === null ? { kind: 'never_ran' } : syncOutcomeOf(discovery.syncRun),
      deploy: deployOutcomeOf(discovery.build),
      refreshAfterSeconds: syncRunning ? STATUS_REFRESH_SECONDS : null,
    },
  };
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
 * installation: the installation's account must still match the session. A
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
  if (
    !account ||
    account.id !== session.accountId ||
    typeof account.login !== 'string' ||
    account.login.toLowerCase() !== session.login.toLowerCase()
  ) {
    return { ok: false, reason: 'installation_gone', retryAfterSeconds: null };
  }

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
  return { ok: true, repository, syncRun, build };
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
 * the same budget pattern the provisioning throttle uses. The fixed window
 * admits `STATUS_RERUN_DAILY_LIMIT` reruns over `STATUS_RERUN_WINDOW_SECONDS`,
 * and two reruns must sit at least `STATUS_RERUN_SPACING_SECONDS` apart. A
 * corrupted or unreadable record fails closed: a missed manual re-run only
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
