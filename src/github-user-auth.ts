/**
 * User-token GitHub helpers for the OAuth callback paths.
 *
 * Split out of `index.ts` (the same move `github-app-auth.ts` made for the
 * App side) so a callback path can exchange a code and prove identity
 * without an import cycle back through the HTTP entrypoint. The user access
 * token is minted by the caller as a request-scoped `Secret` and is
 * unwrapped only at these provider-call boundaries; nothing here persists,
 * logs, returns, or includes it in an error.
 */

import { FlowFailure } from './failures';
import type { GithubInstallationAccount } from './github-app-auth';
import { Secret } from './secret';

export interface GithubUserAuthEnv {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

/** Structurally identical to `Env`'s `GithubIdentity`; declared here so this
 * module never imports from `index.ts` (which imports this module). */
export interface GithubUserIdentity {
  id: number;
  login: string;
  accountType: 'User' | 'Organization';
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

export class GithubApiError extends Error implements GithubApiErrorShape {
  readonly status: number;

  constructor(status: number) {
    super('GitHub request failed');
    this.name = 'GithubApiError';
    this.status = status;
  }
}

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

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

export async function exchangeGithubCode(
  code: string,
  env: GithubUserAuthEnv,
  redirectUri: string,
): Promise<Secret<'github-user-access'>> {
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
  return Secret.githubUserAccess(token.access_token);
}

export async function getAuthenticatedGithubUser(authorization: string): Promise<GithubUserIdentity> {
  const user = await githubRequest<GithubUserResponse>('/user', {
    headers: githubHeaders(authorization),
  });
  if (!Number.isSafeInteger(user.id) || !user.login || (user.type !== 'User' && user.type !== 'Organization')) {
    throw new GithubApiError(502);
  }
  const { id, login, type } = user;
  return { id: id as number, login: login as string, accountType: type as 'User' | 'Organization' };
}

export async function getUserInstallation(
  authorization: string,
  installationId: number,
): Promise<GithubInstallationAccount> {
  return githubRequest<GithubInstallationAccount>(`/user/installations/${installationId}`, {
    headers: githubHeaders(authorization),
  });
}

export async function findUserInstallation(
  authorization: string,
  appId: string,
): Promise<number> {
  const response = await githubRequest<GithubInstallationsResponse>('/user/installations', {
    headers: githubHeaders(authorization),
  });
  const installation = response.installations?.find(
    (candidate) => Number(candidate.app_id) === Number(appId) && Number.isSafeInteger(candidate.id) && candidate.id! > 0,
  );
  if (!installation?.id) throw new GithubApiError(404);
  return installation.id;
}

function installationIdentity(
  installation: GithubInstallationAccount,
): GithubUserIdentity {
  const account = installation.account;
  if (!account || !Number.isSafeInteger(account.id) || !account.login) throw new GithubApiError(502);
  if (account.type !== 'User' && account.type !== 'Organization') throw new GithubApiError(502);
  const { id, login, type } = account;
  return { id: id as number, login: login as string, accountType: type as 'User' | 'Organization' };
}

export function assertUsablePersonalInstallation(
  installation: GithubInstallationAccount,
  authenticatedUser?: GithubUserIdentity,
): GithubUserIdentity {
  if (installation.suspended_at || installation.suspended_by) {
    throw new FlowFailure('github_installation_suspended');
  }
  const identity = installationIdentity(installation);
  if (identity.accountType === 'Organization') {
    throw new FlowFailure('github_organization_installation_not_supported');
  }
  if (
    authenticatedUser &&
    (identity.id !== authenticatedUser.id || identity.login.toLowerCase() !== authenticatedUser.login.toLowerCase())
  ) {
    throw new FlowFailure('github_account_mismatch');
  }
  return identity;
}
