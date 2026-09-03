/**
 * Repository generation from the InkDrafts template.
 *
 * Generation happens while the short-lived user access token is in memory:
 * GitHub requires user-to-server authentication to create a repository from a
 * template in the user's own account. Verification afterwards uses the
 * installation token, which also proves that the App installation received
 * the new repository. Neither token is persisted or included in errors.
 */

import {
  GithubRepositoryNameCollisionError,
  createRepositoryWithRetry,
  isGithubRepositoryNameCollision,
  repositoryDestination,
  type GithubRepositorySummary,
  type RepositoryDestination,
} from './repository-naming';

export const TEMPLATE_REPOSITORY_OWNER = 'inkdrafts';
export const TEMPLATE_REPOSITORY_NAME = 'notiongit-template';
export const TEMPLATE_REPOSITORY_FULL_NAME = `${TEMPLATE_REPOSITORY_OWNER}/${TEMPLATE_REPOSITORY_NAME}`;

/**
 * The product description sent with every generated repository. It doubles as
 * the marker that distinguishes an InkDrafts-generated repository from a
 * foreign repository that happens to hold the selected name.
 */
export const GENERATED_REPOSITORY_DESCRIPTION = 'Notion-powered site published with InkDrafts';

export const GENERATE_MAX_POLL_ATTEMPTS = 8;
export const GENERATE_POLL_INITIAL_DELAY_MS = 250;
export const GENERATE_POLL_MAX_DELAY_MS = 8_000;

/** Non-secret repository identity recorded in the provisioning job. */
export interface GeneratedRepositoryIdentity {
  id: number;
  fullName: string;
  name: string;
  htmlUrl: string;
  defaultBranch: string;
  templateFullName: string;
  /** Template `main` HEAD at generation time; `null` when unknown or reused. */
  templateHeadSha: string | null;
  /** Tree of the template `main` HEAD; equality with `headTreeSha` proves the
   * generated repository contains the expected template revision (GitHub
   * rewrites the initial commit, so commit SHAs never match). */
  templateHeadTreeSha: string | null;
  /** Generated `main` HEAD once readable; `null` until verification succeeds. */
  headSha: string | null;
  /** Tree of the generated `main` HEAD once readable. */
  headTreeSha: string | null;
  /** True when an already-generated repository was adopted instead of created. */
  reused: boolean;
}

export type GithubGenerateErrorCode =
  | 'github_generate_rate_limited'
  | 'github_generate_timeout'
  | 'github_generate_name_exhausted'
  | 'github_generate_unavailable'
  | 'github_generate_branch_mismatch';

export class GithubGenerateError extends Error {
  readonly code: GithubGenerateErrorCode;
  /** HTTP status the Worker should surface for this failure. */
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(code: GithubGenerateErrorCode, status: number, retryAfterSeconds: number | null = null) {
    super(code);
    this.name = 'GithubGenerateError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

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

function withJsonContent(headers: Headers): Headers {
  headers.set('Content-Type', 'application/json');
  return headers;
}

interface GeneratedRepositoryResponse extends GithubRepositorySummary {
  visibility?: string;
}

function isUsableRepositoryShape(repository: GeneratedRepositoryResponse): boolean {
  return (
    typeof repository.name === 'string' &&
    Number.isSafeInteger(repository.id) &&
    repository.id! > 0 &&
    typeof repository.full_name === 'string' &&
    typeof repository.html_url === 'string' &&
    typeof repository.default_branch === 'string'
  );
}

function generatedIdentity(
  repository: GeneratedRepositoryResponse,
  reused: boolean,
): GeneratedRepositoryIdentity {
  if (!isUsableRepositoryShape(repository)) throw new GithubGenerateError('github_generate_unavailable', 502);
  if (repository.fork === true) throw new GithubGenerateError('github_generate_unavailable', 502);
  return {
    id: repository.id as number,
    fullName: repository.full_name as string,
    name: repository.name as string,
    htmlUrl: repository.html_url as string,
    defaultBranch: repository.default_branch as string,
    templateFullName: TEMPLATE_REPOSITORY_FULL_NAME,
    templateHeadSha: null,
    templateHeadTreeSha: null,
    headSha: null,
    headTreeSha: null,
    reused,
  };
}

/** A repository is ours to reuse when it is not a fork and carries the marker description. */
export function isInkdraftsGeneratedRepository(repository: GithubRepositorySummary): boolean {
  return (
    typeof repository.name === 'string' &&
    repository.fork !== true &&
    repository.description === GENERATED_REPOSITORY_DESCRIPTION
  );
}

/**
 * Find a repository this Worker generated on an earlier attempt so a retry
 * reuses it instead of creating a duplicate. The pick is deterministic: the
 * apex name wins, then the shortest project name, then alphabetical order.
 */
export function findReusableGeneratedRepository(
  ownedRepositories: GithubRepositorySummary[],
  login: string,
): GeneratedRepositoryIdentity | null {
  const candidates = ownedRepositories.filter(
    (repository) => isInkdraftsGeneratedRepository(repository) && isUsableRepositoryShape(repository),
  );
  if (candidates.length === 0) return null;

  const apexName = `${login.toLowerCase()}.github.io`;
  const sorted = [...candidates].sort((a, b) => {
    const aName = a.name as string;
    const bName = b.name as string;
    const aApex = aName === apexName ? 0 : 1;
    const bApex = bName === apexName ? 0 : 1;
    if (aApex !== bApex) return aApex - bApex;
    if (aName.length !== bName.length) return aName.length - bName.length;
    return aName < bName ? -1 : 1;
  });
  return generatedIdentity(sorted[0], true);
}

/** Best-effort read of the template's `main` HEAD and its tree; `null` on any failure. */
export async function getTemplateHead(
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<{ sha: string; treeSha: string } | null> {
  try {
    const response = await fetcher(
      `${GITHUB_API}/repos/${TEMPLATE_REPOSITORY_FULL_NAME}/commits/main`,
      { headers: githubHeaders(`Bearer ${accessToken}`) },
    );
    if (!response.ok) return null;
    const commit = await readJson<{ sha?: string; commit?: { tree?: { sha?: string } } }>(response);
    if (typeof commit?.sha !== 'string' || !commit.sha) return null;
    const treeSha = commit.commit?.tree?.sha;
    return typeof treeSha === 'string' && treeSha ? { sha: commit.sha, treeSha } : null;
  } catch {
    return null;
  }
}

/**
 * Create the destination repository from the InkDrafts template with the
 * user access token. A `422` response is reported through the naming
 * module's collision error so `createRepositoryWithRetry` can advance.
 */
export async function generateRepositoryFromTemplate(
  accessToken: string,
  destination: RepositoryDestination,
  fetcher: typeof fetch = fetch,
): Promise<GeneratedRepositoryIdentity> {
  const response = await fetcher(`${GITHUB_API}/repos/${TEMPLATE_REPOSITORY_FULL_NAME}/generate`, {
    method: 'POST',
    headers: withJsonContent(githubHeaders(`Bearer ${accessToken}`)),
    body: JSON.stringify({
      name: destination.name,
      description: GENERATED_REPOSITORY_DESCRIPTION,
      private: false,
      include_all_branches: false,
    }),
  });

  if (response.status === 422) throw new GithubRepositoryNameCollisionError();
  if (response.status === 403 || response.status === 429) {
    const retryAfter = retryAfterSeconds(response);
    if (retryAfter !== null || response.status === 429) {
      throw new GithubGenerateError('github_generate_rate_limited', 429, retryAfter);
    }
  }
  if (!response.ok) throw new GithubGenerateError('github_generate_unavailable', 502);

  const repository = await readJson<GeneratedRepositoryResponse>(response);
  if (repository === null) throw new GithubGenerateError('github_generate_unavailable', 502);
  return generatedIdentity(repository, false);
}

/**
 * Inspect a name that GitHub refused. When the occupying repository was
 * generated by InkDrafts on an earlier attempt, it is returned for idempotent
 * reuse; `null` means the name belongs to someone else and creation should
 * advance to the next candidate. An unreadable occupier is an error rather
 * than a guess, so a transient failure can never mint a duplicate repository.
 */
export async function reuseCollidingRepository(
  accessToken: string,
  login: string,
  name: string,
  fetcher: typeof fetch = fetch,
): Promise<GeneratedRepositoryIdentity | null> {
  const response = await fetcher(`${GITHUB_API}/repos/${login.toLowerCase()}/${encodeURIComponent(name)}`, {
    headers: githubHeaders(`Bearer ${accessToken}`),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new GithubGenerateError('github_generate_unavailable', 502);
  const repository = await readJson<GeneratedRepositoryResponse>(response);
  if (repository === null || !isInkdraftsGeneratedRepository(repository)) return null;
  return generatedIdentity(repository, true);
}

const defaultGenerateSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export interface GeneratedRepositoryPollOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Poll until the generated repository reports `main` with a readable initial
 * commit. Generation is asynchronous — the first repository response can
 * carry a placeholder default branch and no readable commit — so `404`s,
 * failures, and non-`main` reports all back off exponentially. Called with
 * the installation token so success also proves the App installation received
 * the repository; exhausting the attempts raises a distinct timeout error.
 * Only a fork is terminal, because a fork never becomes a generated repository.
 */
export async function awaitGeneratedRepositoryCommit(
  authorization: string,
  repositoryFullName: string,
  options: GeneratedRepositoryPollOptions = {},
): Promise<{ defaultBranch: 'main'; headSha: string; headTreeSha: string }> {
  const {
    maxAttempts = GENERATE_MAX_POLL_ATTEMPTS,
    initialDelayMs = GENERATE_POLL_INITIAL_DELAY_MS,
    maxDelayMs = GENERATE_POLL_MAX_DELAY_MS,
    fetcher = fetch,
    sleep = defaultGenerateSleep,
  } = options;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('invalid generation poll attempt limit');
  }

  const readGithubJson = async <T>(url: string): Promise<T | null> => {
    try {
      const response = await fetcher(url, { headers: githubHeaders(authorization) });
      if (!response.ok) return null;
      return await readJson<T>(response);
    } catch {
      return null;
    }
  };

  let delay = initialDelayMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const repository = await readGithubJson<GeneratedRepositoryResponse>(`${GITHUB_API}/repos/${repositoryFullName}`);
    if (repository !== null) {
      if (repository.fork === true) {
        throw new GithubGenerateError('github_generate_branch_mismatch', 502);
      }
      if (repository.default_branch === 'main') {
        const commit = await readGithubJson<{ sha?: string; commit?: { tree?: { sha?: string } } }>(
          `${GITHUB_API}/repos/${repositoryFullName}/commits/main`,
        );
        const treeSha = commit?.commit?.tree?.sha;
        if (typeof commit?.sha === 'string' && commit.sha && typeof treeSha === 'string' && treeSha) {
          return { defaultBranch: 'main', headSha: commit.sha, headTreeSha: treeSha };
        }
      }
    }
    if (attempt < maxAttempts) {
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }

  throw new GithubGenerateError('github_generate_timeout', 504);
}

/**
 * Reuse an earlier InkDrafts-generated repository when one exists, otherwise
 * create one from the template with deterministic retry-on-collision.
 */
export async function generateOrReuseRepository(
  accessToken: string,
  login: string,
  ownedRepositories: GithubRepositorySummary[],
  fetcher: typeof fetch = fetch,
): Promise<{ destination: RepositoryDestination; identity: GeneratedRepositoryIdentity }> {
  const reusable = findReusableGeneratedRepository(ownedRepositories, login);
  if (reusable) {
    return {
      destination: repositoryDestination(login, reusable.name),
      identity: reusable,
    };
  }

  const templateHead = await getTemplateHead(accessToken, fetcher);
  const ownedNames = ownedRepositories
    .map((repository) => repository.name)
    .filter((name): name is string => typeof name === 'string');
  let created;
  try {
    created = await createRepositoryWithRetry(
      login,
      ownedNames,
      async (candidate) => {
        try {
          return await generateRepositoryFromTemplate(accessToken, candidate, fetcher);
        } catch (error) {
          if (isGithubRepositoryNameCollision(error)) {
            // A name GitHub refused may be one of ours from an interrupted
            // attempt; adopt it instead of advancing to a duplicate.
            const reuse = await reuseCollidingRepository(accessToken, login, candidate.name, fetcher);
            if (reuse) return reuse;
          }
          throw error;
        }
      },
    );
  } catch (error) {
    // Every deterministic candidate belonged to someone else: a terminal
    // collision, not a transient failure.
    if (error instanceof Error && error.message === 'repository creation retry limit exceeded') {
      throw new GithubGenerateError('github_generate_name_exhausted', 409);
    }
    throw error;
  }

  return {
    destination: created.destination,
    identity: {
      ...created.result,
      templateHeadSha: created.result.templateHeadSha ?? templateHead?.sha ?? null,
      templateHeadTreeSha: created.result.templateHeadTreeSha ?? templateHead?.treeSha ?? null,
    },
  };
}
