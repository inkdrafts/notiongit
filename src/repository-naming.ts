/**
 * Repository naming and GitHub Pages URL policy for provisioned sites.
 *
 * The apex repository (<login>.github.io) owns the account's root Pages URL.
 * When that name is unavailable, the deterministic project-site fallback is
 * <login>-inkdrafts, followed by <login>-inkdrafts-2, and so on.
 */

export const GITHUB_REPOSITORY_MAX_LENGTH = 100;
export const PROJECT_REPOSITORY_SUFFIX = '-inkdrafts';
export const MAX_REPOSITORY_NAME_ATTEMPTS = 1000;

export interface RepositoryDestination {
  name: string;
  url: string;
  baseurl: string;
  kind: 'apex' | 'project';
}

export interface GithubRepositorySummary {
  name?: string;
}

export class GithubRepositoryApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super('GitHub repository request failed');
    this.name = 'GithubRepositoryApiError';
    this.status = status;
  }
}

export class GithubRepositoryNameCollisionError extends GithubRepositoryApiError {
  constructor() {
    super(422);
    this.name = 'GithubRepositoryNameCollisionError';
  }
}

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_REPOSITORY_NAME = /^[A-Za-z0-9._-]+$/u;
const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/u;

function githubHeaders(accessToken: string): Headers {
  return new Headers({
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${accessToken}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  });
}

function normalizeLogin(login: string): string {
  const normalized = login.toLowerCase();
  if (!GITHUB_LOGIN.test(normalized)) throw new Error('invalid GitHub login');
  return normalized;
}

/** GitHub repository names are 1–100 characters from this ASCII set. */
export function isValidGithubRepositoryName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length >= 1 &&
    name.length <= GITHUB_REPOSITORY_MAX_LENGTH &&
    name !== '.' &&
    name !== '..' &&
    GITHUB_REPOSITORY_NAME.test(name)
  );
}

function projectBaseName(login: string): string {
  const base = `${login}${PROJECT_REPOSITORY_SUFFIX}`;
  return base.slice(0, GITHUB_REPOSITORY_MAX_LENGTH);
}

function candidateWithSuffix(base: string, attempt: number): string {
  const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
  return `${base.slice(0, GITHUB_REPOSITORY_MAX_LENGTH - suffix.length)}${suffix}`;
}

function occupiedNames(existingNames: Iterable<string>): Set<string> {
  const occupied = new Set<string>();
  for (const name of existingNames) {
    if (typeof name === 'string') occupied.add(name.toLowerCase());
  }
  return occupied;
}

/**
 * Build the public URL and Jekyll baseurl for a selected repository.
 */
export function repositoryDestination(login: string, name: string): RepositoryDestination {
  const normalizedLogin = normalizeLogin(login);
  if (!isValidGithubRepositoryName(name)) throw new Error('invalid GitHub repository name');

  const apexName = `${normalizedLogin}.github.io`;
  const isApex = name === apexName;
  return {
    name,
    url: isApex
      ? `https://${normalizedLogin}.github.io`
      : `https://${normalizedLogin}.github.io/${name}`,
    baseurl: isApex ? '' : `/${name}`,
    kind: isApex ? 'apex' : 'project',
  };
}

/**
 * Select a name without making a reservation. The caller must still handle a
 * 422 from creation because another request can claim a name after this check.
 */
export function selectRepositoryDestination(
  login: string,
  existingNames: Iterable<string>,
): RepositoryDestination {
  const normalizedLogin = normalizeLogin(login);
  const occupied = occupiedNames(existingNames);
  const apexName = `${normalizedLogin}.github.io`;

  if (isValidGithubRepositoryName(apexName) && !occupied.has(apexName)) {
    return repositoryDestination(normalizedLogin, apexName);
  }

  const base = projectBaseName(normalizedLogin);
  for (let attempt = 0; attempt < MAX_REPOSITORY_NAME_ATTEMPTS; attempt += 1) {
    const candidate = candidateWithSuffix(base, attempt);
    if (isValidGithubRepositoryName(candidate) && !occupied.has(candidate.toLowerCase())) {
      return repositoryDestination(normalizedLogin, candidate);
    }
  }

  throw new Error('no available GitHub repository name');
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/**
 * List every repository owned by the authenticated personal account.
 * Tokens are used only in the request and are never included in an error.
 */
export async function listOwnedGithubRepositories(
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const url = new URL(`${GITHUB_API}/user/repos`);
    url.searchParams.set('affiliation', 'owner');
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const response = await fetcher(url, { headers: githubHeaders(accessToken) });
    if (!response.ok) throw new GithubRepositoryApiError(response.status);
    const repositories = await readJson<GithubRepositorySummary[]>(response);
    if (!Array.isArray(repositories)) throw new GithubRepositoryApiError(502);
    for (const repository of repositories) {
      if (repository && typeof repository.name === 'string') names.push(repository.name);
    }
    if (repositories.length < 100) return names;
  }
  throw new GithubRepositoryApiError(502);
}

/** Select the destination using the account's live GitHub repository list. */
export async function selectGithubRepositoryDestination(
  accessToken: string,
  login: string,
  fetcher: typeof fetch = fetch,
): Promise<RepositoryDestination> {
  const names = await listOwnedGithubRepositories(accessToken, fetcher);
  return selectRepositoryDestination(login, names);
}

export function isGithubRepositoryNameCollision(error: unknown): boolean {
  return error instanceof GithubRepositoryNameCollisionError ||
    (typeof error === 'object' && error !== null && 'status' in error && error.status === 422);
}

/**
 * Run a repository creation operation with deterministic retry-on-collision.
 * The callback owns the actual GitHub create/generate request and should throw
 * GithubRepositoryNameCollisionError when GitHub reports a name collision.
 */
export async function createRepositoryWithRetry<T>(
  login: string,
  existingNames: Iterable<string>,
  create: (destination: RepositoryDestination) => Promise<T>,
  maxAttempts = MAX_REPOSITORY_NAME_ATTEMPTS,
): Promise<{ destination: RepositoryDestination; result: T }> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('invalid repository name retry limit');
  }

  const occupied = occupiedNames(existingNames);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const destination = selectRepositoryDestination(login, occupied);
    try {
      const result = await create(destination);
      return { destination, result };
    } catch (error) {
      if (!isGithubRepositoryNameCollision(error)) throw error;
      occupied.add(destination.name.toLowerCase());
    }
  }
  throw new Error('repository creation retry limit exceeded');
}
