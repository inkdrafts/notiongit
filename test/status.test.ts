import { describe, expect, test } from 'bun:test';

import { signGithubState } from '../src/index';
import type { NotionSyncRunIdentity } from '../src/notion-sync';
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
    const view = projectSiteStatus(okDiscovery(), SESSION);
    expect(view).toEqual({
      kind: 'session',
      viewer: { login: 'alice' },
      site: {
        repository: { name: 'alice.github.io', url: 'https://github.com/alice/alice.github.io' },
        site: { url: 'https://alice.github.io' },
        sync: {
          kind: 'succeeded',
          source: 'conclusion_fallback',
          finishedAtMs: Date.parse(UPDATED_AT),
          runUrl: 'https://github.com/alice/alice.github.io/actions/runs/555',
        },
        deploy: { kind: 'built', commitSha: 'head-sha' },
        refreshAfterSeconds: null,
      },
    });
  });

  test('project sites derive the published URL from the apex policy', () => {
    const view = projectSiteStatus(
      okDiscovery({ repository: { ...REPOSITORY, name: 'alice-inkdrafts', fullName: 'alice/alice-inkdrafts' } }),
      SESSION,
    );
    expect(view).toMatchObject({ kind: 'session', site: { site: { url: 'https://alice.github.io/alice-inkdrafts' } } });
  });

  test('a run still in flight is running and turns on the meta-refresh hint', () => {
    const view = projectSiteStatus(okDiscovery({ syncRun: syncRun({ status: 'in_progress', conclusion: null }) }), SESSION);
    expect(view).toMatchObject({
      kind: 'session',
      site: {
        sync: { kind: 'running', startedAtMs: Date.parse(CREATED_AT) },
        refreshAfterSeconds: 30,
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
            source: 'conclusion_fallback',
            conclusion: conclusion ?? 'unknown',
            finishedAtMs: Date.parse(CREATED_AT),
          },
        },
      });
    }
  });

  test('absence after a successful read renders never_ran and never_built', () => {
    const view = projectSiteStatus(okDiscovery({ syncRun: null, build: null }), SESSION);
    expect(view).toMatchObject({
      kind: 'session',
      site: { sync: { kind: 'never_ran' }, deploy: { kind: 'never_built' }, refreshAfterSeconds: null },
    });
  });

  test('a building or errored latest build renders its own deploy arm', () => {
    expect(projectSiteStatus(okDiscovery({ build: { buildId: 4, status: 'building', commitSha: 'new-sha' } }), SESSION))
      .toMatchObject({ kind: 'session', site: { deploy: { kind: 'building' } } });
    expect(projectSiteStatus(okDiscovery({ build: { buildId: 4, status: 'errored', commitSha: 'new-sha' } }), SESSION))
      .toMatchObject({ kind: 'session', site: { deploy: { kind: 'errored' } } });
  });

  test('every failed discovery maps to its named arm, unavailable keeping the retry hint', () => {
    expect(projectSiteStatus({ ok: false, reason: 'no_site', retryAfterSeconds: null }, SESSION))
      .toEqual({ kind: 'no_site', viewer: { login: 'alice' } });
    expect(projectSiteStatus({ ok: false, reason: 'installation_gone', retryAfterSeconds: null }, SESSION))
      .toEqual({ kind: 'installation_gone', viewer: { login: 'alice' } });
    expect(projectSiteStatus({ ok: false, reason: 'installation_suspended', retryAfterSeconds: null }, SESSION))
      .toEqual({ kind: 'installation_suspended', viewer: { login: 'alice' } });
    expect(projectSiteStatus({ ok: false, reason: 'unavailable', retryAfterSeconds: 90 }, SESSION))
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

  test('the authorize state carries its kind, purpose, and TTL', async () => {
    const payload = statusStatePayload(START_SECONDS);
    expect(payload.exp).toBe(START_SECONDS + STATUS_STATE_TTL_SECONDS);
    expect(payload.purpose).toBe('status');

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
