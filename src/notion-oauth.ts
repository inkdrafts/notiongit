/**
 * Notion public-connection OAuth.
 *
 * OAuth state is signed and replay-tracked in KV, but contains no credential
 * or workspace data. The token returned by Notion is handed directly to the
 * request-local continuation and is never persisted, queued, logged, or
 * returned to the browser.
 */

export const NOTION_AUTHORIZATION_URL = 'https://api.notion.com/v1/oauth/authorize';
export const NOTION_TOKEN_URL = 'https://api.notion.com/v1/oauth/token';
export const NOTION_API_VERSION = '2022-06-28';
export const NOTION_STATE_TTL_SECONDS = 10 * 60;
export const NOTION_STATE_REPLAY_TTL_SECONDS = 60 * 60;
export const NOTION_STATE_PREFIX = 'notion:oauth-state:';
export const NOTION_STATE_COOKIE = '__Host-notion-oauth-state';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export interface NotionOAuthEnv {
  JOBS: KVNamespace;
  NOTION_CLIENT_ID: string;
  NOTION_CLIENT_SECRET: string;
}

export interface NotionStatePayload {
  v: 1;
  jobId: string;
  nonce: string;
  exp: number;
}

interface NotionStateRecord {
  version: 1;
  jobId: string;
  nonce: string;
  expiresAt: number;
  phase: 'pending' | 'consumed';
}

interface NotionTokenResponse {
  access_token?: unknown;
  token_type?: unknown;
  refresh_token?: unknown;
  bot_id?: unknown;
  workspace_id?: unknown;
  duplicated_template_id?: unknown;
}

/** The only data permitted to leave the callback's request-local scope. */
export interface NotionOAuthContinuation {
  readonly jobId: string;
  readonly accessToken: string;
  readonly duplicatedTemplateId: string | null;
}

export type NotionOAuthContinuationHandler =
  (continuation: NotionOAuthContinuation) => Promise<void> | void;

export interface NotionOAuthRouteOptions {
  /**
   * Consumes the short-lived token and duplicated root immediately. The
   * default is a no-op until the database resolver is connected in issue #7.
   */
  continueOnboarding?: NotionOAuthContinuationHandler;
  /** Injectable provider transport for tests and local development. */
  fetcher?: typeof fetch;
}

export interface NotionOAuthSummary {
  readonly ok: true;
  readonly status: 'notion_authorized';
  readonly job_id: string;
  readonly template: { duplicated: boolean };
}

export type NotionOAuthErrorCode =
  | 'notion_configuration_missing'
  | 'notion_state_missing'
  | 'notion_state_invalid'
  | 'notion_state_expired'
  | 'notion_state_replayed'
  | 'notion_authorization_denied'
  | 'notion_code_missing'
  | 'notion_authorization_failed'
  | 'notion_rate_limited'
  | 'notion_unavailable'
  | 'notion_token_invalid';

export class NotionOAuthError extends Error {
  readonly code: NotionOAuthErrorCode;
  readonly status: number;

  constructor(code: NotionOAuthErrorCode, status: number) {
    super(code);
    this.name = 'NotionOAuthError';
    this.code = code;
    this.status = status;
  }
}

const textEncoder = new TextEncoder();

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

function base64EncodeUtf8(value: string): string {
  let binary = '';
  for (const byte of textEncoder.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

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

export async function signNotionState(payload: NotionStatePayload, secret: string): Promise<string> {
  const encodedPayload = base64UrlEncode(textEncoder.encode(JSON.stringify(payload)));
  return `${encodedPayload}.${await hmacSign(encodedPayload, secret)}`;
}

async function verifyNotionState(encodedState: string, secret: string): Promise<NotionStatePayload | null> {
  const parts = encodedState.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  try {
    const expectedSignature = await hmacSign(parts[0], secret);
    const expected = textEncoder.encode(expectedSignature);
    const actual = textEncoder.encode(parts[1]);
    if (expected.length !== actual.length) return null;

    const key = await crypto.subtle.importKey(
      'raw',
      textEncoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    if (!await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecode(parts[1]),
      textEncoder.encode(parts[0]),
    )) return null;

    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]))) as NotionStatePayload;
    if (
      payload.v !== 1 ||
      typeof payload.jobId !== 'string' ||
      typeof payload.nonce !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(payload.jobId) ||
      !/^[A-Za-z0-9-]{20,100}$/u.test(payload.nonce) ||
      !Number.isSafeInteger(payload.exp)
    ) return null;
    return payload;
  } catch {
    return null;
  }
}

function stateKey(nonce: string): string {
  return `${NOTION_STATE_PREFIX}${nonce}`;
}

function validJobId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function callbackUrl(request: Request): string {
  return new URL('/auth/notion/callback', request.url).toString();
}

function notionRedirectCookie(nonce: string): string {
  return `${NOTION_STATE_COOKIE}=${encodeURIComponent(nonce)}; Max-Age=${NOTION_STATE_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function clearRedirectCookie(): string {
  return `${NOTION_STATE_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
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

function response(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

async function readJson<T>(result: Response): Promise<T | null> {
  try {
    return await result.json() as T;
  } catch {
    return null;
  }
}

/** Begin Notion public-connection authorization for a job. */
export async function beginNotionAuthorization(
  request: Request,
  env: Partial<NotionOAuthEnv>,
): Promise<Response> {
  if (!env.JOBS || !env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) {
    return response({ error: 'notion_configuration_missing' }, 500);
  }

  const url = new URL(request.url);
  const requestedJobId = url.searchParams.get('job_id') || url.searchParams.get('jobId');
  const jobId = requestedJobId || crypto.randomUUID();
  if (!validJobId(jobId)) return response({ error: 'invalid_job_id' }, 400);

  const now = Math.floor(Date.now() / 1000);
  const payload: NotionStatePayload = {
    v: 1,
    jobId,
    nonce: crypto.randomUUID(),
    exp: now + NOTION_STATE_TTL_SECONDS,
  };
  const state = await signNotionState(payload, env.NOTION_CLIENT_SECRET);
  const record: NotionStateRecord = {
    version: 1,
    jobId,
    nonce: payload.nonce,
    expiresAt: payload.exp,
    phase: 'pending',
  };
  await env.JOBS.put(stateKey(payload.nonce), JSON.stringify(record), {
    expirationTtl: NOTION_STATE_TTL_SECONDS,
  });

  const authorizationUrl = new URL(NOTION_AUTHORIZATION_URL);
  authorizationUrl.searchParams.set('owner', 'user');
  authorizationUrl.searchParams.set('client_id', env.NOTION_CLIENT_ID);
  authorizationUrl.searchParams.set('redirect_uri', callbackUrl(request));
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('state', state);

  const headers = new Headers({ Location: authorizationUrl.toString(), ...JSON_HEADERS });
  headers.set('Set-Cookie', notionRedirectCookie(payload.nonce));
  return new Response(null, { status: 302, headers });
}

async function exchangeNotionCode(
  code: string,
  redirectUri: string,
  env: Pick<NotionOAuthEnv, 'NOTION_CLIENT_ID' | 'NOTION_CLIENT_SECRET'>,
  fetcher: typeof fetch = fetch,
): Promise<NotionOAuthContinuation> {
  let result: Response;
  try {
    result = await fetcher(NOTION_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Notion-Version': NOTION_API_VERSION,
        Authorization: `Basic ${base64EncodeUtf8(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`)}`,
      },
      body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    });
  } catch {
    throw new NotionOAuthError('notion_unavailable', 502);
  }

  const token = await readJson<NotionTokenResponse>(result);
  if (result.status === 429) throw new NotionOAuthError('notion_rate_limited', 429);
  if (!result.ok) {
    if (result.status === 400 || result.status === 401) {
      throw new NotionOAuthError('notion_authorization_failed', 400);
    }
    throw new NotionOAuthError('notion_unavailable', 502);
  }
  if (
    !token ||
    typeof token.access_token !== 'string' || !token.access_token ||
    token.token_type !== 'bearer' ||
    typeof token.bot_id !== 'string' || !token.bot_id ||
    typeof token.workspace_id !== 'string' || !token.workspace_id ||
    (token.duplicated_template_id !== undefined &&
      token.duplicated_template_id !== null &&
      (typeof token.duplicated_template_id !== 'string' || !token.duplicated_template_id))
  ) {
    throw new NotionOAuthError('notion_token_invalid', 502);
  }

  return {
    jobId: '',
    accessToken: token.access_token,
    duplicatedTemplateId: typeof token.duplicated_template_id === 'string'
      ? token.duplicated_template_id
      : null,
  };
}

/** Exchange a Notion code without exposing the provider's raw response. */
export async function exchangeNotionAuthorizationCode(
  code: string,
  redirectUri: string,
  env: Pick<NotionOAuthEnv, 'NOTION_CLIENT_ID' | 'NOTION_CLIENT_SECRET'>,
  fetcher: typeof fetch = fetch,
): Promise<Omit<NotionOAuthContinuation, 'jobId'>> {
  const continuation = await exchangeNotionCode(code, redirectUri, env, fetcher);
  return { accessToken: continuation.accessToken, duplicatedTemplateId: continuation.duplicatedTemplateId };
}

/** Handle Notion's redirect and hand credentials only to the local continuation. */
export async function finishNotionCallback(
  request: Request,
  env: Partial<NotionOAuthEnv>,
  options: NotionOAuthRouteOptions = {},
): Promise<Response> {
  const clearCookieHeaders = { 'Set-Cookie': clearRedirectCookie() };
  if (!env.JOBS || !env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) {
    return response({ error: 'notion_configuration_missing' }, 500, clearCookieHeaders);
  }

  const url = new URL(request.url);
  const encodedState = url.searchParams.get('state');
  if (!encodedState) return response({ error: 'notion_state_missing' }, 400, clearCookieHeaders);
  const payload = await verifyNotionState(encodedState, env.NOTION_CLIENT_SECRET);
  if (!payload) return response({ error: 'notion_state_invalid' }, 400, clearCookieHeaders);
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    return response({ error: 'notion_state_expired' }, 400, clearCookieHeaders);
  }

  if (cookieValue(request, NOTION_STATE_COOKIE) !== payload.nonce) {
    return response({ error: 'notion_state_invalid' }, 400, clearCookieHeaders);
  }

  const record = await env.JOBS.get<NotionStateRecord>(stateKey(payload.nonce), 'json');
  if (!record || record.version !== 1 || record.jobId !== payload.jobId || record.nonce !== payload.nonce) {
    return response({ error: 'notion_state_invalid' }, 400, clearCookieHeaders);
  }
  if (record.phase === 'consumed') return response({ error: 'notion_state_replayed' }, 400, clearCookieHeaders);
  if (record.expiresAt <= Math.floor(Date.now() / 1000)) {
    return response({ error: 'notion_state_expired' }, 400, clearCookieHeaders);
  }

  // Consume before any provider call. A code is single-use, and this also
  // closes the replay race between two callback requests.
  await env.JOBS.put(stateKey(payload.nonce), JSON.stringify({ ...record, phase: 'consumed' }), {
    expirationTtl: NOTION_STATE_REPLAY_TTL_SECONDS,
  });

  if (url.searchParams.has('error')) {
    return response({ error: 'notion_authorization_denied' }, 400, clearCookieHeaders);
  }
  const code = url.searchParams.get('code');
  if (!code) return response({ error: 'notion_code_missing' }, 400, clearCookieHeaders);

  try {
    const exchanged = await exchangeNotionCode(
      code,
      callbackUrl(request),
      env as Pick<NotionOAuthEnv, 'NOTION_CLIENT_ID' | 'NOTION_CLIENT_SECRET'>,
      options.fetcher,
    );
    const continuation: NotionOAuthContinuation = {
      jobId: payload.jobId,
      accessToken: exchanged.accessToken,
      duplicatedTemplateId: exchanged.duplicatedTemplateId,
    };
    await options.continueOnboarding?.(continuation);

    const summary: NotionOAuthSummary = {
      ok: true,
      status: 'notion_authorized',
      job_id: payload.jobId,
      template: { duplicated: continuation.duplicatedTemplateId !== null },
    };
    return response(summary, 202, clearCookieHeaders);
  } catch (error) {
    if (error instanceof NotionOAuthError) {
      return response({ error: error.code }, error.status, clearCookieHeaders);
    }
    return response({ error: 'notion_unavailable' }, 502, clearCookieHeaders);
  }
}
