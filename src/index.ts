/**
 * InkDrafts' edge entrypoint.
 *
 * GitHub's OAuth code and all access tokens are deliberately kept inside the
 * request that uses them. KV contains only the signed-state replay marker and
 * the resulting GitHub identity/installation and destination metadata.
 */

import {
  GithubRepositoryApiError,
  selectGithubRepositoryDestination,
  type RepositoryDestination,
} from './repository-naming';

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

export interface GithubOnboardingResult {
  jobId: string;
  installationId: number;
  identity: GithubIdentity;
  repository: RepositoryDestination;
}

const GITHUB_API = 'https://api.github.com';
const GITHUB_INSTALL_URL = 'https://github.com/apps';
const GITHUB_API_VERSION = '2022-11-28';
const STATE_TTL_SECONDS = 10 * 60;
const STATE_REPLAY_TTL_SECONDS = 60 * 60;
const JOB_TTL_SECONDS = 24 * 60 * 60;
const STATE_PREFIX = 'github:oauth-state:';
const JOB_PREFIX = 'github:onboarding-job:';

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

const LANDING_PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>InkDrafts</title></head>
  <body><main><h1>InkDrafts</h1><p>Notion-powered publishing for GitHub Pages.</p></main></body>
</html>`;

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

interface GithubJobRecord {
  version: 1;
  jobId: string;
  status: 'github_authorized';
  installationId: number;
  identity: GithubIdentity;
  repository: RepositoryDestination;
  completedAt: number;
}

interface GithubUserResponse {
  id?: number;
  login?: string;
  type?: string;
}

interface GithubInstallationResponse {
  account?: {
    id?: number;
    login?: string;
    type?: string;
  };
  suspended_at?: string | null;
  suspended_by?: unknown;
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

function jobKey(jobId: string): string {
  return `${JOB_PREFIX}${jobId}`;
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
): Promise<GithubInstallationResponse> {
  return githubRequest<GithubInstallationResponse>(`/user/installations/${installationId}`, {
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
  installation: GithubInstallationResponse,
): GithubIdentity {
  const account = installation.account;
  if (!account || !Number.isSafeInteger(account.id) || !account.login) throw new GithubApiError(502);
  if (account.type !== 'User' && account.type !== 'Organization') throw new GithubApiError(502);
  const { id, login, type } = account;
  return { id: id as number, login: login as string, accountType: type as 'User' | 'Organization' };
}

function assertUsablePersonalInstallation(
  installation: GithubInstallationResponse,
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

function derLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let value = length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const pkcs1 = pem.includes('BEGIN RSA PRIVATE KEY');
  const label = pkcs1 ? 'RSA PRIVATE KEY' : 'PRIVATE KEY';
  const match = pem.match(new RegExp(`-----BEGIN ${label}-----\\s*([A-Za-z0-9+/=\\s]+?)\\s*-----END ${label}-----`));
  if (!match) throw new Error('invalid private key');
  const der = Uint8Array.from(atob(match[1].replace(/\s+/gu, '')), (character) => character.charCodeAt(0));
  if (!pkcs1) return der.buffer as ArrayBuffer;

  const algorithm = Uint8Array.of(
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  );
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const octet = concatBytes(Uint8Array.of(0x04), derLength(der.length), der);
  const pkcs8Content = concatBytes(version, algorithm, octet);
  return concatBytes(Uint8Array.of(0x30), derLength(pkcs8Content.length), pkcs8Content).buffer as ArrayBuffer;
}

async function createAppJwt(env: Pick<Env, 'GITHUB_APP_ID' | 'GITHUB_APP_PRIVATE_KEY'>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(textEncoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64UrlEncode(textEncoder.encode(JSON.stringify({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: env.GITHUB_APP_ID,
  })));
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(env.GITHUB_APP_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, textEncoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Mint an installation token for the next provisioning operation.
 *
 * The token is returned to the caller so it can be used immediately; this
 * module never stores it. Callers should not put the result in a job record.
 */
export async function createGithubInstallationToken(
  env: Pick<Env, 'GITHUB_APP_ID' | 'GITHUB_APP_PRIVATE_KEY'>,
  installationId: number,
): Promise<string> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error('invalid installation id');
  const jwt = await createAppJwt(env);
  const response = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: githubHeaders(`Bearer ${jwt}`),
  });
  const body = await readJson<{ token?: string }>(response);
  if (!response.ok || !body?.token) throw new GithubApiError(response.status || 502);
  return body.token;
}

async function getAppInstallation(
  env: Pick<Env, 'GITHUB_APP_ID' | 'GITHUB_APP_PRIVATE_KEY'>,
  installationId: number,
): Promise<GithubInstallationResponse> {
  const jwt = await createAppJwt(env);
  return githubRequest<GithubInstallationResponse>(`/app/installations/${installationId}`, {
    headers: githubHeaders(`Bearer ${jwt}`),
  });
}

function authError(error: unknown): Response {
  if (error instanceof Error) {
    switch (error.message) {
      case 'github_installation_suspended': return json({ error: error.message }, 403);
      case 'github_organization_installation_not_supported': return json({ error: error.message }, 403);
      case 'github_account_mismatch': return json({ error: error.message }, 403);
    }
  }
  if (error instanceof GithubApiError) {
    if (error.status === 404) return json({ error: 'github_installation_missing' }, 400);
    if (error.status === 400 || error.status === 401) return json({ error: 'github_authorization_failed' }, 400);
  }
  if (error instanceof GithubRepositoryApiError) {
    if (error.status === 400 || error.status === 401) return json({ error: 'github_authorization_failed' }, 400);
  }
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
  if (!env.JOBS || !env.GITHUB_APP_ID || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
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
      // Selection happens while the short-lived OAuth token is in memory.
      // Only non-secret destination metadata is retained in the job record.
      repository = await selectGithubRepositoryDestination(accessToken, identity.login);
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

    if (!identity || !repository) return json({ error: 'github_identity_missing' }, 400);

    const completed: GithubJobRecord = {
      version: 1,
      jobId: record.jobId,
      status: 'github_authorized',
      installationId: selectedInstallationId,
      identity,
      repository,
      completedAt: Date.now(),
    };
    await env.JOBS.put(jobKey(record.jobId), JSON.stringify(completed), { expirationTtl: JOB_TTL_SECONDS });
    await env.JOBS.put(
      stateKey(payload.nonce),
      JSON.stringify({ ...record, phase: 'consumed', installationId: selectedInstallationId, identity }),
      { expirationTtl: STATE_REPLAY_TTL_SECONDS },
    );
    return json({
      ok: true,
      job_id: completed.jobId,
      installation_id: completed.installationId,
      github: { id: identity.id, login: identity.login },
      repository: {
        name: repository.name,
        url: repository.url,
        baseurl: repository.baseurl,
      },
    });
  } catch (error) {
    return authError(error);
  }
}

export function route(request: Request, env: Partial<Env> = {}): Response | Promise<Response> {
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

  if (request.method === 'GET' && url.pathname === '/auth/github/callback') {
    return finishGithubCallback(request, env);
  }

  if (request.method === 'GET' && url.pathname === '/auth/notion/callback') {
    return json({ error: 'not_implemented' }, 501);
  }

  return json(
    {
      error: 'not_found',
      message: 'The requested route does not exist.',
    },
    404,
  );
}

const worker: ExportedHandler<Env> = {
  fetch(request, env) {
    return route(request, env);
  },

  async queue(batch) {
    // The consumer is deliberately a seam until the durable job model lands.
    // Do not log message bodies: future messages may contain sensitive state.
    console.info('provisioning queue received a batch', {
      queue: batch.queue,
      messageCount: batch.messages.length,
    });

    for (const message of batch.messages) {
      message.retry();
    }
  },
};

export default worker;
