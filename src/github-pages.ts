/**
 * Legacy GitHub Pages configuration for generated repositories.
 *
 * Pages is configured with the installation token rather than the short-lived
 * OAuth token. The token is supplied by the caller for immediate use and is
 * never included in the returned metadata or an error.
 */

export const GITHUB_PAGES_BUILD_TYPE = 'legacy' as const;
export const GITHUB_PAGES_SOURCE = { branch: 'main', path: '/' } as const;
export const PAGES_MAX_ATTEMPTS = 4;
export const PAGES_INITIAL_DELAY_MS = 250;
export const PAGES_MAX_DELAY_MS = 4_000;

export interface GithubPagesIdentity {
  status: string | null;
  url: string | null;
  htmlUrl: string | null;
  buildType: typeof GITHUB_PAGES_BUILD_TYPE;
  source: typeof GITHUB_PAGES_SOURCE;
  /** True when an existing site was reconciled or already matched. */
  reused: boolean;
}

export type GithubPagesErrorCode =
  | 'github_pages_missing_branch'
  | 'github_pages_validation_failed'
  | 'github_pages_permission_denied'
  | 'github_pages_rate_limited'
  | 'github_pages_unavailable';

export class GithubPagesError extends Error {
  readonly code: GithubPagesErrorCode;
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(code: GithubPagesErrorCode, status: number, retryAfterSeconds: number | null = null) {
    super(code);
    this.name = 'GithubPagesError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface GithubPagesResponse {
  status?: unknown;
  url?: unknown;
  html_url?: unknown;
  build_type?: unknown;
  source?: {
    branch?: unknown;
    path?: unknown;
  };
}

export interface GithubPagesConfigureOptions {
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

function pagesPath(repositoryFullName: string): string {
  const parts = repositoryFullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new GithubPagesError('github_pages_unavailable', 502);
  }
  return `/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/pages`;
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

function errorForResponse(response: Response): GithubPagesError | null {
  if (response.status === 404) return new GithubPagesError('github_pages_missing_branch', 404);
  if (response.status === 403 && retryAfterSeconds(response) !== null) {
    return new GithubPagesError('github_pages_rate_limited', 429, retryAfterSeconds(response));
  }
  if (response.status === 401 || response.status === 403) {
    return new GithubPagesError('github_pages_permission_denied', 403);
  }
  if (response.status === 422 || response.status === 400) {
    return new GithubPagesError('github_pages_validation_failed', 422);
  }
  if (response.status === 429) {
    return new GithubPagesError('github_pages_rate_limited', 429, retryAfterSeconds(response));
  }
  return null;
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status >= 500;
}

function validPagesResponse(value: GithubPagesResponse | null): value is GithubPagesResponse {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pagesIdentity(response: GithubPagesResponse, reused: boolean): GithubPagesIdentity {
  return {
    status: typeof response.status === 'string' ? response.status : null,
    url: typeof response.url === 'string' ? response.url : null,
    htmlUrl: typeof response.html_url === 'string' ? response.html_url : null,
    buildType: GITHUB_PAGES_BUILD_TYPE,
    source: GITHUB_PAGES_SOURCE,
    reused,
  };
}

function hasCompatibleSettings(response: GithubPagesResponse): boolean {
  const source = response.source;
  // GitHub's documented response examples do not include build_type on every
  // API version. When it is omitted, source is the available legacy-settings
  // signal; an explicit workflow value is never accepted as compatible.
  return (
    (response.build_type === undefined || response.build_type === GITHUB_PAGES_BUILD_TYPE) &&
    source?.branch === GITHUB_PAGES_SOURCE.branch &&
    source?.path === GITHUB_PAGES_SOURCE.path
  );
}

async function request(
  fetcher: typeof fetch,
  url: string,
  installationToken: string,
  init: RequestInit = {},
): Promise<Response | null> {
  try {
    const headers = githubHeaders(installationToken);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    return await fetcher(url, {
      ...init,
      headers,
    });
  } catch {
    return null;
  }
}

async function readExistingPages(
  installationToken: string,
  path: string,
  fetcher: typeof fetch,
): Promise<{ response: GithubPagesResponse | null; missing: boolean; transient: boolean }> {
  const result = await request(fetcher, `${GITHUB_API}${path}`, installationToken);
  if (result === null) return { response: null, missing: false, transient: true };
  if (result.status === 404) return { response: null, missing: true, transient: false };
  if (!result.ok) {
    const classified = errorForResponse(result);
    if (classified) throw classified;
    return { response: null, missing: false, transient: isTransientStatus(result.status) };
  }
  const body = await readJson<GithubPagesResponse>(result);
  if (!validPagesResponse(body)) throw new GithubPagesError('github_pages_unavailable', 502);
  return { response: body, missing: false, transient: false };
}

/** Read and validate the current Pages settings with an installation token. */
export async function getGithubPagesSite(
  installationToken: string,
  repositoryFullName: string,
  fetcher: typeof fetch = fetch,
): Promise<GithubPagesIdentity> {
  const result = await request(fetcher, `${GITHUB_API}${pagesPath(repositoryFullName)}`, installationToken);
  if (result === null) throw new GithubPagesError('github_pages_unavailable', 502);
  if (!result.ok) {
    const classified = errorForResponse(result);
    if (classified) throw classified;
    throw new GithubPagesError('github_pages_unavailable', 502);
  }
  const body = await readJson<GithubPagesResponse>(result);
  if (!validPagesResponse(body)) throw new GithubPagesError('github_pages_unavailable', 502);
  return pagesIdentity(body, true);
}

/**
 * Enable legacy Pages from main:/, reconciling a site created by an earlier
 * attempt or manually enabled before provisioning reached this step.
 */
export async function configureGithubPages(
  installationToken: string,
  repositoryFullName: string,
  options: GithubPagesConfigureOptions = {},
): Promise<GithubPagesIdentity> {
  const {
    maxAttempts = PAGES_MAX_ATTEMPTS,
    initialDelayMs = PAGES_INITIAL_DELAY_MS,
    maxDelayMs = PAGES_MAX_DELAY_MS,
    fetcher = fetch,
    sleep = defaultSleep,
  } = options;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('invalid Pages retry attempt limit');

  const path = pagesPath(repositoryFullName);
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const created = await request(fetcher, `${GITHUB_API}${path}`, installationToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ build_type: GITHUB_PAGES_BUILD_TYPE, source: GITHUB_PAGES_SOURCE }),
    });

    if (created?.status === 201) {
      const body = await readJson<GithubPagesResponse>(created);
      if (!validPagesResponse(body)) throw new GithubPagesError('github_pages_unavailable', 502);
      return pagesIdentity(body, false);
    }

    if (created?.status === 409) {
      // A conflict is the expected idempotent path. A just-created site may
      // briefly return 404 here, so retry that propagation window only.
      const existing = await readExistingPages(installationToken, path, fetcher);
      if (existing.response) {
        if (hasCompatibleSettings(existing.response)) return pagesIdentity(existing.response, true);

        const updated = await request(fetcher, `${GITHUB_API}${path}`, installationToken, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ build_type: GITHUB_PAGES_BUILD_TYPE, source: GITHUB_PAGES_SOURCE }),
        });
        if (updated === null) {
          if (attempt < maxAttempts) {
            await sleep(delay);
            delay = Math.min(delay * 2, maxDelayMs);
            continue;
          }
          throw new GithubPagesError('github_pages_unavailable', 502);
        }
        if (!updated.ok) {
          const classified = errorForResponse(updated);
          if (classified) throw classified;
          if (isTransientStatus(updated.status) && attempt < maxAttempts) {
            await sleep(delay);
            delay = Math.min(delay * 2, maxDelayMs);
            continue;
          }
          throw new GithubPagesError('github_pages_unavailable', 502);
        }
        return pagesIdentity(existing.response, true);
      }
      if ((existing.missing || existing.transient) && attempt < maxAttempts) {
        await sleep(delay);
        delay = Math.min(delay * 2, maxDelayMs);
        continue;
      }
      throw new GithubPagesError('github_pages_unavailable', 502);
    }

    if (created === null) {
      if (attempt < maxAttempts) {
        await sleep(delay);
        delay = Math.min(delay * 2, maxDelayMs);
        continue;
      }
      throw new GithubPagesError('github_pages_unavailable', 502);
    }

    const classified = errorForResponse(created);
    if (classified) throw classified;
    if (isTransientStatus(created.status) && attempt < maxAttempts) {
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
      continue;
    }
    throw new GithubPagesError('github_pages_unavailable', 502);
  }

  throw new GithubPagesError('github_pages_unavailable', 502);
}
