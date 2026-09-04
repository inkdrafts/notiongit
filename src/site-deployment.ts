/**
 * Wait for the legacy Pages build produced by a specific commit, then verify
 * the public site actually answers. GitHub rebuilds legacy Pages automatically
 * on every push to the source branch, so the build to wait for is identified
 * by matching `commit` on `GET .../pages/builds/latest`, not by an id minted
 * by this Worker. A build reaching `built` does not guarantee the CDN in
 * front of it already serves the new content, so the public URL is checked
 * separately and that gap is reported as its own distinct outcome.
 */

export const PAGES_BUILD_MAX_POLL_ATTEMPTS = 10;
export const PAGES_BUILD_POLL_INITIAL_DELAY_MS = 2_000;
export const PAGES_BUILD_POLL_MAX_DELAY_MS = 15_000;

export const SITE_VERIFY_MAX_ATTEMPTS = 5;
export const SITE_VERIFY_INITIAL_DELAY_MS = 1_000;
export const SITE_VERIFY_MAX_DELAY_MS = 8_000;

export type GithubDeployStatus = 'built' | 'building' | 'errored';

export interface GithubPagesBuildIdentity {
  buildId: number | null;
  status: GithubDeployStatus;
  commitSha: string | null;
}

export type GithubDeployErrorCode =
  | 'github_deploy_build_failed'
  | 'github_deploy_timeout'
  | 'github_deploy_unavailable'
  | 'github_deploy_url_unreachable';

export class GithubDeployError extends Error {
  readonly code: GithubDeployErrorCode;
  readonly status: number;

  constructor(code: GithubDeployErrorCode, status: number) {
    super(code);
    this.name = 'GithubDeployError';
    this.code = code;
    this.status = status;
  }
}

interface PagesBuildResponse {
  url?: unknown;
  status?: unknown;
  commit?: unknown;
}

export interface PagesBuildPollOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface SiteVerifyOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function githubHeaders(installationToken: string): Headers {
  return new Headers({
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${installationToken}`,
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

function buildsLatestPath(repositoryFullName: string): string {
  const parts = repositoryFullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new GithubDeployError('github_deploy_unavailable', 502);
  }
  return `/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/pages/builds/latest`;
}

function buildIdFromUrl(url: unknown): number | null {
  if (typeof url !== 'string') return null;
  const match = url.match(/\/builds\/(\d+)$/u);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isTerminalBuildStatus(status: unknown): status is 'built' | 'errored' {
  return status === 'built' || status === 'errored';
}

function isPagesBuildStatus(status: unknown): status is GithubDeployStatus {
  return status === 'built' || status === 'building' || status === 'errored';
}

/** Read the repository's current `main` HEAD sha, for correlating the Pages build to wait for. */
export async function getRepositoryMainHeadSha(
  installationToken: string,
  repositoryFullName: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const parts = repositoryFullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new GithubDeployError('github_deploy_unavailable', 502);
  const response = await fetcher(
    `${GITHUB_API}/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/commits/main`,
    { headers: githubHeaders(installationToken) },
  );
  if (!response.ok) throw new GithubDeployError('github_deploy_unavailable', 502);
  const body = await readJson<{ sha?: unknown }>(response);
  if (!body || typeof body.sha !== 'string' || !body.sha) throw new GithubDeployError('github_deploy_unavailable', 502);
  return body.sha;
}

/**
 * Poll the repository's latest Pages build until it both reports a terminal
 * status and matches `expectedCommitSha` — a build in flight for an older
 * commit is not confused with the one this provisioning attempt is waiting
 * on. Never returns the build's error message: that field can echo Jekyll
 * content sourced from the user's Notion workspace.
 */
export async function awaitPagesBuildForCommit(
  installationToken: string,
  repositoryFullName: string,
  expectedCommitSha: string,
  options: PagesBuildPollOptions = {},
): Promise<GithubPagesBuildIdentity> {
  const {
    maxAttempts = PAGES_BUILD_MAX_POLL_ATTEMPTS,
    initialDelayMs = PAGES_BUILD_POLL_INITIAL_DELAY_MS,
    maxDelayMs = PAGES_BUILD_POLL_MAX_DELAY_MS,
    fetcher = fetch,
    sleep = defaultSleep,
  } = options;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('invalid Pages build poll attempt limit');
  }

  const path = buildsLatestPath(repositoryFullName);
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetcher(`${GITHUB_API}${path}`, { headers: githubHeaders(installationToken) });
    if (response.ok) {
      const body = await readJson<PagesBuildResponse>(response);
      if (body && typeof body.commit === 'string' && isTerminalBuildStatus(body.status) && body.commit === expectedCommitSha) {
        if (body.status === 'errored') throw new GithubDeployError('github_deploy_build_failed', 502);
        return { buildId: buildIdFromUrl(body.url), status: body.status, commitSha: body.commit };
      }
    } else if (response.status !== 404 && response.status < 500) {
      throw new GithubDeployError('github_deploy_unavailable', 502);
    }
    if (attempt < maxAttempts) {
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }

  throw new GithubDeployError('github_deploy_timeout', 504);
}

/**
 * One-shot read of the repository's latest Pages build, in whatever state it
 * is. Null means GitHub answered and no build exists yet; a failed or
 * unreadable read throws so the caller can distinguish "never built" from
 * "cannot tell right now". Never returns the build's error message: that
 * field can echo Jekyll content sourced from the user's Notion workspace.
 */
export async function latestPagesBuild(
  installationToken: string,
  repositoryFullName: string,
  fetcher: typeof fetch = fetch,
): Promise<GithubPagesBuildIdentity | null> {
  const response = await fetcher(`${GITHUB_API}${buildsLatestPath(repositoryFullName)}`, {
    headers: githubHeaders(installationToken),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new GithubDeployError('github_deploy_unavailable', 502);
  const body = await readJson<PagesBuildResponse>(response);
  if (!body || !isPagesBuildStatus(body.status)) throw new GithubDeployError('github_deploy_unavailable', 502);
  return {
    buildId: buildIdFromUrl(body.url),
    status: body.status,
    commitSha: typeof body.commit === 'string' ? body.commit : null,
  };
}

/**
 * Confirm the public URL actually answers. A build can report `built` before
 * the CDN in front of it serves the new content, so a non-2xx/network failure
 * is retried a bounded number of times before it is reported as a distinct
 * "not propagated yet" outcome rather than a generic failure.
 */
export async function verifyPublicSiteReachable(
  url: string,
  options: SiteVerifyOptions = {},
): Promise<{ status: number }> {
  const {
    maxAttempts = SITE_VERIFY_MAX_ATTEMPTS,
    initialDelayMs = SITE_VERIFY_INITIAL_DELAY_MS,
    maxDelayMs = SITE_VERIFY_MAX_DELAY_MS,
    fetcher = fetch,
    sleep = defaultSleep,
  } = options;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('invalid site verification attempt limit');
  }

  let delay = initialDelayMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetcher(url, { method: 'GET', redirect: 'follow' });
      if (response.ok) return { status: response.status };
    } catch {
      // A network failure here is treated the same as a non-2xx response:
      // both are consistent with the CDN not having propagated yet.
    }
    if (attempt < maxAttempts) {
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }

  throw new GithubDeployError('github_deploy_url_unreachable', 504);
}
