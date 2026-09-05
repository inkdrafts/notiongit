/**
 * Dispatch and correlate the template's Notion sync workflow.
 *
 * `workflow_dispatch` never returns a run id, so a dispatched run is
 * correlated the standard way: snapshot the workflow's run ids immediately
 * before dispatching, then poll the run list for the first `workflow_dispatch`
 * run whose id was not in that snapshot and whose `created_at` is not earlier
 * than the dispatch. All calls use the installation token, matching Pages
 * configuration; no Notion credential ever passes through this module.
 */

export const SYNC_WORKFLOW_FILE = 'sync-notion.yml';

export const SYNC_CORRELATE_MAX_ATTEMPTS = 6;
export const SYNC_CORRELATE_INITIAL_DELAY_MS = 500;
export const SYNC_CORRELATE_MAX_DELAY_MS = 4_000;

export const SYNC_RUN_MAX_POLL_ATTEMPTS = 12;
export const SYNC_RUN_POLL_INITIAL_DELAY_MS = 3_000;
export const SYNC_RUN_POLL_MAX_DELAY_MS = 20_000;

/** Tolerance for clock skew between this Worker and GitHub's run timestamps. */
const CORRELATE_CLOCK_SKEW_TOLERANCE_MS = 10_000;

export interface NotionSyncRunIdentity {
  runId: number;
  htmlUrl: string;
  status: string;
  conclusion: string | null;
  headSha: string | null;
  /** Epoch ms from the run's `created_at`; null when GitHub omits or garbles it. */
  createdAtMs: number | null;
  /** Epoch ms from the run's `updated_at`. For a completed run this is the
   * closest thing GitHub exposes to a finish time. */
  updatedAtMs: number | null;
}

export type GithubSyncErrorCode =
  | 'github_sync_dispatch_unavailable'
  | 'github_sync_permission_denied'
  | 'github_sync_rate_limited'
  | 'github_sync_correlate_timeout'
  | 'github_sync_run_timeout'
  | 'github_sync_run_failed'
  | 'github_sync_unavailable';

export class GithubSyncError extends Error {
  readonly code: GithubSyncErrorCode;
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(code: GithubSyncErrorCode, status: number, retryAfterSeconds: number | null = null) {
    super(code);
    this.name = 'GithubSyncError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface WorkflowRunResponse {
  id?: unknown;
  html_url?: unknown;
  status?: unknown;
  conclusion?: unknown;
  head_sha?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  event?: unknown;
}

export interface NotionSyncPollOptions {
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

function retryAfterSeconds(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (value === null) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

function isUsableRunShape(run: WorkflowRunResponse): boolean {
  return Number.isSafeInteger(run.id) && (run.id as number) > 0 && typeof run.status === 'string';
}

function epochMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function runIdentity(run: WorkflowRunResponse): NotionSyncRunIdentity {
  return {
    runId: run.id as number,
    htmlUrl: typeof run.html_url === 'string' ? run.html_url : '',
    status: run.status as string,
    conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
    headSha: typeof run.head_sha === 'string' ? run.head_sha : null,
    createdAtMs: epochMs(run.created_at),
    updatedAtMs: epochMs(run.updated_at),
  };
}

function runsPath(repositoryFullName: string): string {
  return `${repositoryPath(repositoryFullName)}/actions/workflows/${SYNC_WORKFLOW_FILE}`;
}

function repositoryPath(repositoryFullName: string): string {
  const parts = repositoryFullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new GithubSyncError('github_sync_unavailable', 502);
  }
  return `/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
}

/** Non-secret snapshot of a workflow's current run ids, used to detect a new run. */
export async function listWorkflowRunIds(
  installationToken: string,
  repositoryFullName: string,
  fetcher: typeof fetch = fetch,
): Promise<Set<number>> {
  const response = await fetcher(`${GITHUB_API}${runsPath(repositoryFullName)}/runs?event=workflow_dispatch&per_page=20`, {
    headers: githubHeaders(installationToken),
  });
  if (!response.ok) throw new GithubSyncError('github_sync_unavailable', 502);
  const body = await readJson<{ workflow_runs?: WorkflowRunResponse[] }>(response);
  const runs = body?.workflow_runs ?? [];
  return new Set(runs.filter(isUsableRunShape).map((run) => run.id as number));
}

/**
 * One-shot read of the most recent `workflow_dispatch` run, GitHub's
 * newest-first order taken as-is. Null means the read succeeded and no run
 * exists; a failed read throws so the caller can distinguish "never ran"
 * from "cannot tell right now". Run outputs, step summaries, and logs are
 * never read — GitHub exposes none of them after the run completes.
 */
export async function latestDispatchedSyncRun(
  installationToken: string,
  repositoryFullName: string,
  fetcher: typeof fetch = fetch,
): Promise<NotionSyncRunIdentity | null> {
  const response = await fetcher(`${GITHUB_API}${runsPath(repositoryFullName)}/runs?event=workflow_dispatch&per_page=1`, {
    headers: githubHeaders(installationToken),
  });
  if (!response.ok) throw new GithubSyncError('github_sync_unavailable', 502);
  const body = await readJson<{ workflow_runs?: WorkflowRunResponse[] }>(response);
  const run = (body?.workflow_runs ?? []).find(isUsableRunShape);
  return run ? runIdentity(run) : null;
}

const RUN_SUMMARY_ARTIFACT_NAME = 'notiongit-run-summary';
const MAX_RUN_SUMMARY_BYTES = 1024 * 1024;

interface WorkflowArtifact {
  id?: unknown;
  name?: unknown;
  expired?: unknown;
}

function uint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

async function unzipRunSummary(buffer: ArrayBuffer): Promise<string | null> {
  const bytes = new Uint8Array(buffer);
  const minimumEndOfCentralDirectory = 22;
  const endSearchStart = Math.max(0, bytes.length - minimumEndOfCentralDirectory - 0xffff);
  let endOfCentralDirectory = -1;
  for (let offset = bytes.length - minimumEndOfCentralDirectory; offset >= endSearchStart; offset -= 1) {
    if (offset >= 0 && uint32(bytes, offset) === 0x06054b50) {
      endOfCentralDirectory = offset;
      break;
    }
  }
  if (endOfCentralDirectory < 0) return null;

  const centralDirectorySize = uint32(bytes, endOfCentralDirectory + 12);
  const centralDirectoryOffset = uint32(bytes, endOfCentralDirectory + 16);
  if (centralDirectoryOffset + centralDirectorySize > bytes.length) return null;

  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let offset = centralDirectoryOffset;
  const directoryEnd = centralDirectoryOffset + centralDirectorySize;
  while (offset + 46 <= directoryEnd && uint32(bytes, offset) === 0x02014b50) {
    const compressionMethod = uint16(bytes, offset + 10);
    const compressedSize = uint32(bytes, offset + 20);
    const uncompressedSize = uint32(bytes, offset + 24);
    const fileNameSize = uint16(bytes, offset + 28);
    const extraSize = uint16(bytes, offset + 30);
    const commentSize = uint16(bytes, offset + 32);
    const localHeaderOffset = uint32(bytes, offset + 42);
    const entryEnd = offset + 46 + fileNameSize + extraSize + commentSize;
    if (entryEnd > directoryEnd) return null;
    const fileName = decoder.decode(bytes.slice(offset + 46, offset + 46 + fileNameSize));
    if (fileName === 'run-summary.json') {
      if (
        compressionMethod !== 0 && compressionMethod !== 8 ||
        uncompressedSize > MAX_RUN_SUMMARY_BYTES ||
        localHeaderOffset + 30 > bytes.length ||
        uint32(bytes, localHeaderOffset) !== 0x04034b50
      ) return null;
      const localFileNameSize = uint16(bytes, localHeaderOffset + 26);
      const localExtraSize = uint16(bytes, localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localFileNameSize + localExtraSize;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > bytes.length) return null;
      const compressed = bytes.slice(dataStart, dataEnd);
      const uncompressed = compressionMethod === 0
        ? compressed
        : new Uint8Array(await new Response(
          new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw')),
        ).arrayBuffer());
      if (uncompressed.byteLength !== uncompressedSize) return null;
      return decoder.decode(uncompressed);
    }
    offset = entryEnd;
  }
  return null;
}

export async function latestSyncRunSummary(
  installationToken: string,
  repositoryFullName: string,
  runId: number,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const headers = githubHeaders(installationToken);
    const artifactsResponse = await fetcher(
      `${GITHUB_API}${repositoryPath(repositoryFullName)}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(RUN_SUMMARY_ARTIFACT_NAME)}&per_page=1`,
      { headers },
    );
    if (!artifactsResponse.ok) return null;
    const body = await readJson<{ artifacts?: WorkflowArtifact[] }>(artifactsResponse);
    const artifact = (body?.artifacts ?? []).find((candidate) =>
      candidate.name === RUN_SUMMARY_ARTIFACT_NAME &&
      Number.isSafeInteger(candidate.id) &&
      candidate.expired !== true);
    if (!artifact) return null;

    const archiveResponse = await fetcher(
      `${GITHUB_API}${repositoryPath(repositoryFullName)}/actions/artifacts/${artifact.id}/zip`,
      { headers },
    );
    if (!archiveResponse.ok) return null;
    return await unzipRunSummary(await archiveResponse.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * The same read without the trigger filter, so a manual re-run can see a
 * scheduled run of the sync workflow that is still in flight. Null and the
 * throwing behavior match `latestDispatchedSyncRun`.
 */
export async function latestSyncRun(
  installationToken: string,
  repositoryFullName: string,
  fetcher: typeof fetch = fetch,
): Promise<NotionSyncRunIdentity | null> {
  const response = await fetcher(`${GITHUB_API}${runsPath(repositoryFullName)}/runs?per_page=1`, {
    headers: githubHeaders(installationToken),
  });
  if (!response.ok) throw new GithubSyncError('github_sync_unavailable', 502);
  const body = await readJson<{ workflow_runs?: WorkflowRunResponse[] }>(response);
  const run = (body?.workflow_runs ?? []).find(isUsableRunShape);
  return run ? runIdentity(run) : null;
}

/** Trigger the template's documented sync workflow with safe default bulk-delete behavior. */
export async function dispatchNotionSyncWorkflow(
  installationToken: string,
  repositoryFullName: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`${GITHUB_API}${runsPath(repositoryFullName)}/dispatches`, {
    method: 'POST',
    headers: (() => {
      const headers = githubHeaders(installationToken);
      headers.set('Content-Type', 'application/json');
      return headers;
    })(),
    body: JSON.stringify({ ref: 'main', inputs: { allow_bulk_delete: 'false' } }),
  });

  if (response.status === 204) return;
  if (response.status === 403 || response.status === 429) {
    throw new GithubSyncError('github_sync_rate_limited', 429, retryAfterSeconds(response));
  }
  if (response.status === 401) throw new GithubSyncError('github_sync_permission_denied', 403);
  if (response.status === 404 || response.status === 422) {
    throw new GithubSyncError('github_sync_dispatch_unavailable', 502);
  }
  throw new GithubSyncError('github_sync_unavailable', 502);
}

/** Find the run a just-issued dispatch produced, never an id seen before it. */
export async function correlateDispatchedSyncRun(
  installationToken: string,
  repositoryFullName: string,
  excludedRunIds: ReadonlySet<number>,
  dispatchedAtMs: number,
  options: NotionSyncPollOptions = {},
): Promise<NotionSyncRunIdentity> {
  const {
    maxAttempts = SYNC_CORRELATE_MAX_ATTEMPTS,
    initialDelayMs = SYNC_CORRELATE_INITIAL_DELAY_MS,
    maxDelayMs = SYNC_CORRELATE_MAX_DELAY_MS,
    fetcher = fetch,
    sleep = defaultSleep,
  } = options;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('invalid sync correlation attempt limit');
  }

  const notBeforeMs = dispatchedAtMs - CORRELATE_CLOCK_SKEW_TOLERANCE_MS;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetcher(`${GITHUB_API}${runsPath(repositoryFullName)}/runs?event=workflow_dispatch&per_page=20`, {
      headers: githubHeaders(installationToken),
    });
    if (response.ok) {
      const body = await readJson<{ workflow_runs?: WorkflowRunResponse[] }>(response);
      const runs = (body?.workflow_runs ?? []).filter(isUsableRunShape);
      const match = runs.find((run) => {
        if (excludedRunIds.has(run.id as number)) return false;
        const createdAt = typeof run.created_at === 'string' ? Date.parse(run.created_at) : NaN;
        return Number.isFinite(createdAt) && createdAt >= notBeforeMs;
      });
      if (match) return runIdentity(match);
    }
    if (attempt < maxAttempts) {
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }

  throw new GithubSyncError('github_sync_correlate_timeout', 504);
}

/** Dispatch the sync workflow and correlate the run it produced. */
export async function dispatchAndCorrelateNotionSync(
  installationToken: string,
  repositoryFullName: string,
  options: NotionSyncPollOptions = {},
): Promise<NotionSyncRunIdentity> {
  const { fetcher = fetch } = options;
  const excludedRunIds = await listWorkflowRunIds(installationToken, repositoryFullName, fetcher);
  const dispatchedAtMs = Date.now();
  await dispatchNotionSyncWorkflow(installationToken, repositoryFullName, fetcher);
  return correlateDispatchedSyncRun(installationToken, repositoryFullName, excludedRunIds, dispatchedAtMs, options);
}

/**
 * Poll a correlated run until GitHub reports it `completed`. A completed run
 * whose conclusion is not `success` (the guarded bulk-delete abort, an
 * unexpected sync error, or any other non-zero exit) is reported as a
 * distinct failure rather than returned for the caller to re-check.
 */
export async function awaitNotionSyncRun(
  installationToken: string,
  repositoryFullName: string,
  runId: number,
  options: NotionSyncPollOptions = {},
): Promise<NotionSyncRunIdentity> {
  const {
    maxAttempts = SYNC_RUN_MAX_POLL_ATTEMPTS,
    initialDelayMs = SYNC_RUN_POLL_INITIAL_DELAY_MS,
    maxDelayMs = SYNC_RUN_POLL_MAX_DELAY_MS,
    fetcher = fetch,
    sleep = defaultSleep,
  } = options;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('invalid sync run poll attempt limit');
  }

  const parts = repositoryFullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new GithubSyncError('github_sync_unavailable', 502);
  const path = `/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/actions/runs/${runId}`;

  let delay = initialDelayMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetcher(`${GITHUB_API}${path}`, { headers: githubHeaders(installationToken) });
    if (response.ok) {
      const body = await readJson<WorkflowRunResponse>(response);
      if (body && isUsableRunShape(body) && body.status === 'completed') {
        const identity = runIdentity(body);
        if (identity.conclusion !== 'success') throw new GithubSyncError('github_sync_run_failed', 502);
        return identity;
      }
    } else if (response.status !== 404 && !(response.status >= 500)) {
      throw new GithubSyncError('github_sync_unavailable', 502);
    }
    if (attempt < maxAttempts) {
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelayMs);
    }
  }

  throw new GithubSyncError('github_sync_run_timeout', 504);
}
