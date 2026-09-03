/**
 * Patching of deployment-owned Jekyll configuration.
 *
 * _config.yml is edited as text rather than round-tripped through a YAML
 * parser. That keeps comments, ordering, quoting, and fields owned by the
 * sync process intact while allowing provisioning to own only url/baseurl.
 */

import type { RepositoryDestination } from './repository-naming';

export const JEKYLL_CONFIG_PATH = '_config.yml';
export const JEKYLL_CONFIG_BRANCH = 'main';
export const CONFIG_PATCH_MAX_ATTEMPTS = 3;
export const CONFIG_PATCH_COMMIT_MESSAGE = 'chore: configure Jekyll site URLs for InkDrafts';

export type GithubConfigErrorCode =
  | 'github_config_unavailable'
  | 'github_config_conflict'
  | 'github_config_invalid'
  | 'github_config_rate_limited';

export class GithubConfigError extends Error {
  readonly code: GithubConfigErrorCode;
  readonly status: number;
  /** Seconds GitHub asked the caller to wait, parsed from a 403/429
   * `Retry-After`; null when the failure carries no pacing instruction. */
  readonly retryAfterSeconds: number | null;

  constructor(code: GithubConfigErrorCode, status: number, retryAfterSeconds: number | null = null) {
    super(code);
    this.name = 'GithubConfigError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface ConfigPatchResult {
  changed: boolean;
  /** The Contents API blob SHA when GitHub returned one. */
  contentSha: string | null;
  /** The commit SHA when GitHub returned one; null when no commit was made. */
  commitSha: string | null;
}

export interface ConfigPatchOptions {
  maxAttempts?: number;
  commitMessage?: string;
  fetcher?: typeof fetch;
}

interface GithubContentsFileResponse {
  type?: string;
  encoding?: string;
  content?: string;
  sha?: string;
}

interface GithubContentsWriteResponse {
  content?: { sha?: string } | null;
  commit?: { sha?: string } | null;
}

const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function githubHeaders(accessToken: string): Headers {
  return new Headers({
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${accessToken}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  });
}

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/gu, ''));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function repositoryContentsUrl(repositoryFullName: string, includeRef = false): string {
  const parts = repositoryFullName.split('/');
  if (parts.length !== 2 || parts.some((part) => !part)) {
    throw new GithubConfigError('github_config_invalid', 502);
  }
  const [owner, name] = parts;
  const path = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${JEKYLL_CONFIG_PATH}`;
  return includeRef ? `${path}?ref=${JEKYLL_CONFIG_BRANCH}` : path;
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

interface ConfigLine {
  key: 'url' | 'baseurl';
  prefix: string;
  value: string;
}

function commentStart(value: string): number | null {
  let quote: 'single' | 'double' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === 'double' && character === '\\') {
      index += 1;
      continue;
    }
    if (character === '"' && quote !== 'single') quote = quote === 'double' ? null : 'double';
    else if (character === "'" && quote !== 'double') quote = quote === 'single' ? null : 'single';
    else if (character === '#' && quote === null && (index === 0 || /\s/u.test(value[index - 1]))) return index;
  }
  return null;
}

function valueWithoutComment(value: string): string {
  const index = commentStart(value);
  return (index === null ? value : value.slice(0, index)).trim();
}

function scalarValue(value: string): string {
  const scalar = valueWithoutComment(value);
  if (scalar.startsWith('"') && scalar.endsWith('"')) {
    try {
      const decoded = JSON.parse(scalar);
      if (typeof decoded === 'string') return decoded;
    } catch {
      // The replacement below still gives a safe, deterministic YAML scalar.
    }
  }
  if (scalar.startsWith("'") && scalar.endsWith("'")) {
    return scalar.slice(1, -1).replaceAll("''", "'");
  }
  return scalar;
}

function splitComment(value: string): { content: string; suffix: string } {
  const index = commentStart(value);
  if (index === null) {
    const trailing = value.match(/\s*$/u)?.[0] ?? '';
    return { content: value.slice(0, value.length - trailing.length), suffix: trailing };
  }
  let suffixStart = index;
  while (suffixStart > 0 && /\s/u.test(value[suffixStart - 1])) suffixStart -= 1;
  return { content: value.slice(0, suffixStart), suffix: value.slice(suffixStart) };
}

function configLine(line: string): ConfigLine | null {
  // Only column-zero keys are deployment-owned. Nested keys such as an
  // author's custom `url` remain untouched.
  const match = line.match(/^(url|baseurl)(\s*:\s*)(.*)$/u);
  if (!match) return null;
  return { key: match[1] as 'url' | 'baseurl', prefix: `${match[1]}${match[2]}`, value: match[3] };
}

interface PatchedConfig {
  content: string;
  changed: boolean;
}

function patchConfigContent(
  content: string,
  destination: Pick<RepositoryDestination, 'url' | 'baseurl'>,
): PatchedConfig {
  const desired: Record<'url' | 'baseurl', string> = {
    url: destination.url,
    baseurl: destination.baseurl,
  };
  const pieces = content.split(/(\r\n|\n|\r)/u);
  const seen = new Set<'url' | 'baseurl'>();
  let changed = false;

  for (let index = 0; index < pieces.length; index += 2) {
    const parsed = configLine(pieces[index]);
    if (!parsed) continue;
    if (seen.has(parsed.key)) throw new GithubConfigError('github_config_invalid', 502);
    seen.add(parsed.key);

    if (scalarValue(parsed.value) === desired[parsed.key]) continue;
    const { suffix } = splitComment(parsed.value);
    const separator = suffix.startsWith('#') ? ' ' : '';
    pieces[index] = `${parsed.prefix}${JSON.stringify(desired[parsed.key])}${separator}${suffix}`;
    changed = true;
  }

  if (seen.size !== 2) throw new GithubConfigError('github_config_invalid', 502);
  return { content: pieces.join(''), changed };
}

async function readConfigFile(
  accessToken: string,
  repositoryFullName: string,
  fetcher: typeof fetch,
): Promise<{ content: string; sha: string }> {
  const url = repositoryContentsUrl(repositoryFullName, true);
  let response: Response;
  try {
    response = await fetcher(url, { headers: githubHeaders(accessToken) });
  } catch {
    throw new GithubConfigError('github_config_unavailable', 502);
  }
  if (!response.ok) throw new GithubConfigError('github_config_unavailable', response.status || 502);

  const file = await readJson<GithubContentsFileResponse>(response);
  if (
    !file ||
    (file.type !== undefined && file.type !== 'file') ||
    (file.encoding !== undefined && file.encoding !== 'base64') ||
    typeof file.content !== 'string' ||
    typeof file.sha !== 'string' ||
    !file.sha
  ) {
    throw new GithubConfigError('github_config_invalid', 502);
  }

  try {
    return { content: textDecoder.decode(base64Decode(file.content)), sha: file.sha };
  } catch {
    throw new GithubConfigError('github_config_invalid', 502);
  }
}

/**
 * Patch only the top-level url and baseurl keys in a generated repository.
 * A conflict rereads the current blob and reapplies the two owned values, so
 * concurrent changes to unrelated fields are preserved.
 */
export async function patchRepositoryConfig(
  accessToken: string,
  repositoryFullName: string,
  destination: Pick<RepositoryDestination, 'url' | 'baseurl'>,
  options: ConfigPatchOptions = {},
): Promise<ConfigPatchResult> {
  const {
    maxAttempts = CONFIG_PATCH_MAX_ATTEMPTS,
    commitMessage = CONFIG_PATCH_COMMIT_MESSAGE,
    fetcher = fetch,
  } = options;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('invalid config patch attempt limit');
  if (
    typeof destination.url !== 'string' ||
    typeof destination.baseurl !== 'string' ||
    !destination.url
  ) {
    throw new GithubConfigError('github_config_invalid', 502);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const current = await readConfigFile(accessToken, repositoryFullName, fetcher);
    const patched = patchConfigContent(current.content, destination);
    if (!patched.changed) return { changed: false, contentSha: current.sha, commitSha: null };

    let response: Response;
    try {
      const headers = githubHeaders(accessToken);
      headers.set('Content-Type', 'application/json');
      response = await fetcher(repositoryContentsUrl(repositoryFullName), {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message: commitMessage,
          content: base64Encode(textEncoder.encode(patched.content)),
          sha: current.sha,
          branch: JEKYLL_CONFIG_BRANCH,
        }),
      });
    } catch {
      throw new GithubConfigError('github_config_unavailable', 502);
    }

    if (response.ok) {
      const result = await readJson<GithubContentsWriteResponse>(response);
      return {
        changed: true,
        contentSha: typeof result?.content?.sha === 'string' ? result.content.sha : null,
        commitSha: typeof result?.commit?.sha === 'string' ? result.commit.sha : null,
      };
    }
    if (response.status === 409) {
      if (attempt < maxAttempts) continue;
      throw new GithubConfigError('github_config_conflict', 409);
    }
    if (response.status === 403 || response.status === 429) {
      const retryAfter = retryAfterSeconds(response);
      if (retryAfter !== null || response.status === 429) {
        throw new GithubConfigError('github_config_rate_limited', 429, retryAfter);
      }
    }
    throw new GithubConfigError('github_config_unavailable', response.status || 502);
  }

  throw new GithubConfigError('github_config_conflict', 409);
}

/** Alias naming the repository-generation use of the patcher explicitly. */
export const patchGeneratedRepositoryConfig = patchRepositoryConfig;
