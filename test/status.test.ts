import { describe, expect, test } from 'bun:test';

import {
  GENERATED_REPOSITORY_DESCRIPTION,
  route,
  signGithubState,
  type Env,
} from '../src/index';
import type { NotionSyncRunIdentity } from '../src/notion-sync';
import { admitProvisioningRequest, provisioningAdmissionConfig } from '../src/provisioning-throttle';
import type { GeneratedRepositoryIdentity } from '../src/repository-generation';
import type { GithubPagesBuildIdentity } from '../src/site-deployment';
import {
  admitStatusRerun,
  isStatusCallbackState,
  parseSafeSummary,
  projectSiteStatus,
  readStatusSession,
  rerunTokenValid,
  signRerunToken,
  signStatusSession,
  signStatusState,
  statusRerunKey,
  statusStatePayload,
  STATUS_RERUN_DAILY_LIMIT,
  STATUS_RERUN_SPACING_SECONDS,
  STATUS_RERUN_WINDOW_SECONDS,
  STATUS_SESSION_COOKIE,
  STATUS_SESSION_TTL_SECONDS,
  STATUS_STATE_COOKIE,
  STATUS_STATE_TTL_SECONDS,
  verifyStatusState,
  type SiteDiscovery,
  type StatusSession,
} from '../src/status';

class MemoryKV {
  private values = new Map<string, string>();
  private ttls = new Map<string, number>();
  puts = 0;

  async get<T>(key: string, type?: string): Promise<T | string | null> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) as T : value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.puts += 1;
    this.values.set(key, value);
    if (options?.expirationTtl !== undefined) this.ttls.set(key, options.expirationTtl);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
    this.ttls.delete(key);
  }

  value(key: string): string | undefined {
    return this.values.get(key);
  }

  ttlFor(key: string): number | undefined {
    return this.ttls.get(key);
  }

  keysWithPrefix(prefix: string): string[] {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }

  entries(): string[] {
    return [...this.values.values()];
  }
}

const ACCOUNT_ID = 42;
const START = 1_700_000_000_000;
const START_SECONDS = Math.floor(START / 1000);

const SECRET = 'status-secret';

/** Live expiry: readStatusSession checks against the real clock. */
const SESSION: StatusSession = {
  v: 1,
  accountId: 42,
  login: 'alice',
  installationId: 123,
  exp: Math.floor(Date.now() / 1000) + 3600,
};

const REPOSITORY: GeneratedRepositoryIdentity = {
  id: 1001,
  fullName: 'alice/alice.github.io',
  name: 'alice.github.io',
  htmlUrl: 'https://github.com/alice/alice.github.io',
  defaultBranch: 'main',
  templateFullName: 'inkdrafts/notiongit-template',
  templateHeadSha: null,
  templateHeadTreeSha: null,
  headSha: null,
  headTreeSha: null,
  reused: true,
};

const CREATED_AT = '2026-09-01T10:00:00Z';
const UPDATED_AT = '2026-09-01T10:05:00Z';
const NOW = Date.parse(CREATED_AT) + 60_000;

function syncRun(overrides: Partial<NotionSyncRunIdentity> = {}): NotionSyncRunIdentity {
  return {
    runId: 555,
    htmlUrl: 'https://github.com/alice/alice.github.io/actions/runs/555',
    status: 'completed',
    conclusion: 'success',
    headSha: 'head-sha',
    createdAtMs: Date.parse(CREATED_AT),
    updatedAtMs: Date.parse(UPDATED_AT),
    ...overrides,
  };
}

const BUILD_BUILT: GithubPagesBuildIdentity = { buildId: 3, status: 'built', commitSha: 'head-sha' };

function okDiscovery(overrides: {
  repository?: GeneratedRepositoryIdentity;
  syncRun?: NotionSyncRunIdentity | null;
  build?: GithubPagesBuildIdentity | null;
} = {}): SiteDiscovery {
  return {
    ok: true,
    accountLogin: 'alice',
    repository: overrides.repository ?? REPOSITORY,
    syncRun: overrides.syncRun === undefined ? syncRun() : overrides.syncRun,
    build: overrides.build === undefined ? BUILD_BUILT : overrides.build,
  };
}

describe('admitStatusRerun', () => {
  test('admits the first rerun and the written slot survives even if no dispatch follows', async () => {
    const kv = new MemoryKV();
    await expect(admitStatusRerun(kv, ACCOUNT_ID, START)).resolves.toEqual({ admitted: true });
    expect(JSON.parse(kv.value(statusRerunKey(ACCOUNT_ID))!)).toEqual({
      version: 1,
      windowStartedAt: START,
      lastRerunAt: START,
      count: 1,
    });
    expect(kv.ttlFor(statusRerunKey(ACCOUNT_ID))).toBe(STATUS_RERUN_WINDOW_SECONDS);
    const crashed = await admitStatusRerun(kv, ACCOUNT_ID, START + 1000);
    expect(crashed).toMatchObject({ admitted: false, reason: 'spacing' });
  });

  test('refuses a rerun inside the spacing floor and says when to return', async () => {
    const kv = new MemoryKV();
    await admitStatusRerun(kv, ACCOUNT_ID, START);
    await expect(admitStatusRerun(kv, ACCOUNT_ID, START + (STATUS_RERUN_SPACING_SECONDS - 60) * 1000))
      .resolves.toEqual({ admitted: false, reason: 'spacing', retryAfterSeconds: 60 });
    await expect(admitStatusRerun(kv, ACCOUNT_ID, START + (STATUS_RERUN_SPACING_SECONDS + 1) * 1000))
      .resolves.toEqual({ admitted: true });
    expect(JSON.parse(kv.value(statusRerunKey(ACCOUNT_ID))!)).toMatchObject({ count: 2, windowStartedAt: START });
  });

  test('refuses reruns beyond the daily cap until the window rolls', async () => {
    const kv = new MemoryKV();
    for (let attempt = 0; attempt < STATUS_RERUN_DAILY_LIMIT; attempt += 1) {
      const decision = await admitStatusRerun(kv, ACCOUNT_ID, START + attempt * 400_000);
      expect(decision).toEqual({ admitted: true });
    }
    const refusedAt = START + STATUS_RERUN_DAILY_LIMIT * 400_000;
    await expect(admitStatusRerun(kv, ACCOUNT_ID, refusedAt)).resolves.toMatchObject({
      admitted: false,
      reason: 'daily_cap',
    });
    const elapsedSeconds = Math.ceil((refusedAt - START) / 1000);
    const refused = await admitStatusRerun(kv, ACCOUNT_ID, refusedAt);
    expect(refused).toMatchObject({ retryAfterSeconds: STATUS_RERUN_WINDOW_SECONDS - elapsedSeconds });
    expect(kv.puts).toBe(STATUS_RERUN_DAILY_LIMIT);
    expect(JSON.parse(kv.value(statusRerunKey(ACCOUNT_ID))!).count).toBe(STATUS_RERUN_DAILY_LIMIT);
  });

  test('a refused rerun writes nothing, so refusals never consume window state', async () => {
    const kv = new MemoryKV();
    await admitStatusRerun(kv, ACCOUNT_ID, START);
    const putsAfterAdmission = kv.puts;
    await admitStatusRerun(kv, ACCOUNT_ID, START + 1000);
    expect(kv.puts).toBe(putsAfterAdmission);
  });

  test('an expired window starts over with a fresh count', async () => {
    const kv = new MemoryKV();
    await admitStatusRerun(kv, ACCOUNT_ID, START);
    const admitted = await admitStatusRerun(kv, ACCOUNT_ID, START + (STATUS_RERUN_WINDOW_SECONDS + 60) * 1000);
    expect(admitted).toEqual({ admitted: true });
    expect(JSON.parse(kv.value(statusRerunKey(ACCOUNT_ID))!)).toEqual({
      version: 1,
      windowStartedAt: START + (STATUS_RERUN_WINDOW_SECONDS + 60) * 1000,
      lastRerunAt: START + (STATUS_RERUN_WINDOW_SECONDS + 60) * 1000,
      count: 1,
    });
  });

  test('a corrupted or unreadable record fails closed', async () => {
    const kv = new MemoryKV();
    await kv.put(statusRerunKey(ACCOUNT_ID), '{"version":1,"windowStartedAt":"x"}', { expirationTtl: 60 });
    await expect(admitStatusRerun(kv, ACCOUNT_ID, START)).resolves.toMatchObject({
      admitted: false,
      reason: 'unavailable',
    });
    expect(kv.puts).toBe(1);

    const outage = new MemoryKV();
    outage.get = async () => {
      throw new Error('KV outage');
    };
    await expect(admitStatusRerun(outage, ACCOUNT_ID, START)).resolves.toMatchObject({
      admitted: false,
      reason: 'unavailable',
    });
  });

  test('accounts never share a window', async () => {
    const kv = new MemoryKV();
    await admitStatusRerun(kv, 42, START);
    await expect(admitStatusRerun(kv, 43, START + 1000)).resolves.toEqual({ admitted: true });
  });
});

describe('projectSiteStatus', () => {
  test('a discovered site renders the session arm with the conclusion-derived result', () => {
    const view = projectSiteStatus(okDiscovery(), SESSION, NOW);
    expect(view).toEqual({
      kind: 'session',
      viewer: { login: 'alice' },
      site: {
        repository: { name: 'alice.github.io', url: 'https://github.com/alice/alice.github.io' },
        site: { url: 'https://alice.github.io' },
        sync: {
          kind: 'succeeded',
          finishedAtMs: Date.parse(UPDATED_AT),
          runUrl: 'https://github.com/alice/alice.github.io/actions/runs/555',
        },
        deploy: { kind: 'built', commitSha: 'head-sha' },
        runInFlight: false,
      },
    });
  });

  test('project sites derive the published URL from the apex policy', () => {
    const view = projectSiteStatus(
      okDiscovery({ repository: { ...REPOSITORY, name: 'alice-inkdrafts', fullName: 'alice/alice-inkdrafts' } }),
      SESSION,
      NOW,
    );
    expect(view).toMatchObject({ kind: 'session', site: { site: { url: 'https://alice.github.io/alice-inkdrafts' } } });
  });

  test('a run still in flight is running and turns on the refresh affordance', () => {
    const view = projectSiteStatus(okDiscovery({ syncRun: syncRun({ status: 'in_progress', conclusion: null }) }), SESSION, NOW);
    expect(view).toMatchObject({
      kind: 'session',
      site: {
        sync: { kind: 'running', startedAtMs: Date.parse(CREATED_AT) },
        runInFlight: true,
      },
    });
  });

  test('any terminal non-success conclusion degrades to failed carrying the raw string', () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'some_new_github_conclusion', null]) {
      const view = projectSiteStatus(
        okDiscovery({ syncRun: syncRun({ conclusion, updatedAtMs: null }) }),
        SESSION,
      );
      expect(view).toMatchObject({
        kind: 'session',
        site: {
          sync: {
            kind: 'failed',
              conclusion: conclusion ?? 'unknown',
            finishedAtMs: Date.parse(CREATED_AT),
          },
        },
      });
    }
  });

  test('absence after a successful read renders never_ran and never_built', () => {
    const view = projectSiteStatus(okDiscovery({ syncRun: null, build: null }), SESSION, NOW);
    expect(view).toMatchObject({
      kind: 'session',
      site: { sync: { kind: 'never_ran' }, deploy: { kind: 'never_built' }, runInFlight: false },
    });
  });

  test('a building or errored latest build renders its own deploy arm', () => {
    expect(projectSiteStatus(okDiscovery({ build: { buildId: 4, status: 'building', commitSha: 'new-sha' } }), SESSION, NOW))
      .toMatchObject({ kind: 'session', site: { deploy: { kind: 'building' } } });
    expect(projectSiteStatus(okDiscovery({ build: { buildId: 4, status: 'errored', commitSha: 'new-sha' } }), SESSION, NOW))
      .toMatchObject({ kind: 'session', site: { deploy: { kind: 'errored' } } });
  });

  test('every failed discovery maps to its named arm, unavailable keeping the retry hint', () => {
    expect(projectSiteStatus({ ok: false, reason: 'no_site', retryAfterSeconds: null }, SESSION, NOW))
      .toEqual({ kind: 'no_site', viewer: { login: 'alice' } });
    expect(projectSiteStatus({ ok: false, reason: 'installation_gone', retryAfterSeconds: null }, SESSION, NOW))
      .toEqual({ kind: 'installation_gone', viewer: { login: 'alice' } });
    expect(projectSiteStatus({ ok: false, reason: 'installation_suspended', retryAfterSeconds: null }, SESSION, NOW))
      .toEqual({ kind: 'installation_suspended', viewer: { login: 'alice' } });
    expect(projectSiteStatus({ ok: false, reason: 'unavailable', retryAfterSeconds: 90 }, SESSION, NOW))
      .toEqual({ kind: 'github_unavailable', retryAfterSeconds: 90 });
  });
});

describe('parseSafeSummary', () => {
  const VALID = JSON.stringify({
    schema_version: 1,
    result: 'success',
    code: 'synced',
    changed: true,
    started_at: CREATED_AT,
    finished_at: UPDATED_AT,
    pages: null,
    posts: null,
    data_files: null,
    detail: 'ok',
  });

  test('a valid v1 summary parses with its result vocabulary', () => {
    expect(parseSafeSummary(VALID)).toEqual({
      ok: true,
      source: 'summary_v1',
      result: 'success',
      code: 'synced',
      finishedAtMs: Date.parse(UPDATED_AT),
    });
  });

  test('a different schema_version is unsupported, not malformed', () => {
    expect(parseSafeSummary(VALID.replace('"schema_version":1', '"schema_version":2')))
      .toEqual({ ok: false, reason: 'unsupported_version' });
  });

  test('non-JSON, non-object, and shape-violating payloads are malformed', () => {
    expect(parseSafeSummary('not json')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseSafeSummary('[1,2]')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseSafeSummary('null')).toEqual({ ok: false, reason: 'malformed' });
    expect(parseSafeSummary(JSON.stringify({ result: 'success' }))).toEqual({ ok: false, reason: 'malformed' });
    expect(parseSafeSummary(JSON.stringify({ schema_version: 1, result: 'unknowable' })))
      .toEqual({ ok: false, reason: 'malformed' });
  });

  test('a new code within v1 is accepted raw, falling back on result alone', () => {
    expect(parseSafeSummary(JSON.stringify({ schema_version: 1, result: 'failure', code: 'brand_new_code' })))
      .toEqual({ ok: true, source: 'summary_v1', result: 'failure', code: 'brand_new_code', finishedAtMs: null });
    expect(parseSafeSummary(JSON.stringify({ schema_version: 1, result: 'no_op' })))
      .toEqual({ ok: true, source: 'summary_v1', result: 'no_op', code: null, finishedAtMs: null });
  });
});

describe('status signing', () => {
  function cookieRequest(cookie: string, url = 'https://example.com/status'): Request {
    return new Request(url, { headers: { Cookie: cookie } });
  }

  test('the session cookie round-trips through readStatusSession', async () => {
    const token = await signStatusSession(SESSION, SECRET);
    const read = await readStatusSession(cookieRequest(`${STATUS_SESSION_COOKIE}=${encodeURIComponent(token)}`), SECRET);
    expect(read).toEqual(SESSION);
    expect(await readStatusSession(new Request('https://example.com/status'), SECRET)).toBeNull();
  });

  test('a tampered, foreign-keyed, or expired session is refused', async () => {
    const token = await signStatusSession(SESSION, SECRET);
    const tampered = `${token.slice(0, -3)}aaa`;
    expect(await readStatusSession(cookieRequest(`${STATUS_SESSION_COOKIE}=${encodeURIComponent(tampered)}`), SECRET))
      .toBeNull();
    expect(await readStatusSession(cookieRequest(`${STATUS_SESSION_COOKIE}=${encodeURIComponent(token)}`), 'other-key'))
      .toBeNull();

    const expired: StatusSession = { ...SESSION, exp: START_SECONDS - 1 };
    const expiredToken = await signStatusSession(expired, SECRET);
    expect(await readStatusSession(cookieRequest(`${STATUS_SESSION_COOKIE}=${encodeURIComponent(expiredToken)}`), SECRET))
      .toBeNull();
  });

  test('the authorize state carries its kind and TTL', async () => {
    const payload = statusStatePayload(START_SECONDS);
    expect(payload.exp).toBe(START_SECONDS + STATUS_STATE_TTL_SECONDS);

    const token = await signStatusState(payload, SECRET);
    expect(await verifyStatusState(token, SECRET, START_SECONDS)).toEqual(payload);
    expect(await isStatusCallbackState(token, SECRET)).toBe(true);

    const late = START_SECONDS + STATUS_STATE_TTL_SECONDS + 1;
    expect(await verifyStatusState(token, SECRET, late)).toBeNull();
    expect(await isStatusCallbackState(token, SECRET)).toBe(true);
    expect(await isStatusCallbackState(token, 'other-key')).toBe(false);
  });

  test('an install-state token can never verify as a status payload', async () => {
    const installToken = await signGithubState(
      { v: 1, jobId: 'job-123', nonce: 'nonce-1', exp: START_SECONDS + 600 },
      SECRET,
    );
    expect(await isStatusCallbackState(installToken, SECRET)).toBe(false);
    expect(await verifyStatusState(installToken, SECRET, START_SECONDS)).toBeNull();
    expect(await readStatusSession(cookieRequest(`${STATUS_SESSION_COOKIE}=${encodeURIComponent(installToken)}`), SECRET))
      .toBeNull();
  });

  test('the rerun token is bound to its own session only', async () => {
    const token = await signRerunToken(SESSION, SECRET);
    expect(await rerunTokenValid(token, SESSION, SECRET, START_SECONDS)).toBe(true);
    expect(await rerunTokenValid(token, { ...SESSION, accountId: 43 }, SECRET, START_SECONDS)).toBe(false);
    expect(await rerunTokenValid(token, { ...SESSION, exp: SESSION.exp + 1 }, SECRET, START_SECONDS)).toBe(false);
    expect(await rerunTokenValid(`${token}x`, SESSION, SECRET, START_SECONDS)).toBe(false);

    const expired: StatusSession = { ...SESSION, exp: START_SECONDS - 1 };
    expect(await rerunTokenValid(await signRerunToken(expired, SECRET), expired, SECRET, START_SECONDS)).toBe(false);
  });
});

// ============================================================================
// Route tests. Every test drives route(new Request(...), env) directly with
// scripted fetch, per house convention.
// ============================================================================

/** Throwaway RSA key so the App-JWT mint never touches real key material. */
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

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
  bodyText: string;
}

type FetchHandler = (request: Request) => Promise<Response> | Response;

async function withScriptedFetch<T>(
  handler: FetchHandler,
  journey: (requests: RecordedRequest[]) => Promise<T>,
): Promise<T> {
  const requests: RecordedRequest[] = [];
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.get('authorization'),
        bodyText: request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text(),
      });
      return handler(request);
    };
    return await journey(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function statusEnv(kv: MemoryKV, overrides: Partial<Record<string, string>> = {}): Partial<Env> {
  return {
    JOBS: kv as unknown as KVNamespace,
    GITHUB_APP_ID: '4798518',
    GITHUB_APP_PRIVATE_KEY: 'not-a-real-key-until-mint',
    GITHUB_CLIENT_ID: 'client-id',
    GITHUB_CLIENT_SECRET: 'client-secret',
    ...overrides,
  };
}

async function statusEnvWithAppKey(kv: MemoryKV, overrides: Partial<Record<string, string>> = {}): Promise<Partial<Env>> {
  return statusEnv(kv, { GITHUB_APP_PRIVATE_KEY: await generateThrowawayPrivateKey(), ...overrides });
}

const VIEWER: StatusSession = {
  v: 1,
  accountId: 42,
  login: 'alice',
  installationId: 987654,
  exp: Math.floor(Date.now() / 1000) + 3600,
};

async function sessionCookie(): Promise<string> {
  return `${STATUS_SESSION_COOKIE}=${encodeURIComponent(await signStatusSession(VIEWER, 'client-secret'))}`;
}

const GENERATED_REPOSITORY = {
  id: 1001,
  name: 'alice.github.io',
  full_name: 'alice/alice.github.io',
  html_url: 'https://github.com/alice/alice.github.io',
  default_branch: 'main',
  description: GENERATED_REPOSITORY_DESCRIPTION,
  fork: false,
};

const COMPLETED_RUN = {
  id: 555,
  html_url: 'https://github.com/alice/alice.github.io/actions/runs/555',
  status: 'completed',
  conclusion: 'success',
  head_sha: 'head-sha',
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-01T10:05:00Z',
  event: 'workflow_dispatch',
};

/** An in-flight run young enough that waiting is still the right answer. */
function inFlightRun(): Record<string, unknown> {
  return {
    ...COMPLETED_RUN,
    status: 'in_progress',
    conclusion: null,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/** The discovery + dispatch routes of one healthy site. */
function healthySiteHandler(request: Request): Response {
  const url = request.url;
  if (request.method === 'GET' && url === 'https://api.github.com/app/installations/987654') {
    return Response.json({
      account: { id: 42, login: 'alice', type: 'User' },
      suspended_at: null,
      suspended_by: null,
    });
  }
  if (request.method === 'POST' && url === 'https://api.github.com/app/installations/987654/access_tokens') {
    return Response.json({ token: 'installation-token' });
  }
  if (request.method === 'GET' && url.startsWith('https://api.github.com/installation/repositories')) {
    return Response.json({ total_count: 1, repositories: [GENERATED_REPOSITORY] });
  }
  if (request.method === 'GET' && url.includes('/actions/workflows/sync-notion.yml/runs')) {
    return Response.json({ workflow_runs: [COMPLETED_RUN] });
  }
  if (request.method === 'GET' && url.includes('/pages/builds/latest')) {
    return Response.json({ url: 'https://api.github.com/repos/alice/alice.github.io/pages/builds/3', status: 'built', commit: 'head-sha' });
  }
  if (request.method === 'POST' && url.includes('/actions/workflows/sync-notion.yml/dispatches')) {
    return new Response(null, { status: 204 });
  }
  return Response.json({ message: 'unexpected provider request' }, { status: 500 });
}

function setCookieValues(response: Response): string[] {
  return response.headers.getSetCookie();
}

describe('status routes', () => {
  test('GET /status without a session renders the entry page with zero side effects', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv);
    await withScriptedFetch(() => {
      throw new Error('no provider request expected');
    }, async (requests) => {
      const response = await route(new Request('https://example.com/status'), env);
      expect(response.status).toBe(200);
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(await response.text()).toContain('Sign in with GitHub');
      expect(kv.puts).toBe(0);
      expect(requests).toEqual([]);
    });
  });

  test('?connect=1 redirects into the authorize leg and sets the double-submit state cookie', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv);
    const response = await route(new Request('https://example.com/status?connect=1'), env);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe('https://github.com');
    expect(location.pathname).toBe('/login/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe('client-id');
    expect(location.searchParams.get('redirect_uri')).toBe('https://example.com/auth/github/callback');

    const cookies = setCookieValues(response);
    const stateCookieHeader = cookies.find((cookie) => cookie.startsWith(`${STATUS_STATE_COOKIE}=`))!;
    expect(stateCookieHeader).toContain('Max-Age=600');
    expect(stateCookieHeader).toContain('HttpOnly');
    expect(stateCookieHeader).toContain('Secure');
    expect(stateCookieHeader).toContain('SameSite=Lax');
    expect(stateCookieHeader).toContain('Path=/');

    const nonce = decodeURIComponent(stateCookieHeader.split('=')[1].split(';')[0]);
    const payload = await verifyStatusState(location.searchParams.get('state')!, 'client-secret', Math.floor(Date.now() / 1000));
    expect(payload).toMatchObject({ v: 1, nonce });
    expect(kv.puts).toBe(0);
  });

  test('the status callback proves identity fresh, sets only the session cookie, and persists nothing', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv);
    const payload = statusStatePayload(Math.floor(Date.now() / 1000));
    const state = await signStatusState(payload, 'client-secret');

    await withScriptedFetch((request) => {
      if (request.method === 'POST' && request.url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'user-token', token_type: 'bearer' });
      }
      if (request.url === 'https://api.github.com/user') {
        return Response.json({ id: 42, login: 'alice', type: 'User' });
      }
      if (request.url === 'https://api.github.com/user/installations') {
        return Response.json({ installations: [{ id: 987654, app_id: '4798518' }] });
      }
      throw new Error(`unexpected provider request: ${request.method} ${request.url}`);
    }, async (requests) => {
      const response = await route(
        new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(state)}&code=one-time-code`, {
          headers: { Cookie: `${STATUS_STATE_COOKIE}=${payload.nonce}` },
        }),
        env,
      );
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('https://example.com/status');

      const cookies = setCookieValues(response);
      const session = cookies.find((cookie) => cookie.startsWith(`${STATUS_SESSION_COOKIE}=`))!;
      expect(session).toContain(`Max-Age=${STATUS_SESSION_TTL_SECONDS}`);
      expect(cookies.some((cookie) => cookie.startsWith(`${STATUS_STATE_COOKIE}=;`) && cookie.includes('Max-Age=0'))).toBe(true);

      const token = decodeURIComponent(session.split('=')[1].split(';')[0]);
      const proved = await readStatusSession(
        new Request('https://example.com/status', { headers: { Cookie: `${STATUS_SESSION_COOKIE}=${token}` } }),
        'client-secret',
      );
      expect(proved).toEqual({ v: 1, accountId: 42, login: 'alice', installationId: 987654, exp: proved!.exp });

      expect(kv.puts).toBe(0);
      expect(kv.entries()).toEqual([]);
      const persistedSurface = JSON.stringify({ kv: kv.entries(), cookies });
      expect(persistedSurface).not.toContain('user-token');
      expect(persistedSurface).not.toContain('one-time-code');
      const unwrapped = requests.filter((request) => request.authorization === 'Bearer user-token');
      expect(unwrapped.length).toBeGreaterThanOrEqual(2);
    });
  });

  test('a session cannot ride a foreign installation: discovery re-proofs the account', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv);
    const forged: StatusSession = { ...VIEWER, accountId: 999 };
    const cookie = `${STATUS_SESSION_COOKIE}=${encodeURIComponent(await signStatusSession(forged, 'client-secret'))}`;

    await withScriptedFetch((request) => {
      if (request.method === 'GET' && request.url === 'https://api.github.com/app/installations/987654') {
        return Response.json({
          account: { id: 42, login: 'alice', type: 'User' },
          suspended_at: null,
          suspended_by: null,
        });
      }
      throw new Error(`unexpected provider request: ${request.method} ${request.url}`);
    }, async (requests) => {
      const response = await route(
        new Request('https://example.com/status', { headers: { Cookie: cookie } }),
        env,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('InkDrafts no longer has access');
      expect(requests).toHaveLength(1);
    });
  });

  test('a login renamed after sign-in renders with the fresh account login instead of denying the owner', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv);
    const renamed: StatusSession = { ...VIEWER, login: 'bob' };
    const cookie = `${STATUS_SESSION_COOKIE}=${encodeURIComponent(await signStatusSession(renamed, 'client-secret'))}`;

    await withScriptedFetch(healthySiteHandler, async () => {
      const response = await route(
        new Request('https://example.com/status', { headers: { Cookie: cookie } }),
        env,
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('Signed in as alice');
      expect(html).not.toContain('bob');
    });
  });

  test('the callback prefers the installation owned by the signed-in account over an organization listing', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv);
    const payload = statusStatePayload(Math.floor(Date.now() / 1000));
    const state = await signStatusState(payload, 'client-secret');

    await withScriptedFetch((request) => {
      if (request.method === 'POST' && request.url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'user-token', token_type: 'bearer' });
      }
      if (request.url === 'https://api.github.com/user') {
        return Response.json({ id: 42, login: 'alice', type: 'User' });
      }
      if (request.url === 'https://api.github.com/user/installations') {
        return Response.json({
          installations: [
            { id: 111, app_id: '4798518', account: { id: 9001 } },
            { id: 987654, app_id: '4798518', account: { id: 42 } },
          ],
        });
      }
      throw new Error(`unexpected provider request: ${request.method} ${request.url}`);
    }, async () => {
      const response = await route(
        new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(state)}&code=one-time-code`, {
          headers: { Cookie: `${STATUS_STATE_COOKIE}=${payload.nonce}` },
        }),
        env,
      );
      expect(response.status).toBe(303);
      const cookies = setCookieValues(response);
      const session = cookies.find((cookie) => cookie.startsWith(`${STATUS_SESSION_COOKIE}=`))!;
      const token = decodeURIComponent(session.split('=')[1].split(';')[0]);
      const proved = await readStatusSession(
        new Request('https://example.com/status', { headers: { Cookie: `${STATUS_SESSION_COOKIE}=${token}` } }),
        'client-secret',
      );
      expect(proved).toMatchObject({ accountId: 42, installationId: 987654 });
    });
  });

  test('callback failure modes render the auth_failed page and clear the state cookie', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv);
    const payload = statusStatePayload(Math.floor(Date.now() / 1000));
    const state = await signStatusState(payload, 'client-secret');
    const stateCookieHeader = `${STATUS_STATE_COOKIE}=${payload.nonce}`;

    const deniedState = await signStatusState(statusStatePayload(Math.floor(Date.now() / 1000)), 'client-secret');
    const denied = await route(
      new Request(`https://example.com/auth/github/callback?error=access_denied&error_description=nope&state=${encodeURIComponent(deniedState)}`),
      env,
    );
    expect(denied.status).toBe(400);
    expect(await denied.text()).toContain('Sign-in did not complete');
    expect(setCookieValues(denied).some((cookie) => cookie.startsWith(`${STATUS_STATE_COOKIE}=;`))).toBe(true);

    const validState = `https://example.com/auth/github/callback?state=${encodeURIComponent(state)}&code=code`;
    expect((await route(new Request('https://example.com/auth/github/callback'), env)).status).toBe(400);
    expect((await route(
      new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(state)}`),
      env,
    )).status).toBe(400);
    const noCookie = await route(new Request(validState), env);
    expect(noCookie.status).toBe(400);
    expect(await noCookie.text()).toContain('Sign-in did not complete');

    await withScriptedFetch((request) => {
      if (request.method === 'POST' && request.url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ error: 'bad_verification_code' }, { status: 400 });
      }
      throw new Error(`unexpected provider request: ${request.method} ${request.url}`);
    }, async (requests) => {
      const refused = await route(
        new Request(validState, { headers: { Cookie: stateCookieHeader } }),
        env,
      );
      expect(refused.status).toBe(400);
      expect(requests).toHaveLength(1);
    });

    await withScriptedFetch(() => new Response(null, { status: 500 }), async () => {
      const unavailable = await route(
        new Request(validState, { headers: { Cookie: stateCookieHeader } }),
        env,
      );
      expect(unavailable.status).toBe(502);
      expect(await unavailable.text()).toContain('GitHub is not answering');
    });
    expect(kv.puts).toBe(0);
  });

  test('the kind dispatch routes each leg to its own finisher', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv);

    const statusToken = await signStatusState(statusStatePayload(Math.floor(Date.now() / 1000)), 'client-secret');
    const statusLeg = await route(
      new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(statusToken)}&code=code`),
      env,
    );
    expect(statusLeg.status).toBe(400);
    expect(await statusLeg.text()).toContain('Sign-in did not complete');

    const foreign = await signStatusState(statusStatePayload(Math.floor(Date.now() / 1000)), 'other-key');
    const installLeg = await route(
      new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(foreign)}&code=code`),
      env,
    );
    expect(installLeg.status).toBe(400);
    expect(await installLeg.text()).toContain('Error code: <code>github_state_invalid</code>');
  });

  test('the rerun gates refuse in order: origin, session, form token', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv);
    const token = await signRerunToken(VIEWER, 'client-secret');
    const form = new URLSearchParams({ token });

    const crossOrigin = await route(
      new Request('https://example.com/status/rerun', {
        method: 'POST',
        headers: { Origin: 'https://evil.example', Cookie: await sessionCookie() },
        body: form,
      }),
      env,
    );
    expect(crossOrigin.status).toBe(403);
    expect(kv.puts).toBe(0);

    const signedOut = await route(
      new Request('https://example.com/status/rerun', { method: 'POST', body: form }),
      env,
    );
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get('location')).toBe('https://example.com/status?notice=signin_required');

    const badToken = await route(
      new Request('https://example.com/status/rerun', {
        method: 'POST',
        headers: { Cookie: await sessionCookie() },
        body: new URLSearchParams({ token: 'forged' }),
      }),
      env,
    );
    expect(badToken.status).toBe(403);
    expect(kv.puts).toBe(0);
  });

  test('a healthy rerun dispatches with bulk delete pinned off and consumes the window first', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv);
    const token = await signRerunToken(VIEWER, 'client-secret');

    await withScriptedFetch(healthySiteHandler, async (requests) => {
      const response = await route(
        new Request('https://example.com/status/rerun', {
          method: 'POST',
          headers: { Origin: 'https://example.com', Cookie: await sessionCookie() },
          body: new URLSearchParams({ token }),
        }),
        env,
      );
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('https://example.com/status?notice=sync_triggered');

      const dispatch = requests.find((request) => request.url.includes('/dispatches'));
      expect(dispatch).toBeDefined();
      expect(dispatch!.method).toBe('POST');
      expect(dispatch!.authorization).toBe('Bearer installation-token');
      expect(JSON.parse(dispatch!.bodyText)).toEqual({ ref: 'main', inputs: { allow_bulk_delete: 'false' } });

      const window = JSON.parse(kv.value(statusRerunKey(42))!);
      expect(window).toMatchObject({ version: 1, count: 1 });
      expect(kv.keysWithPrefix('provisioning:admission:burst:')).toHaveLength(1);
      expect(kv.value('github:rate:global')).toBeDefined();
    });
  });

  test('a live run converges the rerun to already_running without consuming the window', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv);
    const token = await signRerunToken(VIEWER, 'client-secret');

    await withScriptedFetch((request) => {
      if (request.url.includes('/actions/workflows/sync-notion.yml/runs')) {
        return Response.json({ workflow_runs: [inFlightRun()] });
      }
      return healthySiteHandler(request);
    }, async (requests) => {
      const response = await route(
        new Request('https://example.com/status/rerun', {
          method: 'POST',
          headers: { Origin: 'https://example.com', Cookie: await sessionCookie() },
          body: new URLSearchParams({ token }),
        }),
        env,
      );
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('https://example.com/status?notice=already_running');
      expect(kv.value(statusRerunKey(42))).toBeUndefined();
      expect(requests.find((request) => request.url.includes('/dispatches'))).toBeUndefined();
    });
  });

  test('a discovery failure on rerun renders the reason page without gating further', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv);
    const token = await signRerunToken(VIEWER, 'client-secret');

    await withScriptedFetch((request) => {
      if (request.url.startsWith('https://api.github.com/installation/repositories')) {
        return Response.json({ total_count: 0, repositories: [] });
      }
      return healthySiteHandler(request);
    }, async (requests) => {
      const response = await route(
        new Request('https://example.com/status/rerun', {
          method: 'POST',
          headers: { Origin: 'https://example.com', Cookie: await sessionCookie() },
          body: new URLSearchParams({ token }),
        }),
        env,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('We could not find an InkDrafts site');
      expect(kv.value(statusRerunKey(42))).toBeUndefined();
      expect(requests.find((request) => request.url.includes('/dispatches'))).toBeUndefined();
    });
  });

  test('the IP burst window refuses an over-eager rerun with 429 and Retry-After', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv);
    const token = await signRerunToken(VIEWER, 'client-secret');
    const config = provisioningAdmissionConfig(env);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const admission = await admitProvisioningRequest(env as Env, config, {
        request: new Request('https://example.com/status/rerun', { method: 'POST' }),
        jobId: `filler-${attempt}`,
        hmacSecret: 'client-secret',
      }, Date.now(), 'status_rerun');
      expect(admission.action).toBe('allow');
    }

    await withScriptedFetch(healthySiteHandler, async (requests) => {
      const response = await route(
        new Request('https://example.com/status/rerun', {
          method: 'POST',
          headers: { Origin: 'https://example.com', Cookie: await sessionCookie() },
          body: new URLSearchParams({ token }),
        }),
        env,
      );
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBeTruthy();
      expect(requests.find((request) => request.url.includes('/dispatches'))).toBeUndefined();
    });
  });

  test('a paused admission stage refuses the rerun with 503', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv, { PROVISIONING_CONTROL_MODE: 'pause' });
    const token = await signRerunToken(VIEWER, 'client-secret');
    const response = await route(
      new Request('https://example.com/status/rerun', {
        method: 'POST',
        headers: { Origin: 'https://example.com', Cookie: await sessionCookie() },
        body: new URLSearchParams({ token }),
      }),
      env,
    );
    expect(response.status).toBe(503);
  });

  test('the per-account window and the global budget each refuse with their retry seconds', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv);
    const token = await signRerunToken(VIEWER, 'client-secret');
    const rerunRequest = async () => new Request('https://example.com/status/rerun', {
      method: 'POST',
      headers: { Origin: 'https://example.com', Cookie: await sessionCookie() },
      body: new URLSearchParams({ token }),
    });

    const nowMs = Date.now();
    await kv.put(statusRerunKey(42), JSON.stringify({
      version: 1, windowStartedAt: nowMs, lastRerunAt: nowMs, count: STATUS_RERUN_DAILY_LIMIT,
    }), { expirationTtl: 60 });
    await withScriptedFetch(healthySiteHandler, async (requests) => {
      const capped = await route(await rerunRequest(), env);
      expect(capped.status).toBe(429);
      expect(capped.headers.get('retry-after')).toBeTruthy();
      expect(requests.find((request) => request.url.includes('/dispatches'))).toBeUndefined();
    });

    await kv.delete(statusRerunKey(42));
    await kv.put('github:rate:global', JSON.stringify({
      version: 1,
      minuteBucket: Math.floor(Date.now() / 60_000),
      minuteCount: 30,
      hourBucket: Math.floor(Date.now() / 3_600_000),
      hourCount: 240,
    }), { expirationTtl: 7200 });
    await withScriptedFetch(healthySiteHandler, async (requests) => {
      const throttled = await route(await rerunRequest(), env);
      expect(throttled.status).toBe(429);
      expect(throttled.headers.get('retry-after')).toBeTruthy();
      expect(requests.find((request) => request.url.includes('/dispatches'))).toBeUndefined();
    });
  });

  test('a global-budget refusal does not spend one of the account\u2019s daily slots', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv);
    const token = await signRerunToken(VIEWER, 'client-secret');
    await kv.put('github:rate:global', JSON.stringify({
      version: 1,
      minuteBucket: Math.floor(Date.now() / 60_000),
      minuteCount: 30,
      hourBucket: Math.floor(Date.now() / 3_600_000),
      hourCount: 240,
    }), { expirationTtl: 7200 });
    await withScriptedFetch(healthySiteHandler, async () => {
      const response = await route(new Request('https://example.com/status/rerun', {
        method: 'POST',
        headers: { Origin: 'https://example.com', Cookie: await sessionCookie() },
        body: new URLSearchParams({ token }),
      }), env);
      expect(response.status).toBe(429);
      expect(kv.value(statusRerunKey(42))).toBeUndefined();
    });
  });

  test('an unreadable rerun window refuses with honest copy and 503 instead of a quota lie', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv);
    const token = await signRerunToken(VIEWER, 'client-secret');
    await kv.put(statusRerunKey(42), '{"version":1,"windowStartedAt":"x"}', { expirationTtl: 60 });
    await withScriptedFetch(healthySiteHandler, async (requests) => {
      const response = await route(new Request('https://example.com/status/rerun', {
        method: 'POST',
        headers: { Origin: 'https://example.com', Cookie: await sessionCookie() },
        body: new URLSearchParams({ token }),
      }), env);
      expect(response.status).toBe(503);
      expect(await response.text()).toContain('could not check your sync limit');
      expect(requests.find((request) => request.url.includes('/dispatches'))).toBeUndefined();
    });
  });

  test('a run stuck non-completed past an hour stops gating the rerun and stops auto-refresh', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv);
    const token = await signRerunToken(VIEWER, 'client-secret');
    const cookie = await sessionCookie();

    await withScriptedFetch(healthySiteHandler, async () => {
      const response = await route(new Request('https://example.com/status/rerun', {
        method: 'POST',
        headers: { Origin: 'https://example.com', Cookie: cookie },
        body: new URLSearchParams({ token }),
      }), env);
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('https://example.com/status?notice=sync_triggered');
      expect(kv.value(statusRerunKey(42))).toBeTruthy();
    });

    await withScriptedFetch((request) => {
      if (request.url.includes('/actions/workflows/sync-notion.yml/runs')) {
        return Response.json({ workflow_runs: [{ ...COMPLETED_RUN, status: 'in_progress', conclusion: null }] });
      }
      return healthySiteHandler(request);
    }, async () => {
      const page = await route(new Request('https://example.com/status', { headers: { Cookie: cookie } }), env);
      const html = await page.text();
      expect(html).toContain('A sync is running right now');
      expect(html).not.toContain('http-equiv="refresh"');
      expect(html).not.toContain('>Refresh</a>');
    });
  });

  test('provider-provided strings are escaped on their way into the page', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv);
    const cookie = await sessionCookie();
    const hostile = '<img src=x onerror=alert(1)>';

    await withScriptedFetch((request) => {
      if (request.method === 'GET' && request.url === 'https://api.github.com/app/installations/987654') {
        return Response.json({
          account: { id: 42, login: hostile, type: 'User' },
          suspended_at: null,
          suspended_by: null,
        });
      }
      return healthySiteHandler(request);
    }, async () => {
      const response = await route(new Request('https://example.com/status', { headers: { Cookie: cookie } }), env);
      const html = await response.text();
      expect(html).toContain('&lt;img src=x');
      expect(html).not.toContain('<img src=x');
    });
  });

  test('GET /status with a session renders the derived page, leaks nothing, and refreshes only while running', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv);
    const cookie = await sessionCookie();

    await withScriptedFetch(healthySiteHandler, async (requests) => {
      const settled = await route(
        new Request('https://example.com/status', { headers: { Cookie: cookie } }),
        env,
      );
      expect(settled.status).toBe(200);
      expect(settled.headers.get('referrer-policy')).toBe('no-referrer');
      const html = await settled.text();
      expect(html).toContain('Your site');
      expect(html).toContain('alice');
      expect(html).toContain('https://alice.github.io');
      expect(html).toContain('Derived from the workflow run result');
      expect(html).not.toContain('http-equiv="refresh"');
      expect(html).not.toContain('987654');
      expect(html).not.toContain('installation-token');
      expect(kv.puts).toBe(0);
      expect(requests.length).toBeGreaterThan(0);
    });

    await withScriptedFetch((request) => {
      if (request.url.includes('/actions/workflows/sync-notion.yml/runs')) {
        return Response.json({ workflow_runs: [inFlightRun()] });
      }
      return healthySiteHandler(request);
    }, async () => {
      const running = await route(
        new Request('https://example.com/status', { headers: { Cookie: cookie } }),
        env,
      );
      expect(running.status).toBe(200);
      const html = await running.text();
      expect(html).toContain('>Refresh</a>');
      expect(html).not.toContain('http-equiv="refresh"');
    });
  });

  test('a degraded discovery renders its own page without inventing failure detail', async () => {
    const kv = new MemoryKV();
    const env = await statusEnvWithAppKey(kv);
    const cookie = await sessionCookie();

    await withScriptedFetch((request) => {
      if (request.method === 'GET' && request.url === 'https://api.github.com/app/installations/987654') {
        return Response.json({
          account: { id: 42, login: 'alice', type: 'User' },
          suspended_at: new Date().toISOString(),
          suspended_by: 'github',
        });
      }
      throw new Error(`unexpected provider request: ${request.method} ${request.url}`);
    }, async () => {
      const response = await route(
        new Request('https://example.com/status', { headers: { Cookie: cookie } }),
        env,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('suspended');
    });

    await withScriptedFetch(() => new Response(null, { status: 500 }), async () => {
      const unavailable = await route(
        new Request('https://example.com/status', { headers: { Cookie: cookie } }),
        env,
      );
      expect(unavailable.status).toBe(200);
      expect(await unavailable.text()).toContain('GitHub is not answering');
    });
  });
});
