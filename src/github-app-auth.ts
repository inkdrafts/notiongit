/**
 * GitHub App JWT signing and installation-token minting.
 *
 * Split out of `index.ts` so the provisioning queue consumer can mint a
 * fresh installation token for every step without an import cycle back
 * through the HTTP entrypoint. A minted token is returned to the caller for
 * immediate use as a self-redacting `Secret` and is never stored, logged, or
 * included in an error: every provisioning step — synchronous or queued —
 * mints its own token from the durable, non-secret installation id and
 * discards it when the step returns.
 */

import type { GithubFailureCode } from './failures';
import { Secret } from './secret';

export interface GithubAppAuthEnv {
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
}

export interface GithubInstallationAccount {
  account?: {
    id?: number;
    login?: string;
    type?: string;
  };
  suspended_at?: string | null;
  suspended_by?: unknown;
}

export class GithubAppAuthError extends Error {
  readonly status: number;
  /** 429s and outages stay retryable in the queue; other 4xx mean the installation is gone for this app. */
  readonly code: GithubFailureCode;
  /** Seconds GitHub asked the caller to wait, parsed from a 403/429
   * `Retry-After`; null when the failure carries no pacing instruction. */
  readonly retryAfterSeconds: number | null;

  constructor(status: number, retryAfterSeconds: number | null = null) {
    super('GitHub App request failed');
    this.name = 'GithubAppAuthError';
    this.status = status;
    this.code = status === 429 ? 'github_rate_limited' : status >= 500 ? 'github_app_unavailable' : 'github_app_auth_failed';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const textEncoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function githubHeaders(authorization: string): Headers {
  return new Headers({
    Accept: 'application/vnd.github+json',
    Authorization: authorization,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  });
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function retryAfterSeconds(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
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

async function createAppJwt(env: GithubAppAuthEnv): Promise<string> {
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
  env: GithubAppAuthEnv,
  installationId: number,
  fetcher: typeof fetch = fetch,
): Promise<Secret<'github-installation'>> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error('invalid installation id');
  const jwt = await createAppJwt(env);
  const response = await fetcher(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: githubHeaders(`Bearer ${jwt}`),
  });
  const body = await readJson<{ token?: string }>(response);
  if (response.status === 403 || response.status === 429) {
    const retryAfter = retryAfterSeconds(response);
    if (retryAfter !== null || response.status === 429) {
      throw new GithubAppAuthError(429, retryAfter);
    }
  }
  if (!response.ok || !body?.token) throw new GithubAppAuthError(response.status || 502);
  return Secret.githubInstallation(body.token);
}

/** Read an installation with the App's own JWT — proves the installation belongs to this App. */
export async function getAppInstallation(
  env: GithubAppAuthEnv,
  installationId: number,
  fetcher: typeof fetch = fetch,
): Promise<GithubInstallationAccount> {
  const jwt = await createAppJwt(env);
  const response = await fetcher(`${GITHUB_API}/app/installations/${installationId}`, {
    headers: githubHeaders(`Bearer ${jwt}`),
  });
  if (response.status === 403 || response.status === 429) {
    const retryAfter = retryAfterSeconds(response);
    if (retryAfter !== null || response.status === 429) {
      throw new GithubAppAuthError(429, retryAfter);
    }
  }
  if (!response.ok) throw new GithubAppAuthError(response.status);
  const body = await readJson<GithubInstallationAccount>(response);
  if (body === null) throw new GithubAppAuthError(502);
  return body;
}
