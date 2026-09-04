/**
 * Journey-driven token-hygiene canary suite.
 *
 * Every journey drives a real flow (worker.fetch, route, or worker.queue)
 * with synthetic credentials planted where the code under test mints or
 * receives them, then asserts their absence from every egress surface the
 * journey touches: KV writes, queue messages, response bodies and
 * Location/Set-Cookie headers, thrown errors, and console output. Each
 * journey also carries a positive-flow assertion proving the canary genuinely
 * flowed through the code (a vacuous pass is a failure), and per-write TTL
 * logs pinning the retention table documented in docs/security-data-flow.md.
 */

import { describe, expect, test, beforeAll } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import worker, {
  NOTION_STATE_PREFIX,
  NOTION_TEMPLATE_RESOLUTION_PREFIX,
  NOTION_TEMPLATE_RESOLUTION_TTL_SECONDS,
  PROVISIONING_JOB_TTL_SECONDS,
  NotionOAuthError,
  provisioningJobKey,
  route,
  type Env,
  type ProvisioningJob,
  type ProvisioningMessage,
} from '../src/index';
import { createProvisioningJob } from '../src/provisioning-job';

// ---------------------------------------------------------------------------
// Canaries. Every value is synthetic and unique so a leak anywhere names the
// journey that produced it. The throwaway RSA PEM below is itself a canary.
// ---------------------------------------------------------------------------

const NOTION_USER_TOKEN = 'synthetic-notion-user-token-9f2a41';
// Notion returns a refresh token that the exchange result types but nothing
// ever reads; the surface scans are what prove that.
const NOTION_REFRESH_TOKEN = 'synthetic-notion-refresh-token-3b8d57';
const GITHUB_USER_TOKEN = 'synthetic-github-user-token-7c419e';
const ONE_TIME_CODE = 'synthetic-one-time-code-5e7a83';
const GITHUB_CLIENT_SECRET = 'synthetic-github-client-secret-1d9f62';
const NOTION_CLIENT_SECRET = 'synthetic-notion-client-secret-8a2c74';
const WORKSPACE_ID = 'synthetic-workspace-id-4e6b18';
const INSTALLATION_TOKENS = Array.from(
  { length: 12 },
  (_, index) => `synthetic-installation-token-${index + 1}`,
);
// The Notion callback mints its own installation token to write the three
// Actions secrets, distinct from every queue-phase mint.
const SECRETS_INSTALLATION_TOKEN = 'synthetic-secrets-installation-token-0a5d92';
const MALFORMED_JUNK = 'synthetic-queue-junk-6d3a95';

const ACTIONS_PUBLIC_KEY = 'RwHQhIhFH1RaQJ+1iuPlhYHKQKw/fxFGmM1x3qxzygE=';
const REDACTED_MARKER = '[redacted]';
const GITHUB_STATE_PREFIX = 'github:oauth-state:';

let THROWAWAY_PEM = '';

const canaryValues = (): string[] => [
  NOTION_USER_TOKEN,
  NOTION_REFRESH_TOKEN,
  GITHUB_USER_TOKEN,
  ONE_TIME_CODE,
  GITHUB_CLIENT_SECRET,
  NOTION_CLIENT_SECRET,
  WORKSPACE_ID,
  MALFORMED_JUNK,
  SECRETS_INSTALLATION_TOKEN,
  ...INSTALLATION_TOKENS,
  THROWAWAY_PEM,
];

/** Stems catch per-mint token variants and credential-shaped key names. */
const CANARY_STEMS = ['synthetic-installation-token', 'access_token', 'refresh_token', 'client_secret'];

function assertClean(surface: string, text: string, options: { allowMarker?: boolean } = {}): void {
  for (const canary of canaryValues()) {
    if (text.includes(canary)) throw new Error(`${surface} leaked canary ${canary}`);
  }
  for (const stem of CANARY_STEMS) {
    if (text.includes(stem)) throw new Error(`${surface} leaked credential stem "${stem}"`);
  }
  if (!options.allowMarker && text.includes(REDACTED_MARKER)) {
    throw new Error(`${surface} contains a Secret serialization marker`);
  }
}

// ---------------------------------------------------------------------------
// Per-file test doubles (repo convention: no shared harness, no mock library).
// ---------------------------------------------------------------------------

/** MemoryKV that records every put and every delete attempt. */
class RecordingKV {
  private values = new Map<string, string>();

  readonly writes: Array<{ key: string; value: string; ttl: number | undefined }> = [];
  readonly deletes: string[] = [];

  async get<T>(key: string, type?: string): Promise<T | string | null> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) as T : value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.writes.push({ key, value, ttl: options?.expirationTtl });
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.values.delete(key);
  }

  /** Drops recorded writes, scoping a journey past test-authored fixture setup. */
  reset(): void {
    this.writes.length = 0;
    this.deletes.length = 0;
  }

  allText(): string {
    return JSON.stringify(this.writes);
  }

  /** Every TTL ever written for one key — per-write, never latest-value. */
  ttlLog(key: string): number[] {
    return this.writes.filter((write) => write.key === key).map((write) => write.ttl);
  }

  keysWithPrefix(prefix: string): string[] {
    return [...new Set(this.writes.map((write) => write.key).filter((key) => key.startsWith(prefix)))];
  }
}

class RecordingQueue {
  readonly sent: ProvisioningMessage[] = [];

  async send(message: ProvisioningMessage): Promise<void> {
    this.sent.push(message);
  }

  async sendBatch(): Promise<void> {
    throw new Error('RecordingQueue.sendBatch is not used by this project');
  }

  allText(): string {
    return JSON.stringify(this.sent);
  }
}

interface ConsoleRecord {
  level: string;
  text: string;
}

/** Patches every console method for the duration of one journey. */
class ConsoleRecorder {
  private readonly records: ConsoleRecord[] = [];
  private readonly originals = new Map<string, (...args: unknown[]) => void>();

  attach(): void {
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      this.originals.set(level, console[level]);
      console[level] = (...args: unknown[]) => {
        this.records.push({ level, text: args.map((argument) => String(argument)).join(' ') });
      };
    }
  }

  release(): void {
    for (const [level, original] of this.originals) {
      (console as unknown as Record<string, typeof original>)[level] = original;
    }
    this.originals.clear();
  }

  allText(): string {
    return JSON.stringify(this.records);
  }

  assertSilent(): void {
    expect(this.records).toEqual([]);
  }

  /** Console records may contain the redaction marker; they may not leak a canary. */
  assertNoCanary(): void {
    assertClean('console', this.allText(), { allowMarker: true });
  }

  /** Texts of reportError lines, the "[notiongit] …" records. */
  reportErrorTexts(): string[] {
    return this.records.map((record) => record.text).filter((text) => text.startsWith('[notiongit] '));
  }

  /**
   * Console output must come from one of the two sanctioned sinks — a
   * reportError line or one structured funnel event. Returns the funnel event
   * types in emission order.
   */
  funnelEventTypes(): string[] {
    const types: string[] = [];
    for (const record of this.records) {
      if (record.text.startsWith('[notiongit] ')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(record.text);
      } catch {
        throw new Error(`console record from an unsanctioned sink: ${record.text}`);
      }
      const type = (parsed as { type?: unknown }).type;
      expect(typeof type === 'string' && FUNNEL_EVENT_TYPES.has(type)).toBe(true);
      types.push(type as string);
    }
    return types;
  }

  assertSingleRecord(context: string): void {
    expect(this.records).toHaveLength(1);
    expect(this.records[0].text).toContain(`[notiongit] ${context}`);
  }

  recordText(index: number): string {
    return this.records[index]?.text ?? '';
  }
}

/** Runs one journey body with every console method captured and restored. */
async function withCapturedConsole<T>(journey: (recorder: ConsoleRecorder) => Promise<T>): Promise<T> {
  const recorder = new ConsoleRecorder();
  recorder.attach();
  try {
    return await journey(recorder);
  } finally {
    recorder.release();
  }
}

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
  body: string | null;
}

/**
 * Builds a fetch double that records every call ({method, url, authorization,
 * body}) and serves from `handle`. The recorded calls are the positive-flow
 * surface: canaries must appear there (they genuinely flowed) and nowhere else.
 */
function scriptedFetch(handle: (request: Request) => Response | Promise<Response>): {
  calls: RecordedRequest[];
  fetcher: typeof fetch;
} {
  const calls: RecordedRequest[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    // Read the recording off a clone: a handler that parses the body (the
    // sealed Actions-secret PUTs) still needs an unconsumed Request.
    const recording = request.clone();
    calls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get('authorization'),
      body: request.method === 'GET' || request.method === 'HEAD'
        ? null
        : await recording.text(),
    });
    return handle(request);
  };
  return { calls, fetcher };
}

interface FakeMessage {
  id: string;
  timestamp: Date;
  body: ProvisioningMessage;
  attempts: number;
  acked: boolean;
  retried: { delaySeconds?: number } | null;
  retry(options?: { delaySeconds?: number }): void;
  ack(): void;
}

function fakeMessage(body: ProvisioningMessage): FakeMessage {
  const message: FakeMessage = {
    id: 'message-1',
    timestamp: new Date(0),
    body,
    attempts: 1,
    acked: false,
    retried: null,
    retry(options) { message.retried = options ?? {}; },
    ack() { message.acked = true; },
  };
  return message;
}

function fakeBatch(messages: FakeMessage[]) {
  return {
    messages,
    queue: 'notiongit-provisioning',
    metadata: {},
    retryAll() { messages.forEach((message) => message.retry()); },
    ackAll() { messages.forEach((message) => message.ack()); },
  };
}

const FAKE_EXECUTION_CONTEXT = { waitUntil() {}, passThroughOnException() {}, props: {} };

let throwawayPrivateKey: Promise<string> | undefined;

function generateThrowawayPrivateKey(): Promise<string> {
  throwawayPrivateKey ??= (async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
    let base64 = '';
    for (const byte of der) base64 += String.fromCharCode(byte);
    return `-----BEGIN PRIVATE KEY-----\n${btoa(base64)}\n-----END PRIVATE KEY-----`;
  })();
  return throwawayPrivateKey;
}

// ---------------------------------------------------------------------------
// Surfaces. Response bodies are captured eagerly (bodies read once), so
// assertJourneyClean stays usable at any point of a journey.
// ---------------------------------------------------------------------------

interface Journey {
  kv: RecordingKV;
  queue: RecordingQueue;
  calls: RecordedRequest[];
  responses: Response[];
  responseSurfaces: string;
  thrown: string;
}

function emptyJourney(kv: RecordingKV, queue: RecordingQueue): Journey {
  return { kv, queue, calls: [], responses: [], responseSurfaces: '', thrown: '' };
}

async function addResponse(journey: Journey, response: Response): Promise<void> {
  journey.responses.push(response);
  const body = await response.clone().text();
  const headers = ['location', 'set-cookie']
    .map((name) => `${name}: ${response.headers.get(name) ?? ''}`)
    .join('\n');
  journey.responseSurfaces += `${body}\n${headers}\n`;
}

function captureThrownErrors(journey: Journey): (error: unknown) => void {
  const errors: unknown[] = [];
  journey.thrown = ''; // populated below via the returned tracker
  return (error) => {
    errors.push(error);
    journey.thrown = errors.map((caught) => String(caught)).join('\n');
  };
}

function assertJourneyClean(journey: Journey, recorder: ConsoleRecorder): void {
  assertClean('KV writes', journey.kv.allText());
  assertClean('queue sends', journey.queue.allText());
  assertClean('responses', journey.responseSurfaces);
  assertClean('thrown errors', journey.thrown);
  recorder.assertNoCanary();
}

/** The observability funnel's event vocabulary (src/observability.ts). */
const FUNNEL_EVENT_TYPES = new Set([
  'consent_started',
  'consent_completed',
  'consent_failed',
  'job_queued',
  'job_enqueue_failed',
  'step_started',
  'step_succeeded',
  'step_failed',
  'rate_limited',
  'job_succeeded',
  'job_dead_lettered',
]);

// ---------------------------------------------------------------------------
// Shared fixtures. Identifiers are synthetic but none are canaries, so the
// seeded template resolution never trips the surface scans.
// ---------------------------------------------------------------------------

const NOTION_JOB_ID = 'job-notion-1';
const GITHUB_JOB_ID = 'job-123';
const ROOT_DASHED = '55555555-5555-4555-8555-555555555555';
const PAGES_DB = '11111111-1111-4111-8111-111111111111';
const POSTS_DB = '22222222-2222-4222-8222-222222222222';
const THIRD_DB = '33333333-3333-4333-8333-333333333333';

function notionTokenResponse(): Response {
  return Response.json({
    access_token: NOTION_USER_TOKEN,
    token_type: 'bearer',
    refresh_token: NOTION_REFRESH_TOKEN,
    bot_id: 'synthetic-bot-id',
    workspace_id: WORKSPACE_ID,
    duplicated_template_id: ROOT_DASHED,
  });
}

function pagesProperties(): Record<string, unknown> {
  return {
    Title: { type: 'title' },
    Slug: { type: 'rich_text' },
    Type: {
      type: 'select',
      select: { options: [{ name: 'home' }, { name: 'blog-list' }, { name: 'blog' }, { name: 'markdown' }] },
    },
    'Nav Order': { type: 'number' },
    'Show in Nav': { type: 'checkbox' },
    Status: { type: 'select', select: { options: [{ name: 'Draft' }, { name: 'Published' }] } },
    Description: { type: 'rich_text' },
  };
}

function postsProperties(): Record<string, unknown> {
  return {
    Title: { type: 'title' },
    Slug: { type: 'rich_text' },
    Status: { type: 'select', select: { options: [{ name: 'Draft' }, { name: 'Published' }] } },
    'Publish Date': { type: 'date' },
    Tags: { type: 'multi_select', multi_select: { options: [{ name: 'guide' }] } },
    'Cover Image': { type: 'files' },
  };
}

function databaseResponse(id: string, properties: Record<string, unknown>): Response {
  return Response.json({
    object: 'database',
    id,
    title: [{ type: 'text', text: { content: 'A title the user may have renamed' } }],
    properties,
  });
}

function block(id: string, type: string): unknown {
  return { object: 'block', id, type, [type]: {} };
}

function childrenList(results: unknown[]): Response {
  return Response.json({ object: 'list', results, has_more: false, next_cursor: null });
}

async function canaryEnv(kv: RecordingKV, queue: RecordingQueue): Promise<Partial<Env>> {
  return {
    JOBS: kv as unknown as KVNamespace,
    PROVISIONING_QUEUE: queue as unknown as Queue<ProvisioningMessage>,
    GITHUB_APP_ID: 'synthetic-app-id',
    GITHUB_APP_SLUG: 'inkdrafts',
    GITHUB_APP_PRIVATE_KEY: await generateThrowawayPrivateKey(),
    GITHUB_CLIENT_ID: 'synthetic-github-client-id',
    GITHUB_CLIENT_SECRET,
    NOTION_CLIENT_ID: 'synthetic-notion-client-id',
    NOTION_CLIENT_SECRET,
  };
}

/** Seeds the job the GitHub callback would have created, in awaiting_notion. */
async function seedAwaitingNotionJob(kv: RecordingKV, jobId: string): Promise<ProvisioningJob> {
  const job = createProvisioningJob({
    jobId,
    installationId: 123,
    identity: { id: 42, login: 'alice', accountType: 'User' },
    repository: { name: 'alice.github.io', url: 'https://alice.github.io', baseurl: '', kind: 'apex' },
    generatedRepository: {
      id: 1001,
      fullName: 'alice/alice.github.io',
      name: 'alice.github.io',
      htmlUrl: 'https://github.com/alice/alice.github.io',
      defaultBranch: 'main',
      templateFullName: 'inkdrafts/notiongit-template',
      templateHeadSha: 'template-head-sha',
      templateHeadTreeSha: 'template-tree-sha',
      headSha: null,
      headTreeSha: null,
      reused: false,
    },
    now: 1_000,
  });
  await kv.put(provisioningJobKey(jobId), JSON.stringify(job), { expirationTtl: PROVISIONING_JOB_TTL_SECONDS });
  return job;
}

async function driveNotionCallback(options: {
  tokenEndpoint?: () => Response;
  extraPagesClone?: boolean;
  failResolutionSave?: () => Error;
} = {}): Promise<Journey & { secretWrites: Array<{ name: string; encryptedValue: string }> }> {
  const kv = new RecordingKV();
  const queue = new RecordingQueue();
  const journey = emptyJourney(kv, queue);
  const env = await canaryEnv(kv, queue);
  await seedAwaitingNotionJob(kv, NOTION_JOB_ID);
  kv.reset();
  const secretWrites: Array<{ name: string; encryptedValue: string }> = [];
  if (options.failResolutionSave) {
    const boom = options.failResolutionSave();
    env.JOBS = {
      get: (kv as unknown as KVNamespace).get.bind(kv),
      put: async (key: string, value: string, putOptions?: { expirationTtl?: number }) => {
        if (key.startsWith(NOTION_TEMPLATE_RESOLUTION_PREFIX)) throw boom;
        return kv.put(key, value, putOptions);
      },
    } as unknown as KVNamespace;
  }

  const trackError = captureThrownErrors(journey);
  const { calls, fetcher } = scriptedFetch((request) => {
    const url = new URL(request.url);
    if (url.href === 'https://api.notion.com/v1/oauth/token') {
      return options.tokenEndpoint?.() ?? notionTokenResponse();
    }
    if (url.pathname === `/v1/blocks/${ROOT_DASHED}/children`) {
      const blocks = [block(PAGES_DB, 'child_database'), block(POSTS_DB, 'child_database')];
      if (options.extraPagesClone) blocks.push(block(THIRD_DB, 'child_database'));
      return childrenList(blocks);
    }
    if (url.pathname === `/v1/databases/${PAGES_DB}`) return databaseResponse(PAGES_DB, pagesProperties());
    if (url.pathname === `/v1/databases/${POSTS_DB}`) return databaseResponse(POSTS_DB, postsProperties());
    if (url.pathname === `/v1/databases/${THIRD_DB}`) return databaseResponse(THIRD_DB, pagesProperties());
    if (url.href === 'https://api.github.com/app/installations/123/access_tokens') {
      return Response.json({ token: SECRETS_INSTALLATION_TOKEN });
    }
    if (url.pathname === '/repos/alice/alice.github.io/actions/secrets/public-key') {
      return Response.json({ key_id: 'synthetic-actions-key-1', key: ACTIONS_PUBLIC_KEY });
    }
    if (request.method === 'PUT' && url.pathname.startsWith('/repos/alice/alice.github.io/actions/secrets/')) {
      return (async () => {
        const body = await request.json() as { encrypted_value: string };
        secretWrites.push({ name: url.pathname.split('/').pop()!, encryptedValue: body.encrypted_value });
        return new Response(null, { status: 204 });
      })();
    }
    throw new Error(`unexpected provider request: ${request.method} ${url.pathname}`);
  });
  journey.calls = calls;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    const begin = await worker.fetch!(
      new Request(`https://staging.example/connect/notion?job_id=${NOTION_JOB_ID}`),
      env as Env,
      FAKE_EXECUTION_CONTEXT as any,
    );
    await addResponse(journey, begin);
    expect(begin.status).toBe(302);
    const location = new URL(begin.headers.get('location')!);
    const cookie = begin.headers.get('set-cookie')!.split(';', 1)[0];
    const callback = await worker.fetch!(
      new Request(
        `https://staging.example/auth/notion/callback?state=${encodeURIComponent(location.searchParams.get('state')!)}&code=${ONE_TIME_CODE}`,
        { headers: { Cookie: cookie } },
      ),
      env as Env,
      FAKE_EXECUTION_CONTEXT as any,
    );
    await addResponse(journey, callback);
  } catch (error) {
    trackError(error);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { ...journey, secretWrites };
}

describe('J1 Notion callback journey', () => {
  test('happy path: the canary token authenticates only Notion calls and is sealed into Actions secrets; retention is 600/3600/86400', async () => {
    const journey = await withCapturedConsole(async (recorder) => {
      const driven = await driveNotionCallback();
      assertJourneyClean(driven, recorder);
      expect(recorder.funnelEventTypes()).toEqual(['consent_started', 'job_queued', 'consent_completed']);
      expect(recorder.reportErrorTexts()).toEqual([]);
      return driven;
    });

    const callback = journey.responses[1];
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe(`https://staging.example/progress?job_id=${NOTION_JOB_ID}`);
    expect(await callback.text()).toBe('');

    // Positive flow: the canary Notion token genuinely authenticated the
    // template-resolution calls, the one-time code genuinely went to the
    // token endpoint, and the secrets write spent its own installation-token
    // mint. The refresh token must reach no Authorization header.
    const exchange = journey.calls.find((call) => call.url === 'https://api.notion.com/v1/oauth/token');
    expect(exchange?.authorization).toMatch(/^Basic /u);
    expect(exchange?.body).toContain(ONE_TIME_CODE);
    const resolutionCalls = journey.calls.filter((call) => call.url.startsWith('https://api.notion.com/v1/databases/'));
    expect(resolutionCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of resolutionCalls) {
      expect(call.authorization).toBe(`Bearer ${NOTION_USER_TOKEN}`);
    }
    expect(journey.calls.some((call) => call.authorization === `Bearer ${NOTION_REFRESH_TOKEN}`)).toBe(false);
    const secretPuts = journey.calls.filter((call) => call.method === 'PUT' && call.url.includes('/actions/secrets/'));
    expect(secretPuts).toHaveLength(3);
    for (const call of secretPuts) {
      expect(call.authorization).toBe(`Bearer ${SECRETS_INSTALLATION_TOKEN}`);
    }
    expect(journey.secretWrites.map((write) => write.name).sort()).toEqual([
      'NOTION_PAGES_DATABASE_ID',
      'NOTION_POSTS_DATABASE_ID',
      'NOTION_TOKEN',
    ]);

    // The handoff happens here: the Notion callback is what enqueues the job.
    expect(journey.queue.sent).toEqual([{ jobId: NOTION_JOB_ID }]);

    // Retention: state pending 600s then consumed 3600s; resolution 86400s;
    // every job write 86400s.
    const stateKeys = journey.kv.keysWithPrefix(NOTION_STATE_PREFIX);
    expect(stateKeys).toHaveLength(1);
    expect(journey.kv.ttlLog(stateKeys[0])).toEqual([600, 3600]);
    expect(journey.kv.ttlLog(`${NOTION_TEMPLATE_RESOLUTION_PREFIX}${NOTION_JOB_ID}`))
      .toEqual([NOTION_TEMPLATE_RESOLUTION_TTL_SECONDS]);
    const jobTtls = journey.kv.ttlLog(provisioningJobKey(NOTION_JOB_ID));
    expect(jobTtls.length).toBeGreaterThanOrEqual(2);
    expect(jobTtls.every((ttl) => ttl === PROVISIONING_JOB_TTL_SECONDS)).toBe(true);
    expect(journey.kv.deletes).toEqual([]);
  });

  test('a provider 400 is a fixed, exact body and the provider response body is never echoed', async () => {
    const journey = await withCapturedConsole(async (recorder) => {
      const driven = await driveNotionCallback({
        tokenEndpoint: () => Response.json(
          { error: 'invalid_grant', access_token: NOTION_USER_TOKEN, workspace_id: WORKSPACE_ID },
          { status: 400 },
        ),
      });
      const callback = driven.responses[1];
      expect(callback.status).toBe(400);
      expect(await callback.text()).toBe('{"error":"notion_authorization_failed"}');
      assertJourneyClean(driven, recorder);
      return driven;
    });
    expect(journey.kv.keysWithPrefix(NOTION_TEMPLATE_RESOLUTION_PREFIX)).toEqual([]);
  });

  test('a raw error from the resolution save hits the 502 fallthrough: exact body, canary field redacted in console', async () => {
    const journey = await withCapturedConsole(async (recorder) => {
      const driven = await driveNotionCallback({
        failResolutionSave: () => {
          const boom: Error & Record<string, unknown> = new Error('synthetic resolution save failed');
          boom.notionAccessToken = NOTION_USER_TOKEN;
          return boom;
        },
      });
      const callback = driven.responses[1];
      expect(callback.status).toBe(502);
      expect(await callback.text()).toBe('{"error":"notion_unavailable"}');
      assertJourneyClean(driven, recorder);
      return driven;
    });
    expect(journey.kv.keysWithPrefix(NOTION_TEMPLATE_RESOLUTION_PREFIX)).toEqual([]);
  });

  test('production error details are merged verbatim and stay canary-free end to end', async () => {
    const journey = await withCapturedConsole(async (recorder) => {
      const driven = await driveNotionCallback({ extraPagesClone: true });
      const callback = driven.responses[1];
      expect(callback.status).toBe(422);
      expect(await callback.json()).toEqual({
        error: 'notion_template_database_ambiguous',
        scanned: 3,
        duplicated_roles: ['pages'],
        ambiguous_databases: 0,
      });
      assertJourneyClean(driven, recorder);
      return driven;
    });
    expect(journey.kv.keysWithPrefix(NOTION_TEMPLATE_RESOLUTION_PREFIX)).toEqual([]);
  });
});

beforeAll(async () => {
  THROWAWAY_PEM = await generateThrowawayPrivateKey();
});

// ---------------------------------------------------------------------------
// J2 — GitHub callback end-to-end through `route()`: user token spent only in
// the synchronous phase, queue message is exactly {jobId}, retention
// 600 -> 3600 for state and 86400 for the job record.
// ---------------------------------------------------------------------------

async function runGithubOnboarding(options: {
  exchangeToken?: () => Response | Error;
  installation?: () => Response;
  generate?: () => Response;
} = {}): Promise<Journey & { env: Partial<Env> }> {
  const kv = new RecordingKV();
  const queue = new RecordingQueue();
  const journey: Journey & { env: Partial<Env> } = { ...emptyJourney(kv, queue), env: await canaryEnv(kv, queue) };

  const exchangeToken = options.exchangeToken ?? (() => Response.json({
    access_token: GITHUB_USER_TOKEN,
    token_type: 'bearer',
  }));
  const installation = options.installation ?? (() => Response.json({
    account: { id: 42, login: 'alice', type: 'User' },
    suspended_at: null,
  }));
  const generate = options.generate ?? (() => Response.json({
    id: 1001,
    name: 'alice.github.io',
    full_name: 'alice/alice.github.io',
    html_url: 'https://github.com/alice/alice.github.io',
    default_branch: 'main',
    fork: false,
    description: 'Notion-powered site published with InkDrafts',
  }, { status: 201 }));

  const trackError = captureThrownErrors(journey);
  const { calls, fetcher } = scriptedFetch((request) => {
    const url = new URL(request.url);
    if (url.href === 'https://github.com/login/oauth/access_token') {
      const result = exchangeToken();
      if (result instanceof Error) throw result;
      return result;
    }
    if (url.href === 'https://api.github.com/user') return Response.json({ id: 42, login: 'alice', type: 'User' });
    if (url.href === 'https://api.github.com/user/installations/123') return installation();
    if (url.href.startsWith('https://api.github.com/user/repos?')) return Response.json([]);
    if (url.href === 'https://api.github.com/repos/inkdrafts/notiongit-template/commits/main') {
      return Response.json({ sha: 'template-head-sha', commit: { tree: { sha: 'template-tree-sha' } } });
    }
    if (url.href === 'https://api.github.com/repos/inkdrafts/notiongit-template/generate') return generate();
    throw new Error(`unexpected provider request: ${request.method} ${url.pathname}`);
  });
  journey.calls = calls;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    const begin = await route(new Request(`https://example.com/connect/github?job_id=${GITHUB_JOB_ID}`), journey.env);
    await addResponse(journey, begin);
    expect(begin.status).toBe(302);
    const installUrl = new URL(begin.headers.get('location')!);
    const callback = await route(
      new Request(
        `https://example.com/auth/github/callback?state=${encodeURIComponent(installUrl.searchParams.get('state')!)}&code=${ONE_TIME_CODE}&installation_id=123&setup_action=install`,
      ),
      journey.env,
    );
    await addResponse(journey, callback);
  } catch (error) {
    trackError(error);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return journey;
}

/**
 * Continues a J2 journey through the Notion phase with the production
 * continuation: template resolution, the sealed Actions-secret writes, and
 * the queue handoff.
 */
async function runNotionOnboarding(
  driven: Journey & { env: Partial<Env> },
): Promise<Journey & { env: Partial<Env> }> {
  const trackError = captureThrownErrors(driven);
  const { calls, fetcher } = scriptedFetch((request) => {
    const url = new URL(request.url);
    if (url.href === 'https://api.notion.com/v1/oauth/token') return notionTokenResponse();
    if (url.pathname === `/v1/blocks/${ROOT_DASHED}/children`) {
      return childrenList([block(PAGES_DB, 'child_database'), block(POSTS_DB, 'child_database')]);
    }
    if (url.pathname === `/v1/databases/${PAGES_DB}`) return databaseResponse(PAGES_DB, pagesProperties());
    if (url.pathname === `/v1/databases/${POSTS_DB}`) return databaseResponse(POSTS_DB, postsProperties());
    if (url.href === 'https://api.github.com/app/installations/123/access_tokens') {
      return Response.json({ token: SECRETS_INSTALLATION_TOKEN });
    }
    if (url.pathname === '/repos/alice/alice.github.io/actions/secrets/public-key') {
      return Response.json({ key_id: 'synthetic-actions-key-1', key: ACTIONS_PUBLIC_KEY });
    }
    if (request.method === 'PUT' && url.pathname.startsWith('/repos/alice/alice.github.io/actions/secrets/')) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected provider request: ${request.method} ${url.pathname}`);
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    const begin = await worker.fetch!(
      new Request(`https://example.com/connect/notion?job_id=${GITHUB_JOB_ID}`),
      driven.env as Env,
      FAKE_EXECUTION_CONTEXT as any,
    );
    await addResponse(driven, begin);
    expect(begin.status).toBe(302);
    const location = new URL(begin.headers.get('location')!);
    const cookie = begin.headers.get('set-cookie')!.split(';', 1)[0];
    const callback = await worker.fetch!(
      new Request(
        `https://example.com/auth/notion/callback?state=${encodeURIComponent(location.searchParams.get('state')!)}&code=${ONE_TIME_CODE}`,
        { headers: { Cookie: cookie } },
      ),
      driven.env as Env,
      FAKE_EXECUTION_CONTEXT as any,
    );
    await addResponse(driven, callback);
  } catch (error) {
    trackError(error);
  } finally {
    globalThis.fetch = originalFetch;
  }
  driven.calls.push(...calls);
  return driven;
}

async function runFullOnboarding(): Promise<Journey & { env: Partial<Env> }> {
  return runNotionOnboarding(await runGithubOnboarding());
}

describe('J2 GitHub callback journey', () => {
  test('happy path: user token spent only on the synchronous calls; the browser is sent on to Notion with nothing queued; retention 600/3600/86400', async () => {
    const journey = await withCapturedConsole(async (recorder) => {
      const driven = await runGithubOnboarding();
      const callback = driven.responses[1];
      expect(callback.status).toBe(302);
      expect(callback.headers.get('location'))
        .toBe(`https://example.com/connect/notion?job_id=${GITHUB_JOB_ID}`);
      assertJourneyClean(driven, recorder);
      recorder.assertSilent();
      return driven;
    });

    // Positive flow: every api.github.com call of the synchronous phase
    // carries the canary user token, and the one-time code went to the
    // exchange endpoint.
    const providerCalls = journey.calls.filter((call) => call.url.startsWith('https://api.github.com/'));
    expect(providerCalls.length).toBeGreaterThanOrEqual(5);
    for (const call of providerCalls) {
      expect(call.authorization).toBe(`Bearer ${GITHUB_USER_TOKEN}`);
    }
    const exchange = journey.calls.find((call) => call.url === 'https://github.com/login/oauth/access_token');
    expect(exchange?.body).toContain(ONE_TIME_CODE);

    // Nothing is queued yet: the Notion callback writes the repository's
    // Actions secrets and only then hands the job to the queue.
    expect(journey.queue.sent).toEqual([]);
    const job = await journey.kv.get<Record<string, any>>(provisioningJobKey(GITHUB_JOB_ID), 'json');
    expect(job?.status).toBe('awaiting_notion');
    expect(job?.data.notionSecretsWrittenAt).toBeNull();

    const stateKeys = journey.kv.keysWithPrefix(GITHUB_STATE_PREFIX);
    expect(stateKeys).toHaveLength(1);
    expect(journey.kv.ttlLog(stateKeys[0])).toEqual([600, 3600]);
    expect(journey.kv.ttlLog(provisioningJobKey(GITHUB_JOB_ID))).toEqual([PROVISIONING_JOB_TTL_SECONDS]);
    expect(journey.kv.deletes).toEqual([]);
  });

  test('a suspended installation fails with the exact 403 body and no diagnostics leave the request', async () => {
    const journey = await withCapturedConsole(async (recorder) => {
      const driven = await runGithubOnboarding({
        installation: () => Response.json({
          account: { id: 42, login: 'alice', type: 'User' },
          suspended_at: '2026-09-02T00:00:00Z',
        }),
      });
      const callback = driven.responses[1];
      expect(callback.status).toBe(403);
      expect(await callback.text()).toBe('{"error":"github_installation_suspended"}');
      assertJourneyClean(driven, recorder);
      recorder.assertSilent();
      return driven;
    });
    expect(journey.kv.keysWithPrefix('github:onboarding-job:')).toEqual([]);
    expect(journey.queue.sent).toEqual([]);
  });

  test('a rate-limited generate is the one error arm allowed a dynamic field', async () => {
    const journey = await withCapturedConsole(async (recorder) => {
      const driven = await runGithubOnboarding({
        generate: () => new Response(null, { status: 403, headers: { 'retry-after': '60' } }),
      });
      const callback = driven.responses[1];
      expect(callback.status).toBe(429);
      expect(await callback.text()).toBe('{"error":"github_generate_rate_limited","retry_after_seconds":60}');
      assertJourneyClean(driven, recorder);
      recorder.assertSilent();
      return driven;
    });
    expect(journey.kv.keysWithPrefix('github:onboarding-job:')).toEqual([]);
    expect(journey.queue.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// J3 — the full seven-step queue pipeline continued from J2's state. Each
// batch mints a fresh unique installation token and every provider call of
// that batch spends exactly that token — never the callback's user token.
// ---------------------------------------------------------------------------

function queuePhaseFetch(): {
  calls: RecordedRequest[];
  fetcher: typeof fetch;
  mintCount: () => number;
} {
  let mints = 0;
  let syncDispatched = false;
  const configYaml = 'title: "NotionGit"\nurl: ""\nbaseurl: ""\n';
  const { calls, fetcher } = scriptedFetch((request) => {
    const url = new URL(request.url);
    if (url.href === 'https://api.github.com/app/installations/123/access_tokens') {
      mints += 1;
      return Response.json({ token: INSTALLATION_TOKENS[mints - 1] });
    }
    if (url.href === 'https://api.github.com/repos/alice/alice.github.io') {
      return Response.json({ id: 1001, full_name: 'alice/alice.github.io', default_branch: 'main', fork: false });
    }
    if (url.href === 'https://api.github.com/repos/alice/alice.github.io/commits/main') {
      return Response.json({ sha: 'generated-head-sha', commit: { tree: { sha: 'generated-tree-sha' } } });
    }
    if (url.href.startsWith('https://api.github.com/repos/alice/alice.github.io/contents/_config.yml')) {
      if (request.method === 'PUT') {
        return Response.json({ content: { sha: 'patched-sha' }, commit: { sha: 'commit-sha' } });
      }
      return Response.json({ type: 'file', encoding: 'base64', content: btoa(configYaml), sha: 'config-sha' });
    }
    if (url.href === 'https://api.github.com/repos/alice/alice.github.io/pages') {
      return Response.json({
        status: 'built',
        url: 'https://api.github.com/repos/alice/alice.github.io/pages',
        html_url: 'https://alice.github.io',
        build_type: 'legacy',
        source: { branch: 'main', path: '/' },
      }, { status: 201 });
    }
    if (url.href.includes('/actions/workflows/sync-notion.yml/runs?')) {
      return Response.json({
        workflow_runs: syncDispatched
          ? [{ id: 555, html_url: 'https://github.com/alice/alice.github.io/actions/runs/555', status: 'completed', conclusion: null, event: 'workflow_dispatch', created_at: new Date().toISOString() }]
          : [],
      });
    }
    if (url.href.endsWith('/actions/workflows/sync-notion.yml/dispatches')) {
      syncDispatched = true;
      return new Response(null, { status: 204 });
    }
    if (url.href === 'https://api.github.com/repos/alice/alice.github.io/actions/runs/555') {
      return Response.json({
        id: 555,
        html_url: 'https://github.com/alice/alice.github.io/actions/runs/555',
        status: 'completed',
        conclusion: 'success',
      });
    }
    if (url.href === 'https://api.github.com/repos/alice/alice.github.io/pages/builds/latest') {
      return Response.json({
        url: 'https://api.github.com/repos/alice/alice.github.io/builds/999',
        status: 'built',
        commit: 'generated-head-sha',
      });
    }
    if (url.origin === 'https://alice.github.io') return new Response('<!doctype html>', { status: 200 });
    throw new Error(`unexpected provider request: ${request.method} ${url.pathname}`);
  });
  return { calls, fetcher, mintCount: () => mints };
}

describe('J3 queue pipeline journey', () => {
  test('seven batches: each step spends its own fresh mint, the user token never reappears, every job write keeps the 24h TTL, zero deletes', async () => {
    const { journey, queueCalls, mintCount, analyticsPoints } = await withCapturedConsole(async (recorder) => {
      const driven = await runFullOnboarding();
      expect(driven.responses[3].status).toBe(303);

      const analyticsPoints: unknown[] = [];
      (driven.env as Record<string, unknown>).PROVISIONING_METRICS = {
        writeDataPoint: (data: unknown) => {
          analyticsPoints.push(data);
        },
      };

      const phase = queuePhaseFetch();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = phase.fetcher;
      try {
        for (let step = 1; step <= 7; step += 1) {
          const from = phase.calls.length;
          const message = fakeMessage({ jobId: GITHUB_JOB_ID });
          await worker.queue!(fakeBatch([message]) as any, driven.env as Env, FAKE_EXECUTION_CONTEXT as any);
          expect(message.acked).toBe(true);
          expect(message.retried).toBeNull();
          const expectedToken = INSTALLATION_TOKENS[step - 1];
          const batchCalls = phase.calls.slice(from);
          expect(batchCalls.length).toBeGreaterThan(0);
          for (const call of batchCalls) {
            if (call.url.startsWith('https://api.github.com/') && !call.url.endsWith('/access_tokens')) {
              expect(call.authorization).toBe(`Bearer ${expectedToken}`);
            }
          }
          if (step === 7) {
            // verify_deploy fetches only the public site URL — with no
            // credential attached at all.
            const siteCalls = batchCalls.filter((call) => call.url.startsWith('https://alice.github.io'));
            expect(siteCalls.length).toBeGreaterThan(0);
            for (const call of siteCalls) expect(call.authorization).toBeNull();
          }
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
      assertJourneyClean(driven, recorder);
      const funnel = recorder.funnelEventTypes();
      expect(funnel.filter((type) => type === 'step_started')).toHaveLength(7);
      expect(funnel.filter((type) => type === 'step_succeeded')).toHaveLength(7);
      expect(funnel.at(-1)).toBe('job_succeeded');
      expect(recorder.reportErrorTexts()).toEqual([]);
      assertClean('analytics data points', JSON.stringify(analyticsPoints));
      return { journey: driven, queueCalls: phase.calls, mintCount: phase.mintCount(), analyticsPoints };
    });

    expect(mintCount).toBe(7);
    expect(queueCalls.every((call) => call.authorization !== `Bearer ${GITHUB_USER_TOKEN}`)).toBe(true);
    expect(journey.queue.sent).toEqual(Array.from({ length: 7 }, () => ({ jobId: GITHUB_JOB_ID })));
    expect(analyticsPoints).toHaveLength(15);

    const jobKey = provisioningJobKey(GITHUB_JOB_ID);
    const job = await journey.kv.get<Record<string, unknown>>(jobKey, 'json');
    expect(job?.status).toBe('succeeded');
    const ttls = journey.kv.ttlLog(jobKey);
    expect(ttls.length).toBeGreaterThanOrEqual(7);
    expect(ttls.every((ttl) => ttl === PROVISIONING_JOB_TTL_SECONDS)).toBe(true);
    // The one designed deletion: the throttle's account lease is released
    // when the job succeeds. No token-hygiene record is ever deleted.
    expect(journey.kv.deletes).toEqual(['github:account-lease:42']);
  });
});

// ---------------------------------------------------------------------------
// J4 — the three reportError funnels under failure injection, plus the queue
// consumer's body-not-read discipline.
// ---------------------------------------------------------------------------

/** Serves only the Notion token exchange, for legs that inject the continuation. */
function notionTokenFetch(): typeof fetch {
  const { fetcher } = scriptedFetch((request) => {
    const url = new URL(request.url);
    if (url.href === 'https://api.notion.com/v1/oauth/token') return notionTokenResponse();
    throw new Error(`unexpected provider request: ${request.method} ${url.pathname}`);
  });
  return fetcher;
}

describe('J4 error funnels', () => {
  test('github_callback_failed: exact 502 body; the canary rides an error field into console only as the redaction marker', async () => {
    const journey = await withCapturedConsole(async (recorder) => {
      const boom: Error & Record<string, unknown> = new Error('synthetic exchange failed');
      boom.accessToken = GITHUB_USER_TOKEN;
      const driven = await runGithubOnboarding({ exchangeToken: () => boom });
      const callback = driven.responses[1];
      expect(callback.status).toBe(502);
      expect(await callback.text()).toBe('{"error":"github_authorization_unavailable"}');
      recorder.assertSingleRecord('github_callback_failed');
      expect(recorder.recordText(0)).toContain('"accessToken":"[redacted]"');
      assertJourneyClean(driven, recorder);
      return driven;
    });
    expect(journey.kv.keysWithPrefix('github:onboarding-job:')).toEqual([]);
  });

  test('notion_callback_failed: exact 502 body; a canary on the thrown error is redacted in console', async () => {
    const kv = new RecordingKV();
    const queue = new RecordingQueue();
    const journey = emptyJourney(kv, queue);
    const env = await canaryEnv(kv, queue);
    await seedAwaitingNotionJob(kv, NOTION_JOB_ID);
    kv.reset();

    await withCapturedConsole(async (recorder) => {
      const begin = await route(new Request(`https://staging.example/connect/notion?job_id=${NOTION_JOB_ID}`), env);
      await addResponse(journey, begin);
      expect(begin.status).toBe(302);
      const location = new URL(begin.headers.get('location')!);
      const cookie = begin.headers.get('set-cookie')!.split(';', 1)[0];
      const boom: Error & Record<string, unknown> = new Error('synthetic continuation failed');
      boom.notionAccessToken = NOTION_USER_TOKEN;
      const callback = await route(
        new Request(
          `https://staging.example/auth/notion/callback?state=${encodeURIComponent(location.searchParams.get('state')!)}&code=${ONE_TIME_CODE}`,
          { headers: { Cookie: cookie } },
        ),
        env,
        { fetcher: notionTokenFetch(), continueOnboarding: () => { throw boom; } },
      );
      await addResponse(journey, callback);
      expect(callback.status).toBe(502);
      expect(await callback.text()).toBe('{"error":"notion_unavailable"}');
      expect(recorder.funnelEventTypes()).toEqual(['consent_started', 'consent_failed']);
      const reports = recorder.reportErrorTexts();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toContain('[notiongit] notion_callback_failed');
      expect(reports[0]).toContain('"notionAccessToken":"[redacted]"');
      assertJourneyClean(journey, recorder);
      return journey;
    });

    const stateKeys = kv.keysWithPrefix(NOTION_STATE_PREFIX);
    expect(kv.ttlLog(stateKeys[0])).toEqual([600, 3600]);
    expect(kv.keysWithPrefix(NOTION_TEMPLATE_RESOLUTION_PREFIX)).toEqual([]);
  });

  test('provisioning_message_failed: an unreadable job record retries the message and reports redacted diagnostics', async () => {
    const kv = new RecordingKV();
    const queue = new RecordingQueue();
    const env = await canaryEnv(kv, queue);
    const brokenJobs = {
      get() { throw new Error('KV outage'); },
      put() { throw new Error('KV outage'); },
    };

    await withCapturedConsole(async (recorder) => {
      const message = fakeMessage({ jobId: GITHUB_JOB_ID });
      await worker.queue!(
        fakeBatch([message]) as any,
        { ...env, JOBS: brokenJobs as unknown as KVNamespace } as Env,
        FAKE_EXECUTION_CONTEXT as any,
      );
      expect(message.acked).toBe(false);
      expect(message.retried).toEqual({});
      recorder.assertSingleRecord('provisioning_message_failed');
      expect(recorder.recordText(0)).toContain('"message":"KV outage"');
      recorder.assertNoCanary();
    });

    expect(kv.writes).toEqual([]);
    expect(queue.sent).toEqual([]);
  });

  test('a malformed message body is acked with zero KV writes and a silent console; a valid unknown jobId is retried the same way', async () => {
    const kv = new RecordingKV();
    const queue = new RecordingQueue();
    const env = await canaryEnv(kv, queue);

    await withCapturedConsole(async (recorder) => {
      const malformed = fakeMessage({ jobId: 'not a valid job id!' } as ProvisioningMessage);
      (malformed.body as Record<string, unknown>).junk = MALFORMED_JUNK;
      await worker.queue!(fakeBatch([malformed]) as any, env as Env, FAKE_EXECUTION_CONTEXT as any);
      expect(malformed.acked).toBe(true);

      const unknownJob = fakeMessage({ jobId: 'x' });
      (unknownJob.body as Record<string, unknown>).junk = MALFORMED_JUNK;
      await worker.queue!(fakeBatch([unknownJob]) as any, env as Env, FAKE_EXECUTION_CONTEXT as any);
      expect(unknownJob.acked).toBe(false);
      expect(unknownJob.retried).toEqual({ delaySeconds: 30 });

      recorder.assertSilent();
    });

    expect(kv.writes).toEqual([]);
    expect(kv.deletes).toEqual([]);
    expect(queue.sent).toEqual([]);
  });

  test('details merged into a response are redacted by key, pinning the one sanctioned dynamic field', async () => {
    const kv = new RecordingKV();
    const queue = new RecordingQueue();
    const journey = emptyJourney(kv, queue);
    const env = await canaryEnv(kv, queue);
    await seedAwaitingNotionJob(kv, NOTION_JOB_ID);
    kv.reset();

    await withCapturedConsole(async (recorder) => {
      const begin = await route(new Request(`https://staging.example/connect/notion?job_id=${NOTION_JOB_ID}`), env);
      await addResponse(journey, begin);
      const location = new URL(begin.headers.get('location')!);
      const cookie = begin.headers.get('set-cookie')!.split(';', 1)[0];
      const callback = await route(
        new Request(
          `https://staging.example/auth/notion/callback?state=${encodeURIComponent(location.searchParams.get('state')!)}&code=${ONE_TIME_CODE}`,
          { headers: { Cookie: cookie } },
        ),
        env,
        {
          fetcher: notionTokenFetch(),
          continueOnboarding: () => {
            throw new NotionOAuthError('notion_template_database_ambiguous', 422, {
              scanned: 2,
              accessToken: NOTION_USER_TOKEN,
            });
          },
        },
      );
      await addResponse(journey, callback);
      expect(callback.status).toBe(422);
      expect(await callback.json()).toEqual({
        error: 'notion_template_database_ambiguous',
        scanned: 2,
        accessToken: REDACTED_MARKER,
      });
      expect(recorder.funnelEventTypes()).toEqual(['consent_started', 'consent_failed']);
      expect(recorder.reportErrorTexts()).toEqual([]);
    });

    expect(kv.keysWithPrefix(NOTION_TEMPLATE_RESOLUTION_PREFIX)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// J5 — expiry/disconnect timeline: an installation-token mint 404 (the
// GitHub-App-uninstall effect) dead-letters the job with a code-only
// lastError, the terminal write refreshes the rolling 24h TTL, and nothing
// is ever deleted.
// ---------------------------------------------------------------------------

describe('J5 disconnect timeline journey', () => {
  test('mint 404 dead-letters with lastError.code only; the terminal save refreshes the 24h TTL; only the lease is released', async () => {
    const journey = await withCapturedConsole(async (recorder) => {
      const driven = await runFullOnboarding();
      expect(driven.responses[3].status).toBe(303);

      const { fetcher } = scriptedFetch(() => new Response(null, { status: 404 }));
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetcher;
      try {
        const message = fakeMessage({ jobId: GITHUB_JOB_ID });
        await worker.queue!(fakeBatch([message]) as any, driven.env as Env, FAKE_EXECUTION_CONTEXT as any);
        expect(message.acked).toBe(true);
        expect(message.retried).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
      assertJourneyClean(driven, recorder);
      expect(recorder.funnelEventTypes()).toEqual([
        'consent_started', 'job_queued', 'consent_completed', 'step_started', 'step_failed', 'job_dead_lettered',
      ]);
      expect(recorder.reportErrorTexts()).toEqual([]);
      return driven;
    });

    const jobKey = provisioningJobKey(GITHUB_JOB_ID);
    const job = await journey.kv.get<Record<string, any>>(jobKey, 'json');
    expect(job?.status).toBe('dead_letter');
    expect(job?.steps.verify_repository.lastError).toEqual({ code: 'github_app_auth_failed', retryable: false });
    expect(job?.completedAt).not.toBeNull();

    const ttls = journey.kv.ttlLog(jobKey);
    expect(ttls.length).toBeGreaterThanOrEqual(3);
    expect(ttls.every((ttl) => ttl === PROVISIONING_JOB_TTL_SECONDS)).toBe(true);
    const stateKeys = journey.kv.keysWithPrefix(GITHUB_STATE_PREFIX);
    expect(journey.kv.ttlLog(stateKeys[0])).toEqual([600, 3600]);
    expect(journey.kv.deletes).toEqual(['github:account-lease:42']);
  });
});

// ---------------------------------------------------------------------------
// Static tripwires. These hold the structural guarantees the journeys cannot
// grep for: one console sink, and no error message built from runtime values.
// ---------------------------------------------------------------------------

const SRC_DIR = join(import.meta.dir, '..', 'src');

function srcFiles(directory: string = SRC_DIR): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    return entry.isDirectory() ? srcFiles(full) : entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('static tripwires', () => {
  test('S1: console.* appears in src/ only in the three sanctioned sinks', () => {
    const offenders = srcFiles()
      .filter((file) => /console\./u.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_DIR, file))
      .sort();
    expect(offenders).toEqual(['observability-alerts.ts', 'observability.ts', 'safe-serialize.ts']);
  });

  test('S2: no error message in src/ is built from interpolation or concatenation', () => {
    const nonLiteralFirstArgument = /new Error\(\s*(?:`|\$\{|[A-Za-z_$])/u;
    const concatenation = /new Error\([^\n]*\+/u;
    const offenders = srcFiles()
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return nonLiteralFirstArgument.test(source) || concatenation.test(source);
      })
      .map((file) => relative(SRC_DIR, file));
    expect(offenders).toEqual([]);
  });
});
