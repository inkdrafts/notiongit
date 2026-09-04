import { describe, expect, test } from 'bun:test';
import sodium from 'libsodium-wrappers';

import {
  accountLeaseKey,
  continueNotionOnboarding,
  createProvisioningJob,
  createRepositoryWithRetry,
  GENERATED_REPOSITORY_DESCRIPTION,
  GithubRepositoryNameCollisionError,
  GLOBAL_RATE_KEY,
  isValidGithubRepositoryName,
  loadNotionTemplateResolution,
  NotionOAuthError,
  PROVISIONING_STEP_ORDER,
  route,
  saveProvisioningJob,
  selectGithubRepositoryDestination,
  selectRepositoryDestination,
  type Env,
  type GlobalRateState,
  type ProvisioningJob,
  type ProvisioningMessage,
} from '../src/index';
import worker from '../src/index';
import { Secret } from '../src/secret';

interface MockSequenceEntry {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface GenerationMockOptions {
  /** First page of owned repositories; defaults to none. */
  owned?: unknown[];
  /** Responses for POST /repos/inkdrafts/notiongit-template/generate in order. */
  generate?: MockSequenceEntry[];
  /** Responses for the user-token read of a colliding repository. */
  colliding?: MockSequenceEntry[];
}

function mockResponse(entry: MockSequenceEntry): Response {
  return new Response(JSON.stringify(entry.body ?? {}), {
    status: entry.status,
    headers: { 'content-type': 'application/json', ...(entry.headers ?? {}) },
  });
}


function generatedRepositoryBody(name: string): Record<string, unknown> {
  return {
    id: 1001,
    name,
    full_name: `alice/${name}`,
    html_url: `https://github.com/alice/${name}`,
    default_branch: 'main',
    fork: false,
    description: GENERATED_REPOSITORY_DESCRIPTION,
  };
}

/**
 * Drive `GET /auth/github/callback` through the synchronous OAuth-on-install
 * prefix — state, code exchange, identity, and repository generation — with
 * scripted generation-phase responses. Everything after generation runs in
 * the provisioning queue (see the "provisioning queue" describe block below),
 * not inside this request. Returns every outbound request as
 * `{method, url, authorization}` plus the parsed generate-call bodies.
 */
async function runProvisioningCallback(options: GenerationMockOptions = {}) {
  const kv = new MemoryKV();
  const queue = new MemoryQueue<ProvisioningMessage>();
  const env = await githubEnv(kv, queue);
  const { state } = await getInstallState(env);
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; url: string; authorization: string | null }> = [];
  const generateNames: string[] = [];
  const next = (sequence: MockSequenceEntry[] | undefined, fallback: () => MockSequenceEntry): MockSequenceEntry =>
    sequence && sequence.length > 0 ? sequence.shift()! : fallback();

  try {
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const authorization = request.headers.get('authorization');
      requests.push({ method: request.method, url: request.url, authorization });
      if (request.url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'user-token', token_type: 'bearer' });
      }
      if (request.url === 'https://api.github.com/user') {
        return Response.json({ id: 42, login: 'alice', type: 'User' });
      }
      if (request.url === 'https://api.github.com/user/installations/123') {
        return Response.json({ account: { id: 42, login: 'alice', type: 'User' }, suspended_at: null });
      }
      if (request.url.startsWith('https://api.github.com/user/repos?')) {
        return Response.json(options.owned ?? []);
      }
      if (request.url === 'https://api.github.com/repos/inkdrafts/notiongit-template/commits/main') {
        return Response.json({ sha: 'template-head-sha', commit: { tree: { sha: 'template-tree-sha' } } });
      }
      if (request.url === 'https://api.github.com/repos/inkdrafts/notiongit-template/generate') {
        const body = await request.json() as { name: string };
        generateNames.push(body.name);
        const entry = next(options.generate, () => ({ status: 201 }));
        return mockResponse(entry.body !== undefined || entry.status !== 201
          ? entry
          : { ...entry, body: generatedRepositoryBody(body.name) });
      }
      const repositoryMatch = request.url.match(/^https:\/\/api\.github\.com\/repos\/alice\/[^/]+$/u);
      if (repositoryMatch && authorization === 'Bearer user-token') {
        return mockResponse(next(options.colliding, () => ({ status: 404 })));
      }
      throw new Error(`unexpected URL: ${request.url}`);
    };

    const response = await route(
      new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(state)}&code=one-time-code&installation_id=123&setup_action=install`),
      env,
    );
    return { response, requests, generateNames, kv, queue };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

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

  entries(): string[] {
    return [...this.values.values()];
  }

  ttlFor(key: string): number | undefined {
    return this.ttls.get(key);
  }
}

/** Captures every message sent to the provisioning queue, in order. */
class MemoryQueue<T> {
  readonly sent: T[] = [];
  failSends = false;

  async send(message: T): Promise<void> {
    if (this.failSends) throw new Error('queue unavailable');
    this.sent.push(message);
  }

  async sendBatch(): Promise<void> {
    throw new Error('MemoryQueue.sendBatch is not used by this project');
  }
}

/**
 * The callback mints an installation token to verify the generated repository,
 * which signs an App JWT with the configured private key. Tests use a cached
 * throwaway RSA key so no real key material is ever involved.
 */
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

async function githubEnv(
  kv = new MemoryKV(),
  queue = new MemoryQueue<ProvisioningMessage>(),
): Promise<Partial<Env>> {
  return {
    JOBS: kv as unknown as KVNamespace,
    PROVISIONING_QUEUE: queue as unknown as Queue<ProvisioningMessage>,
    GITHUB_APP_ID: '4798518',
    GITHUB_APP_SLUG: 'inkdrafts',
    GITHUB_APP_PRIVATE_KEY: await generateThrowawayPrivateKey(),
    GITHUB_CLIENT_ID: 'client-id',
    GITHUB_CLIENT_SECRET: 'client-secret',
    NOTION_CLIENT_ID: 'notion-client-id',
    NOTION_CLIENT_SECRET: 'notion-client-secret',
  };
}

async function getInstallState(env: Partial<Env>): Promise<{ state: string; jobId: string }> {
  const response = await route(new Request('https://example.com/connect/github?job_id=job-123'), env);
  expect(response.status).toBe(302);
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const installUrl = new URL(location!);
  return { state: installUrl.searchParams.get('state')!, jobId: 'job-123' };
}

describe('HTTP foundation', () => {
  test('returns a deterministic health response without bindings or secrets', async () => {
    const response = route(new Request('https://example.com/healthz'));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true, service: 'notiongit' });
  });

  test('serves the public landing page', async () => {
    const response = route(new Request('https://example.com/'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<title>InkDrafts</title>');
  });

  test('reserves provider callback namespaces', async () => {
    const response = await route(
      new Request('https://example.com/auth/notion/callback?code=redacted'),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'notion_configuration_missing' });
  });

  test('returns JSON for unknown routes', async () => {
    const response = route(new Request('https://example.com/nope'));

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});

describe('GitHub App install and authorize flow', () => {
  test('creates a signed, expiring install URL bound to the onboarding job', async () => {
    const kv = new MemoryKV();
    const env = await githubEnv(kv);
    const { state, jobId } = await getInstallState(env);

    expect(state.split('.')).toHaveLength(2);
    expect(state).not.toContain(jobId);
    expect(kv.entries().join('\n')).not.toContain('client-secret');
  });

  test('generates the repository from the template, sends the browser on to Notion, and records only non-secret identity', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<ProvisioningMessage>();
    const env = await githubEnv(kv, queue);
    const { state } = await getInstallState(env);
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    const generateBodies: Array<Record<string, unknown>> = [];

    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'user-token', token_type: 'bearer' });
      }
      if (request.url === 'https://api.github.com/user') {
        expect(request.headers.get('authorization')).toBe('Bearer user-token');
        return Response.json({ id: 42, login: 'alice', type: 'User' });
      }
      if (request.url === 'https://api.github.com/user/installations/123') {
        expect(request.headers.get('authorization')).toBe('Bearer user-token');
        return Response.json({ account: { id: 42, login: 'alice', type: 'User' }, suspended_at: null });
      }
      if (request.url.startsWith('https://api.github.com/user/repos?')) {
        expect(request.headers.get('authorization')).toBe('Bearer user-token');
        return Response.json([]);
      }
      if (request.url === 'https://api.github.com/repos/inkdrafts/notiongit-template/commits/main') {
        expect(request.headers.get('authorization')).toBe('Bearer user-token');
        return Response.json({ sha: 'template-head-sha', commit: { tree: { sha: 'template-tree-sha' } } });
      }
      if (request.url === 'https://api.github.com/repos/inkdrafts/notiongit-template/generate') {
        expect(request.method).toBe('POST');
        expect(request.headers.get('authorization')).toBe('Bearer user-token');
        generateBodies.push(await request.json() as Record<string, unknown>);
        return Response.json({
          id: 1001,
          name: 'alice.github.io',
          full_name: 'alice/alice.github.io',
          html_url: 'https://github.com/alice/alice.github.io',
          default_branch: 'main',
          fork: false,
          description: 'Notion-powered site published with InkDrafts',
        }, { status: 201 });
      }
      throw new Error(`unexpected URL: ${request.url}`);
    };

    try {
      const callback = await route(
        new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(state)}&code=one-time-code&installation_id=123&setup_action=install`),
        env,
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get('location')).toBe('https://example.com/connect/notion?job_id=job-123');
      expect(generateBodies).toEqual([{
        name: 'alice.github.io',
        description: 'Notion-powered site published with InkDrafts',
        private: false,
        include_all_branches: false,
      }]);

      // Nothing is queued yet: the Notion callback writes the repository's
      // Actions secrets and only then hands the job to the queue.
      expect(queue.sent).toEqual([]);

      const stored = await kv.get<ProvisioningJob>('github:onboarding-job:job-123', 'json');
      expect(stored?.status).toBe('awaiting_notion');
      expect(stored?.data.notionSecretsWrittenAt).toBeNull();
      expect(stored?.data.pages).toBeNull();
      expect(stored?.data.sync).toBeNull();
      expect(stored?.data.deployment).toBeNull();
      expect(Object.values(stored?.steps ?? {}).every((step) => step.status === 'pending')).toBe(true);
      expect(stored?.data.generatedRepository).toMatchObject({
        id: 1001,
        fullName: 'alice/alice.github.io',
        headSha: null,
        headTreeSha: null,
        templateHeadSha: 'template-head-sha',
        templateHeadTreeSha: 'template-tree-sha',
        reused: false,
      });
      const persisted = kv.entries().join('\n');
      expect(persisted).not.toContain('user-token');
      expect(persisted).not.toContain('one-time-code');

      const replay = await route(
        new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(state)}&code=one-time-code&installation_id=123`),
        env,
      );
      expect(replay.status).toBe(400);
      expect(await replay.json()).toEqual({ error: 'github_state_replayed' });
      expect(requests).toHaveLength(6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('accepts a setup callback before the OAuth callback', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<ProvisioningMessage>();
    const env = await githubEnv(kv, queue);
    const { state } = await getInstallState(env);
    const originalFetch = globalThis.fetch;
    let calls = 0;

    globalThis.fetch = async (input, init) => {
      calls += 1;
      const request = new Request(input, init);
      if (request.url === 'https://api.github.com/app/installations/123') {
        return Response.json({ account: { id: 42, login: 'alice', type: 'User' }, suspended_at: null });
      }
      if (request.url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'user-token' });
      }
      if (request.url === 'https://api.github.com/user') {
        return Response.json({ id: 42, login: 'alice', type: 'User' });
      }
      if (request.url === 'https://api.github.com/user/installations/123') {
        return Response.json({ account: { id: 42, login: 'alice', type: 'User' }, suspended_at: null });
      }
      if (request.url.startsWith('https://api.github.com/user/repos?')) return Response.json([]);
      if (request.url === 'https://api.github.com/repos/inkdrafts/notiongit-template/commits/main') {
        return Response.json({ sha: 'template-head-sha', commit: { tree: { sha: 'template-tree-sha' } } });
      }
      if (request.url === 'https://api.github.com/repos/inkdrafts/notiongit-template/generate') {
        return Response.json({
          id: 1001,
          name: 'alice.github.io',
          full_name: 'alice/alice.github.io',
          html_url: 'https://github.com/alice/alice.github.io',
          default_branch: 'main',
          fork: false,
        }, { status: 201 });
      }
      throw new Error(`unexpected URL: ${request.url}`);
    };

    try {
      const setup = await route(
        new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(state)}&installation_id=123&setup_action=install`),
        env,
      );
      expect(setup.status).toBe(202);
      expect(await setup.json()).toEqual({ status: 'awaiting_authorization', job_id: 'job-123' });

      const callback = await route(
        new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(state)}&code=one-time-code&setup_action=install`),
        env,
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get('location')).toBe('https://example.com/connect/notion?job_id=job-123');
      expect(calls).toBe(7);
      expect(queue.sent).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('reuses an already-generated repository instead of creating a duplicate', async () => {
    const { response, requests, kv } = await runProvisioningCallback({
      owned: [generatedRepositoryBody('alice.github.io')],
    });

    expect(response.status).toBe(302);
    expect(requests.some((request) => request.url.endsWith('/generate'))).toBe(false);
    expect(requests.some((request) => request.url.includes('notiongit-template/commits'))).toBe(false);

    const stored = await kv.get<ProvisioningJob>('github:onboarding-job:job-123', 'json');
    expect(stored?.data.generatedRepository).toMatchObject({ reused: true, fullName: 'alice/alice.github.io' });
  });

  test('adopts its own colliding repository instead of advancing to a new name', async () => {
    const { response, generateNames, kv } = await runProvisioningCallback({
      generate: [{ status: 422 }],
      colliding: [{ status: 200, body: generatedRepositoryBody('alice.github.io') }],
    });

    expect(response.status).toBe(302);
    expect(generateNames).toEqual(['alice.github.io']);

    const stored = await kv.get<ProvisioningJob>('github:onboarding-job:job-123', 'json');
    expect(stored?.data.repository).toMatchObject({ name: 'alice.github.io' });
    expect(stored?.data.generatedRepository).toMatchObject({ reused: true });
  });

  test('advances to the next deterministic name when a foreign repository holds the first', async () => {
    const { response, generateNames, kv } = await runProvisioningCallback({
      generate: [{ status: 422 }, { status: 201 }],
      colliding: [{
        status: 200,
        body: {
          id: 2002,
          name: 'alice.github.io',
          full_name: 'alice/alice.github.io',
          html_url: 'https://github.com/alice/alice.github.io',
          default_branch: 'main',
          fork: false,
          description: 'someone else owns this name',
        },
      }],
    });

    expect(response.status).toBe(302);
    expect(generateNames).toEqual(['alice.github.io', 'alice-inkdrafts']);
    const stored = await kv.get<ProvisioningJob>('github:onboarding-job:job-123', 'json');
    expect(stored?.data.repository).toMatchObject({
      name: 'alice-inkdrafts',
      url: 'https://alice.github.io/alice-inkdrafts',
    });
  });

  test('surfaces a secondary rate limit distinctly with retry guidance and no job record', async () => {
    const { response, kv, queue } = await runProvisioningCallback({
      generate: [{ status: 403, headers: { 'retry-after': '60' } }],
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'github_generate_rate_limited', retry_after_seconds: 60 });
    expect(await kv.get('github:onboarding-job:job-123')).toBeNull();
    expect(kv.entries().join('\n')).not.toContain('user-token');
    expect(queue.sent).toEqual([]);
  });

  test('refuses the callback with 429 when the global mutation budget is spent, before any list or generate call', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<ProvisioningMessage>();
    const env = await githubEnv(kv, queue);
    const { state } = await getInstallState(env);
    const exhausted: GlobalRateState = {
      version: 1,
      minuteBucket: Math.floor(Date.now() / 60_000),
      hourBucket: Math.floor(Date.now() / 3_600_000),
      minuteCount: 30,
      hourCount: 100,
    };
    await kv.put(GLOBAL_RATE_KEY, JSON.stringify(exhausted), { expirationTtl: 7200 });
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      requests.push(`${request.method} ${request.url}`);
      if (request.url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'user-token' });
      if (request.url === 'https://api.github.com/user') return Response.json({ id: 42, login: 'alice', type: 'User' });
      throw new Error(`unexpected URL: ${request.url}`);
    }) as typeof fetch;

    try {
      const response = await route(
        new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(state)}&code=one-time-code&installation_id=123&setup_action=install`),
        env,
      );
      expect(response.status).toBe(429);
      const body = await response.json() as Record<string, unknown>;
      expect(body.error).toBe('github_rate_limited');
      expect(body.retry_after_seconds as number).toBeGreaterThanOrEqual(1);
      expect(body.retry_after_seconds as number).toBeLessThanOrEqual(60);
      expect(response.headers.get('retry-after')).toBe(String(body.retry_after_seconds));

      // Only the code exchange and the identity read ran; nothing was
      // written — not a job record, not a lease, not a consumed state.
      expect(requests).toEqual([
        'POST https://github.com/login/oauth/access_token',
        'GET https://api.github.com/user',
      ]);
      expect(queue.sent).toEqual([]);
      const persisted = kv.entries().join('\n');
      expect(persisted).not.toContain('github:onboarding-job:job-123');
      expect(persisted).not.toContain('github:account-lease:42');
      expect(persisted).not.toContain('user-token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a second onboarding for an account whose provisioning is live is refused as already active', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<ProvisioningMessage>();
    const env = await githubEnv(kv, queue);
    // A second onboarding session binds a different job id; give it the same
    // validated Notion template so the refusal is the lease's doing.
    const resolution = await kv.get('notion:template-resolution:job-123', 'json');
    await kv.put(
      'notion:template-resolution:job-456',
      JSON.stringify({ ...(resolution as Record<string, unknown>), jobId: 'job-456' }),
      { expirationTtl: 24 * 60 * 60 },
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      if (request.url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'user-token' });
      if (request.url === 'https://api.github.com/user') return Response.json({ id: 42, login: 'alice', type: 'User' });
      if (request.url === 'https://api.github.com/user/installations/123') return Response.json({ account: { id: 42, login: 'alice', type: 'User' }, suspended_at: null });
      if (request.url.startsWith('https://api.github.com/user/repos?')) return Response.json([]);
      if (request.url === 'https://api.github.com/repos/inkdrafts/notiongit-template/commits/main') return Response.json({ sha: 'template-head-sha', commit: { tree: { sha: 'template-tree-sha' } } });
      if (request.url === 'https://api.github.com/repos/inkdrafts/notiongit-template/generate') return Response.json(generatedRepositoryBody('alice.github.io'), { status: 201 });
      throw new Error(`unexpected URL: ${request.url}`);
    }) as typeof fetch;

    const stateFor = async (jobId: string): Promise<string> => {
      const begin = await route(new Request(`https://example.com/connect/github?job_id=${jobId}`), env);
      expect(begin.status).toBe(302);
      return new URL(begin.headers.get('location')!).searchParams.get('state')!;
    };

    try {
      const first = await route(
        new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(await stateFor('job-123'))}&code=one-time-code&installation_id=123&setup_action=install`),
        env,
      );
      expect(first.status).toBe(302);
      expect(new URL(first.headers.get('location')!).searchParams.get('job_id')).toBe('job-123');
      expect(JSON.parse(await kv.get(accountLeaseKey(42)) as string)).toMatchObject({ jobId: 'job-123' });

      const second = await route(
        new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(await stateFor('job-456'))}&code=one-time-code&installation_id=123&setup_action=install`),
        env,
      );
      // The double starter just OAuth'd as the account that holds the slot,
      // so the answer is a redirect to the active job's progress page.
      expect(second.status).toBe(303);
      expect(second.headers.get('location')).toBe('https://example.com/progress?job_id=job-123');
      // The live job keeps the account's single slot and no second job was
      // created or enqueued for it.
      expect(JSON.parse(await kv.get(accountLeaseKey(42)) as string)).toMatchObject({ jobId: 'job-123' });
      expect(await kv.get('github:onboarding-job:job-456')).toBeNull();
      // The GitHub callback never enqueues; the Notion callback does.
      expect(queue.sent).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a generation failure releases the account lease before the error surfaces', async () => {
    const { response, kv } = await runProvisioningCallback({
      generate: [{ status: 500 }],
    });

    expect(response.status).toBe(502);
    expect(await kv.get(accountLeaseKey(42))).toBeNull();
  });

  test('a different account provisions independently of a lease held by another account', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<ProvisioningMessage>();
    const env = await githubEnv(kv, queue);
    // Account 42 has a live lease naming a queued job — an onboarding in flight.
    const job = createProvisioningJob({
      jobId: 'job-123',
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
        templateHeadSha: null,
        templateHeadTreeSha: null,
        headSha: null,
        headTreeSha: null,
        reused: false,
      },
      now: Date.now(),
    });
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, job);
    await kv.put(accountLeaseKey(42), JSON.stringify({ version: 1, jobId: 'job-123', expiresAt: Date.now() + 600_000 }), { expirationTtl: 1800 });
    // Bob's onboarding session binds its own job id; give it the same
    // validated Notion template so it gets past the preflight.
    const resolution = await kv.get('notion:template-resolution:job-123', 'json');
    await kv.put(
      'notion:template-resolution:job-789',
      JSON.stringify({ ...(resolution as Record<string, unknown>), jobId: 'job-789' }),
      { expirationTtl: 24 * 60 * 60 },
    );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
      if (request.url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'user-token' });
      if (request.url === 'https://api.github.com/user') return Response.json({ id: 43, login: 'bob', type: 'User' });
      if (request.url === 'https://api.github.com/user/installations/123') return Response.json({ account: { id: 43, login: 'bob', type: 'User' }, suspended_at: null });
      if (request.url.startsWith('https://api.github.com/user/repos?')) return Response.json([]);
      if (request.url === 'https://api.github.com/repos/inkdrafts/notiongit-template/commits/main') return Response.json({ sha: 'template-head-sha', commit: { tree: { sha: 'template-tree-sha' } } });
      if (request.url === 'https://api.github.com/repos/inkdrafts/notiongit-template/generate') return Response.json(generatedRepositoryBody('bob.github.io'), { status: 201 });
      throw new Error(`unexpected URL: ${request.url}`);
    }) as typeof fetch;

    try {
      const begin = await route(new Request('https://example.com/connect/github?job_id=job-789'), env);
      const state = new URL(begin.headers.get('location')!).searchParams.get('state')!;
      const response = await route(
        new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(state)}&code=one-time-code&installation_id=123&setup_action=install`),
        env,
      );
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get('location')!).searchParams.get('job_id')).toBe('job-789');
      // Bob got his own lease; Alice's in-flight provisioning kept hers.
      expect(JSON.parse(await kv.get(accountLeaseKey(43)) as string)).toMatchObject({ jobId: 'job-789' });
      expect(JSON.parse(await kv.get(accountLeaseKey(42)) as string)).toMatchObject({ jobId: 'job-123' });
      // The GitHub callback never enqueues; the Notion callback does.
      expect(queue.sent).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each([
    ['suspended installation', { suspended_at: '2026-09-02T00:00:00Z' }, 'github_installation_suspended', 403],
    ['organization installation', { suspended_at: null, account: { id: 7, login: 'org', type: 'Organization' } }, 'github_organization_installation_not_supported', 403],
    ['account mismatch', { suspended_at: null, account: { id: 7, login: 'bob', type: 'User' } }, 'github_account_mismatch', 403],
  ])('%s fails without exposing credentials', async (_name, installation, expectedError, expectedStatus) => {
    const kv = new MemoryKV();
    const env = await githubEnv(kv);
    const { state } = await getInstallState(env);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'user-token' });
      if (request.url === 'https://api.github.com/user') return Response.json({ id: 42, login: 'alice', type: 'User' });
      if (request.url === 'https://api.github.com/user/installations/123') return Response.json(installation);
      if (request.url.startsWith('https://api.github.com/user/repos?')) return Response.json([]);
      throw new Error(`unexpected URL: ${request.url}`);
    };

    try {
      const response = await route(
        new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(state)}&code=one-time-code&installation_id=123`),
        env,
      );
      expect(response.status).toBe(expectedStatus);
      expect(await response.json()).toEqual({ error: expectedError });
      expect(kv.entries().join('\n')).not.toContain('user-token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('reports a GitHub identity rate limit as a 429 instead of masking it', async () => {
    const kv = new MemoryKV();
    const env = await githubEnv(kv);
    const { state } = await getInstallState(env);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'user-token' });
      if (request.url === 'https://api.github.com/user') return new Response('rate limited', { status: 429 });
      throw new Error(`unexpected URL: ${request.url}`);
    };

    try {
      const response = await route(
        new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(state)}&code=one-time-code&installation_id=123`),
        env,
      );
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({ error: 'github_rate_limited' });
      expect(kv.entries().join('\n')).not.toContain('user-token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects denial, invalid state, and missing installation safely', async () => {
    const env = await githubEnv();
    const denied = await route(new Request('https://example.com/auth/github/callback?error=access_denied'), env);
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual({ error: 'github_authorization_denied' });

    const invalid = await route(new Request('https://example.com/auth/github/callback?state=forged'), env);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'github_state_invalid' });

    const { state } = await getInstallState(env);
    const missing = await route(
      new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(state)}`),
      env,
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'github_installation_missing' });
  });
});

describe('Repository naming and GitHub Pages destinations', () => {
  test.each([
    ['Alice', [], 'alice.github.io', 'https://alice.github.io', ''],
    ['Alice', ['ALICE.GITHUB.IO'], 'alice-inkdrafts', 'https://alice.github.io/alice-inkdrafts', '/alice-inkdrafts'],
    ['alice', ['alice.github.io', 'alice-inkdrafts', 'alice-inkdrafts-2'], 'alice-inkdrafts-3', 'https://alice.github.io/alice-inkdrafts-3', '/alice-inkdrafts-3'],
  ])('%s selects a stable destination', (login, existing, name, url, baseurl) => {
    expect(selectRepositoryDestination(login, existing)).toMatchObject({ name, url, baseurl });
  });

  test('treats invalid GitHub repository names as invalid candidates', () => {
    expect(isValidGithubRepositoryName('valid_name-1.0')).toBe(true);
    expect(isValidGithubRepositoryName('')).toBe(false);
    expect(isValidGithubRepositoryName('contains spaces')).toBe(false);
    expect(isValidGithubRepositoryName('x'.repeat(101))).toBe(false);
  });

  test('retries the next deterministic name when creation loses a race', async () => {
    const attempted: string[] = [];
    const result = await createRepositoryWithRetry(
      'Alice',
      ['alice.github.io'],
      async (destination) => {
        attempted.push(destination.name);
        if (attempted.length < 3) throw new GithubRepositoryNameCollisionError();
        return { created: true };
      },
    );

    expect(attempted).toEqual(['alice-inkdrafts', 'alice-inkdrafts-2', 'alice-inkdrafts-3']);
    expect(result.destination.url).toBe('https://alice.github.io/alice-inkdrafts-3');
    expect(result.result).toEqual({ created: true });
  });

  test('paginates the owned-repository check before selecting a name', async () => {
    const requests: string[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ name: `existing-${index}` }));
    firstPage[0] = { name: 'ALICE.GITHUB.IO' };
    firstPage[1] = { name: 'alice-inkdrafts' };
    const destination = await selectGithubRepositoryDestination(
      'user-token',
      'Alice',
      async (input, init) => {
        const request = new Request(input, init);
        requests.push(request.url);
        expect(request.headers.get('authorization')).toBe('Bearer user-token');
        return request.url.endsWith('page=1')
          ? Response.json(firstPage)
          : Response.json([{ name: 'alice-inkdrafts-2' }]);
      },
    );

    expect(requests).toHaveLength(2);
    expect(destination).toMatchObject({
      name: 'alice-inkdrafts-3',
      url: 'https://alice.github.io/alice-inkdrafts-3',
      baseurl: '/alice-inkdrafts-3',
    });
  });
});

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

describe('provisioning queue consumer', () => {
  test('acks a malformed message body instead of retrying forever', async () => {
    const env = await githubEnv();
    const message = fakeMessage({ jobId: '' });
    await worker.queue!(fakeBatch([message]) as any, env as Env, FAKE_EXECUTION_CONTEXT as any);
    expect(message.acked).toBe(true);
    expect(message.retried).toBeNull();
  });

  test('acks after advancing a step and enqueues no continuation the message need not carry', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<ProvisioningMessage>();
    const env = await githubEnv(kv, queue);
    const job = createProvisioningJob({
      jobId: 'job-1',
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
        templateHeadSha: 't',
        templateHeadTreeSha: 't2',
        headSha: 'generated-head-sha',
        headTreeSha: 'generated-tree-sha',
        reused: false,
      },
      now: Date.now(),
    });
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, {
      ...job,
      status: 'queued',
      data: { ...job.data, notionSecretsWrittenAt: Date.now() },
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === 'https://api.github.com/app/installations/123/access_tokens') {
        return Response.json({ token: 'installation-token' });
      }
      if (url === 'https://api.github.com/repos/alice/alice.github.io') {
        return Response.json({ id: 1001, full_name: 'alice/alice.github.io', default_branch: 'main', fork: false });
      }
      if (url === 'https://api.github.com/repos/alice/alice.github.io/commits/main') {
        return Response.json({ sha: 'generated-head-sha', commit: { tree: { sha: 'generated-tree-sha' } } });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    try {
      const message = fakeMessage({ jobId: 'job-1' });
      await worker.queue!(fakeBatch([message]) as any, env as Env, FAKE_EXECUTION_CONTEXT as any);
      expect(message.acked).toBe(true);
      expect(message.retried).toBeNull();
      expect(queue.sent).toEqual([{ jobId: 'job-1' }]);
      const stored = await kv.get<ProvisioningJob>('github:onboarding-job:job-1', 'json');
      expect(stored?.steps.verify_repository.status).toBe('succeeded');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('retries a message when the job cannot be processed', async () => {
    const env = await githubEnv();
    const brokenJobs = {
      get() { throw new Error('KV outage'); },
      put() { throw new Error('KV outage'); },
    };
    const message = fakeMessage({ jobId: 'job-1' });
    await worker.queue!(
      fakeBatch([message]) as any,
      { ...env, JOBS: brokenJobs as unknown as KVNamespace } as Env,
      FAKE_EXECUTION_CONTEXT as any,
    );
    expect(message.acked).toBe(false);
    expect(message.retried).toEqual({});
  });
});

const JOB_ID = 'job-123';
const NOTION_ACCESS_TOKEN = 'synthetic-notion-access-token';
const INSTALLATION_TOKEN = 'synthetic-installation-token';
const NOTION_ROOT = '55555555-5555-4555-8555-555555555555';
const SECOND_NOTION_ROOT = '66666666-6666-4666-8666-666666666666';
const PAGES_DB = '11111111-1111-4111-8111-111111111111';
const POSTS_DB = '22222222-2222-4222-8222-222222222222';
const SECOND_PAGES_DB = '33333333-3333-4333-8333-333333333333';
const SECOND_POSTS_DB = '44444444-4444-4444-8444-444444444444';
/** Canonical URLs the fake's Notion API hands back. Their embedded slugs are
 * deliberately unrelated to the database IDs, so any id-shaped leak — for
 * instance a link synthesized from a bare ID — trips the leak assertions. */
const PAGES_DB_URL = 'https://www.notion.so/alice-site/Pages-aaa111bb222ccc333ddd444eee555fff1';
const POSTS_DB_URL = 'https://www.notion.so/alice-site/Posts-bbb222ccc333ddd444eee555fff111aaa2';
const ROOT_PAGE_URL = 'https://www.notion.so/alice-site/My-Site-Home';
/** The Actions public key fixture from `test/actions-secrets.test.ts`: the
 * sealed-box counterpart of the seed-derived keypair the assertions open. */
const ACTIONS_PUBLIC_KEY = 'RwHQhIhFH1RaQJ+1iuPlhYHKQKw/fxFGmM1x3qxzygE=';

const NOTION_TOKEN_RESPONSE = {
  access_token: NOTION_ACCESS_TOKEN,
  token_type: 'bearer',
  bot_id: 'synthetic-bot-id',
  workspace_id: 'synthetic-workspace-id',
  duplicated_template_id: NOTION_ROOT,
};

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
  };
}

function postsProperties(): Record<string, unknown> {
  return {
    Title: { type: 'title' },
    Slug: { type: 'rich_text' },
    Status: { type: 'select', select: { options: [{ name: 'Draft' }, { name: 'Published' }] } },
    'Publish Date': { type: 'date' },
    Tags: { type: 'multi_select', multi_select: { options: [{ name: 'guide' }] } },
  };
}

interface OnboardingFakeOptions {
  /** Duplicated root id to the two database ids it resolves to. */
  roots?: Record<string, { pages: string; posts: string }>;
  /** Replaces the response for one secret PUT, by 1-based write order. */
  onSecretPut?: (name: string, attempt: number) => Response | null;
}

/**
 * Answers every provider call the onboarding continuation makes: the Notion
 * template walk, the installation-token mint, and the three Actions secret
 * writes. An unexpected request fails loudly.
 */
function onboardingFake(options: OnboardingFakeOptions = {}) {
  const roots = options.roots ?? { [NOTION_ROOT]: { pages: PAGES_DB, posts: POSTS_DB } };
  const pageDatabaseIds = new Set(Object.values(roots).map((entry) => entry.pages));
  const calls: string[] = [];
  const secretWrites: Array<{ name: string; encryptedValue: string }> = [];
  let secretPuts = 0;

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const segments = url.pathname.split('/');
    calls.push(`${request.method} ${url.origin}${url.pathname}`);

    if (url.origin === 'https://api.notion.com' && segments[2] === 'blocks') {
      const root = roots[segments[3]];
      if (!root) throw new Error(`unexpected duplicated root: ${segments[3]}`);
      return Response.json({
        object: 'list',
        results: [
          { object: 'block', id: root.pages, type: 'child_database', child_database: {} },
          { object: 'block', id: root.posts, type: 'child_database', child_database: {} },
        ],
        has_more: false,
        next_cursor: null,
      });
    }
    if (url.origin === 'https://api.notion.com' && segments[2] === 'pages') {
      return Response.json({ object: 'page', id: segments[3], url: ROOT_PAGE_URL });
    }
    if (url.origin === 'https://api.notion.com' && segments[2] === 'databases') {
      const databaseId = segments[3];
      const isPages = pageDatabaseIds.has(databaseId);
      return Response.json({
        object: 'database',
        id: databaseId,
        url: isPages ? PAGES_DB_URL : POSTS_DB_URL,
        title: [{ type: 'text', text: { content: 'A title the user may have renamed' } }],
        properties: isPages ? pagesProperties() : postsProperties(),
      });
    }
    if (url.href === 'https://api.github.com/app/installations/123/access_tokens') {
      return Response.json({ token: INSTALLATION_TOKEN });
    }
    if (url.pathname === '/repos/alice/alice.github.io/actions/secrets/public-key') {
      return Response.json({ key_id: 'actions-key-1', key: ACTIONS_PUBLIC_KEY });
    }
    if (request.method === 'PUT' && url.pathname.startsWith('/repos/alice/alice.github.io/actions/secrets/')) {
      const name = segments[segments.length - 1];
      secretPuts += 1;
      const override = options.onSecretPut?.(name, secretPuts);
      if (override) return override;
      const body = await request.json() as { encrypted_value: string };
      secretWrites.push({ name, encryptedValue: body.encrypted_value });
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected URL: ${request.url}`);
  }) as typeof fetch;

  return { fetcher, calls, secretWrites };
}

async function decryptSecretWrites(
  writes: Array<{ name: string; encryptedValue: string }>,
): Promise<Record<string, string>> {
  await sodium.ready;
  const keypair = sodium.crypto_box_seed_keypair(Uint8Array.from({ length: 32 }, (_, index) => index));
  return Object.fromEntries(writes.map(({ name, encryptedValue }) => [
    name,
    sodium.to_string(sodium.crypto_box_seal_open(
      sodium.from_base64(encryptedValue, sodium.base64_variants.ORIGINAL),
      keypair.publicKey,
      keypair.privateKey,
    )),
  ]));
}

/** The record `finishGithubCallback` leaves behind, before Notion authorization. */
function awaitingNotionJob(): ProvisioningJob {
  return createProvisioningJob({
    jobId: JOB_ID,
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
}

/** The record `awaitingNotionJob` becomes after every provisioning step ran. */
function succeededJob(): ProvisioningJob {
  const job = awaitingNotionJob();
  for (const step of PROVISIONING_STEP_ORDER) {
    job.steps[step] = { ...job.steps[step], status: 'succeeded', attempts: 1 };
  }
  return {
    ...job,
    status: 'succeeded',
    data: { ...job.data, notionSecretsWrittenAt: 2_000 },
    completedAt: 3_000,
  };
}

function runContinuation(
  env: Partial<Env>,
  fetcher: typeof fetch,
  duplicatedTemplateId: string | null = NOTION_ROOT,
): Promise<Record<string, unknown> | void> {
  return Promise.resolve(continueNotionOnboarding(env, { fetcher, sleep: async () => {} })({
    jobId: JOB_ID,
    accessToken: Secret.notionUserAccess(NOTION_ACCESS_TOKEN),
    duplicatedTemplateId,
  }));
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

async function startNotionAuthorization(env: Partial<Env>): Promise<{ state: string; cookie: string }> {
  const response = await route(new Request(`https://example.com/connect/notion?job_id=${JOB_ID}`), env);
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!);
  return { state: location.searchParams.get('state')!, cookie: response.headers.get('set-cookie')!.split(';', 1)[0] };
}

function notionCallbackRequest(state: string, cookie: string): Request {
  return new Request(
    `https://example.com/auth/notion/callback?state=${encodeURIComponent(state)}&code=synthetic-code`,
    { headers: { Cookie: cookie } },
  );
}

describe('Notion authorization entry', () => {
  test('refuses to start without a job id, and without a job to match it', async () => {
    const env = await githubEnv();

    const missing = await route(new Request('https://example.com/connect/notion'), env);
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({
      error: 'provisioning_job_missing',
      message: 'Connect GitHub first.',
      connect_url: '/connect/github',
    });

    const unknown = await route(new Request('https://example.com/connect/notion?job_id=job-nope'), env);
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toMatchObject({ error: 'provisioning_job_missing' });
  });

  test('redirects to Notion for a job the GitHub callback created', async () => {
    const kv = new MemoryKV();
    const env = await githubEnv(kv);
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, awaitingNotionJob());

    const response = await route(new Request(`https://example.com/connect/notion?job_id=${JOB_ID}`), env);

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location')!).origin).toBe('https://api.notion.com');
  });
});

describe('Notion onboarding continuation', () => {
  test('writes the three Actions secrets, then hands the job to the queue', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<ProvisioningMessage>();
    const env = await githubEnv(kv, queue);
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, awaitingNotionJob());
    const fake = onboardingFake();

    const details = await runContinuation(env, fake.fetcher);

    expect(await decryptSecretWrites(fake.secretWrites)).toEqual({
      NOTION_TOKEN: NOTION_ACCESS_TOKEN,
      NOTION_PAGES_DATABASE_ID: PAGES_DB,
      NOTION_POSTS_DATABASE_ID: POSTS_DB,
    });
    expect(queue.sent).toEqual([{ jobId: JOB_ID }]);
    expect(details).toBeUndefined();

    const stored = await kv.get<ProvisioningJob>(`github:onboarding-job:${JOB_ID}`, 'json');
    expect(stored?.status).toBe('queued');
    expect(stored?.data.notionSecretsWrittenAt).toBeGreaterThan(0);
    expect(await loadNotionTemplateResolution(env.JOBS as unknown as KVNamespace, JOB_ID))
      .toMatchObject({ resolution: { pagesDatabaseId: PAGES_DB, postsDatabaseId: POSTS_DB } });

    // Neither token reaches durable state, the job record included.
    const persisted = kv.entries().join('\n');
    expect(persisted).not.toContain(NOTION_ACCESS_TOKEN);
    expect(persisted).not.toContain(INSTALLATION_TOKEN);
  });

  test('hands the job record the canonical Notion URLs and never the database IDs', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<ProvisioningMessage>();
    const env = await githubEnv(kv, queue);
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, awaitingNotionJob());
    const fake = onboardingFake();

    await runContinuation(env, fake.fetcher);

    const stored = await kv.get<ProvisioningJob>(`github:onboarding-job:${JOB_ID}`, 'json');
    expect(stored?.data.notionLinks).toEqual({
      pagesUrl: PAGES_DB_URL,
      postsUrl: POSTS_DB_URL,
      templateRootUrl: ROOT_PAGE_URL,
    });

    // The job record carries the API-returned canonical URLs; a link
    // synthesized from a bare ID would embed one below and fail.
    const jobRecord = await kv.get(`github:onboarding-job:${JOB_ID}`);
    for (const id of [PAGES_DB, POSTS_DB]) {
      expect(jobRecord).not.toContain(id);
      expect(jobRecord).not.toContain(id.replaceAll('-', ''));
    }
    expect(jobRecord).toContain(PAGES_DB_URL);
    expect(jobRecord).toContain(POSTS_DB_URL);
    expect(jobRecord).toContain(ROOT_PAGE_URL);

    // Rendered output never carries the raw IDs either.
    const page = await route(new Request(`https://example.com/progress?job_id=${JOB_ID}`), env);
    const rendered = await page.text();
    for (const id of [PAGES_DB, POSTS_DB]) {
      expect(rendered).not.toContain(id);
      expect(rendered).not.toContain(id.replaceAll('-', ''));
    }

    // The IDs remain in the server-side resolution record, where the sync
    // secrets workflow is the only consumer.
    const resolutionRecord = JSON.stringify(await kv.get('notion:template-resolution:job-123', 'json'));
    expect(resolutionRecord).toContain(PAGES_DB);
    expect(resolutionRecord).toContain(POSTS_DB);
  });

  test('fails a manual-page authorization with a distinct, actionable error', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<ProvisioningMessage>();
    const env = await githubEnv(kv, queue);
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, awaitingNotionJob());
    const fake = onboardingFake();

    const error = await caught(runContinuation(env, fake.fetcher, null));

    expect(error).toBeInstanceOf(NotionOAuthError);
    expect((error as NotionOAuthError).code).toBe('notion_template_not_duplicated');
    expect((error as NotionOAuthError).status).toBe(400);
    expect(fake.calls).toEqual([]);
    expect(queue.sent).toEqual([]);
  });

  test('refuses a callback for a job that no longer exists', async () => {
    const env = await githubEnv();
    const fake = onboardingFake();

    const error = await caught(runContinuation(env, fake.fetcher));

    expect((error as NotionOAuthError).code).toBe('provisioning_job_missing');
    expect((error as NotionOAuthError).status).toBe(409);
    expect(fake.calls).toEqual([]);
  });

  test('a partial secret write leaves the job awaiting Notion, and re-authorizing writes all three', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<ProvisioningMessage>();
    const env = await githubEnv(kv, queue);
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, awaitingNotionJob());
    const failing = onboardingFake({
      onSecretPut: (_name, attempt) => (attempt === 2 ? new Response(null, { status: 500 }) : null),
    });

    const error = await caught(runContinuation(env, failing.fetcher));

    expect(error).toBeInstanceOf(NotionOAuthError);
    expect((error as NotionOAuthError).code).toBe('github_actions_secret_write_failed');
    expect(failing.secretWrites).toHaveLength(1);
    expect(queue.sent).toEqual([]);
    const afterFailure = await kv.get<ProvisioningJob>(`github:onboarding-job:${JOB_ID}`, 'json');
    expect(afterFailure?.status).toBe('awaiting_notion');
    expect(afterFailure?.data.notionSecretsWrittenAt).toBeNull();

    // The single-use code is spent, so recovery is a fresh authorization for
    // the same job — which re-runs the whole write, every name included.
    const healthy = onboardingFake();
    await runContinuation(env, healthy.fetcher);

    expect(await decryptSecretWrites(healthy.secretWrites)).toEqual({
      NOTION_TOKEN: NOTION_ACCESS_TOKEN,
      NOTION_PAGES_DATABASE_ID: PAGES_DB,
      NOTION_POSTS_DATABASE_ID: POSTS_DB,
    });
    expect(queue.sent).toEqual([{ jobId: JOB_ID }]);
  });

  test('re-resolves the template instead of reusing the previous authorization\'s database ids', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<ProvisioningMessage>();
    const env = await githubEnv(kv, queue);
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, awaitingNotionJob());
    const roots = {
      [NOTION_ROOT]: { pages: PAGES_DB, posts: POSTS_DB },
      [SECOND_NOTION_ROOT]: { pages: SECOND_PAGES_DB, posts: SECOND_POSTS_DB },
    };
    const firstAttempt = onboardingFake({ roots, onSecretPut: () => new Response(null, { status: 500 }) });
    await caught(runContinuation(env, firstAttempt.fetcher, NOTION_ROOT));

    // The second authorization duplicated the template again, so the stored
    // resolution names databases the user is no longer writing in.
    const secondAttempt = onboardingFake({ roots });
    await runContinuation(env, secondAttempt.fetcher, SECOND_NOTION_ROOT);

    expect(await decryptSecretWrites(secondAttempt.secretWrites)).toEqual({
      NOTION_TOKEN: NOTION_ACCESS_TOKEN,
      NOTION_PAGES_DATABASE_ID: SECOND_PAGES_DB,
      NOTION_POSTS_DATABASE_ID: SECOND_POSTS_DB,
    });
  });

  test('a duplicate callback for an already-queued job writes and sends nothing', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<ProvisioningMessage>();
    const env = await githubEnv(kv, queue);
    const base = awaitingNotionJob();
    const queued: ProvisioningJob = {
      ...base,
      status: 'queued',
      data: { ...base.data, notionSecretsWrittenAt: 2_000 },
    };
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, queued);
    const fake = onboardingFake();

    expect(await runContinuation(env, fake.fetcher)).toBeUndefined();
    expect(fake.calls).toEqual([]);
    expect(queue.sent).toEqual([]);
    expect(await kv.get<ProvisioningJob>(`github:onboarding-job:${JOB_ID}`, 'json')).toEqual(queued);
  });

  test('a queue handoff failure keeps the job recoverable instead of reporting success', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<ProvisioningMessage>();
    const env = await githubEnv(kv, queue);
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, awaitingNotionJob());
    queue.failSends = true;
    const fake = onboardingFake();

    const error = await caught(runContinuation(env, fake.fetcher));

    expect(error).toBeInstanceOf(NotionOAuthError);
    expect((error as NotionOAuthError).code).toBe('provisioning_handoff_failed');
    expect((error as NotionOAuthError).status).toBe(502);
    expect((error as NotionOAuthError).details).toEqual({ retry_url: `/connect/notion?job_id=${JOB_ID}` });
    const stalled = await kv.get<ProvisioningJob>(`github:onboarding-job:${JOB_ID}`, 'json');
    expect(stalled?.status).toBe('awaiting_notion');
    expect(stalled?.data.notionSecretsWrittenAt).toBeGreaterThan(0);

    // Re-authorizing goes straight back to the handoff: the secrets are
    // already durable, so nothing is resolved or written a second time.
    queue.failSends = false;
    const retry = onboardingFake();
    await runContinuation(env, retry.fetcher);

    expect(retry.calls).toEqual([]);
    expect(queue.sent).toEqual([{ jobId: JOB_ID }]);
    expect((await kv.get<ProvisioningJob>(`github:onboarding-job:${JOB_ID}`, 'json'))?.status).toBe('queued');
  });

  test('the callback reports a handoff failure rather than a false success', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<ProvisioningMessage>();
    const env = await githubEnv(kv, queue);
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, awaitingNotionJob());
    const { state, cookie } = await startNotionAuthorization(env);
    queue.failSends = true;
    const fake = onboardingFake();

    const response = await route(notionCallbackRequest(state, cookie), env, {
      fetcher: async () => Response.json(NOTION_TOKEN_RESPONSE),
      continueOnboarding: continueNotionOnboarding(env, { fetcher: fake.fetcher, sleep: async () => {} }),
    });

    // The awaiting-Notion progress page is the handoff failure's prescribed
    // recovery, so the browser lands there instead of on a JSON error.
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`https://example.com/progress?job_id=${JOB_ID}`);
    const stalled = await kv.get<ProvisioningJob>(`github:onboarding-job:${JOB_ID}`, 'json');
    expect(stalled?.status).toBe('awaiting_notion');
    expect(stalled?.data.notionSecretsWrittenAt).toBeGreaterThan(0);
  });

  test('surfaces resolution failures through the callback response with non-secret details', async () => {
    const kv = new MemoryKV();
    const env = await githubEnv(kv);
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, awaitingNotionJob());
    const emptyRoot = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith('/v1/blocks/')) {
        return Response.json({ object: 'list', results: [], has_more: false, next_cursor: null });
      }
      throw new Error(`unexpected URL: ${url.href}`);
    }) as typeof fetch;
    const { state, cookie } = await startNotionAuthorization(env);

    const response = await route(notionCallbackRequest(state, cookie), env, {
      fetcher: async () => Response.json(NOTION_TOKEN_RESPONSE),
      continueOnboarding: continueNotionOnboarding(env, { fetcher: emptyRoot, sleep: async () => {} }),
    });

    const bodyText = await response.text();
    expect(response.status).toBe(502);
    expect(JSON.parse(bodyText)).toEqual({ error: 'notion_template_root_empty' });
    expect(bodyText).not.toContain(NOTION_ACCESS_TOKEN);
  });

  test('worker.fetch wires the production continuation end-to-end', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<ProvisioningMessage>();
    const env = await githubEnv(kv, queue);
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, awaitingNotionJob());
    const fake = onboardingFake();
    const workerFetch = worker.fetch as unknown as (request: Request, env: unknown) => Promise<Response>;
    const { state, cookie } = await startNotionAuthorization(env);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://api.notion.com/v1/oauth/token') return Response.json(NOTION_TOKEN_RESPONSE);
      return fake.fetcher(input, init);
    }) as typeof fetch;

    try {
      const callback = await workerFetch(notionCallbackRequest(state, cookie), env);

      expect(callback.status).toBe(303);
      expect(callback.headers.get('location')).toBe(`https://example.com/progress?job_id=${JOB_ID}`);
      expect(await callback.text()).toBe('');
      expect(queue.sent).toEqual([{ jobId: JOB_ID }]);
      expect(kv.entries().join('\n')).not.toContain(NOTION_ACCESS_TOKEN);
      expect(kv.entries().join('\n')).not.toContain(INSTALLATION_TOKEN);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('progress routes', () => {
  test('the page renders the job\u2019s current stage server-side and carries no job internals', async () => {
    const kv = new MemoryKV();
    const env = await githubEnv(kv);
    const job = awaitingNotionJob();
    job.data.notionSecretsWrittenAt = 2_000;
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, job);

    const response = await route(new Request(`https://example.com/progress?job_id=${JOB_ID}`), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const page = await response.text();
    expect(page).toContain('<h1 id="progress-heading">Connect Notion to finish setup</h1>');
    expect(page).toContain('href="/connect/notion?job_id=job-123"');
    expect(page).not.toContain('installationId');
    expect(page).not.toContain('login');
    expect(page).not.toContain('alice');
  });

  test('the status endpoint mirrors the projection snapshot', async () => {
    const kv = new MemoryKV();
    const env = await githubEnv(kv);
    const job = awaitingNotionJob();
    job.data.notionSecretsWrittenAt = 2_000;
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, job);

    const response = await route(new Request(`https://example.com/progress/status?job_id=${JOB_ID}`), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({
      progress: { status: 'awaiting_notion' },
    });
  });

  test('a malformed job id is a 400 on the status route and a 404 missing page on the page route', async () => {
    const env = await githubEnv();

    const status = await route(new Request('https://example.com/progress/status?job_id=not%20valid!'), env);
    expect(status.status).toBe(400);
    expect(await status.json()).toEqual({ error: 'invalid_job_id' });

    const page = await route(new Request('https://example.com/progress?job_id=not%20valid!'), env);
    expect(page.status).toBe(404);
    expect(await page.text()).toContain('We could not find a site setup in progress for this link');
  });

  test('an unknown but well-formed job id is a missing snapshot and a 404 missing page', async () => {
    const env = await githubEnv();

    const status = await route(new Request('https://example.com/progress/status?job_id=job-nope'), env);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      updatedAt: 0,
      progress: {
        status: 'missing',
        message: 'We could not find a site setup in progress for this link.',
        action: 'Start again from the beginning: connect GitHub first, then Notion.',
        restartUrl: '/connect/github',
      },
    });

    const page = await route(new Request('https://example.com/progress?job_id=job-nope'), env);
    expect(page.status).toBe(404);
  });

  test('reading progress performs zero KV puts and zero queue sends', async () => {
    const kv = new MemoryKV();
    const queue = new MemoryQueue<ProvisioningMessage>();
    const env = await githubEnv(kv, queue);
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, awaitingNotionJob());
    const putsBefore = kv.puts;

    await route(new Request(`https://example.com/progress?job_id=${JOB_ID}`), env);
    await route(new Request(`https://example.com/progress/status?job_id=${JOB_ID}`), env);

    expect(kv.puts).toBe(putsBefore);
    expect(queue.sent).toEqual([]);
  });

  test('the site-check endpoint answers only for a succeeded job and probes only the recorded site URL', async () => {
    const kv = new MemoryKV();
    const env = await githubEnv(kv);
    const job = succeededJob();
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, job);
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];

    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        requested.push(String(input));
        return new Response('ok', { status: 200 });
      }) as typeof fetch;
      const ok = await route(new Request(`https://example.com/progress/site-check?job_id=${JOB_ID}`), env);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('cache-control')).toBe('no-store');
      const body = await ok.json() as { reachable: boolean; checkedAt: number };
      expect(body.reachable).toBe(true);
      expect(body.checkedAt).toBeGreaterThan(0);
      // Exactly one probe, and its URL is the job record's, never request input.
      expect(requested).toEqual([job.data.repository.url]);

      requested.length = 0;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        requested.push(String(input));
        return new Response('', { status: 503 });
      }) as typeof fetch;
      const down = await route(new Request(`https://example.com/progress/site-check?job_id=${JOB_ID}`), env);
      expect(await down.json()).toMatchObject({ reachable: false });
      expect(requested).toEqual([job.data.repository.url]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('the site-check endpoint 404s a missing, malformed, unknown, or non-succeeded job without probing', async () => {
    const kv = new MemoryKV();
    const env = await githubEnv(kv);
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, awaitingNotionJob());
    const originalFetch = globalThis.fetch;
    let probes = 0;

    try {
      globalThis.fetch = (async () => {
        probes += 1;
        return new Response('ok', { status: 200 });
      }) as typeof fetch;
      for (const query of ['', '?job_id=', '?job_id=not%20valid!', '?job_id=job-nope', `?job_id=${JOB_ID}`]) {
        const response = await route(new Request(`https://example.com/progress/site-check${query}`), env);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'not_found' });
      }
      expect(probes).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('check=1 probes exactly once during the render and shows the outcome; a plain render probes zero times', async () => {
    const kv = new MemoryKV();
    const env = await githubEnv(kv);
    const job = succeededJob();
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, job);
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];

    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        requested.push(String(input));
        return new Response('ok', { status: 200 });
      }) as typeof fetch;
      const probed = await route(new Request(`https://example.com/progress?job_id=${JOB_ID}&check=1`), env);
      expect(probed.status).toBe(200);
      expect(requested).toEqual([job.data.repository.url]);
      expect(await probed.text()).toContain('Checked just now: your site is answering.');

      requested.length = 0;
      globalThis.fetch = (async () => {
        requested.push('down');
        return new Response('', { status: 503 });
      }) as typeof fetch;
      const lagging = await route(new Request(`https://example.com/progress?job_id=${JOB_ID}&check=1`), env);
      expect(await lagging.text()).toContain('Checked just now: not answering yet. Try again in a minute.');

      requested.length = 0;
      const plain = await route(new Request(`https://example.com/progress?job_id=${JOB_ID}`), env);
      expect(plain.status).toBe(200);
      expect(requested).toEqual([]);
      expect(await plain.text()).toContain('<p id="site-check-result" class="muted" hidden></p>');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('check=1 on a job that is not succeeded never probes and renders the current stage', async () => {
    const kv = new MemoryKV();
    const env = await githubEnv(kv);
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, awaitingNotionJob());
    const originalFetch = globalThis.fetch;
    let probes = 0;

    try {
      globalThis.fetch = (async () => {
        probes += 1;
        return new Response('ok', { status: 200 });
      }) as typeof fetch;
      const response = await route(new Request(`https://example.com/progress?job_id=${JOB_ID}&check=1`), env);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Connect Notion to finish setup');
      expect(probes).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
