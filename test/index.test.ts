import { describe, expect, test } from 'bun:test';

import {
  createProvisioningJob,
  createRepositoryWithRetry,
  GENERATED_REPOSITORY_DESCRIPTION,
  GithubRepositoryNameCollisionError,
  isValidGithubRepositoryName,
  route,
  saveProvisioningJob,
  saveNotionTemplateResolution,
  selectGithubRepositoryDestination,
  selectRepositoryDestination,
  type Env,
  type ProvisioningJob,
  type ProvisioningMessage,
} from '../src/index';
import worker from '../src/index';

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

  async get<T>(key: string, type?: string): Promise<T | string | null> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) as T : value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.values.set(key, value);
    if (options?.expirationTtl !== undefined) this.ttls.set(key, options.expirationTtl);
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

  async send(message: T): Promise<void> {
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
  withValidatedTemplate = true,
): Promise<Partial<Env>> {
  const env = {
    JOBS: kv as unknown as KVNamespace,
    PROVISIONING_QUEUE: queue as unknown as Queue<ProvisioningMessage>,
    GITHUB_APP_ID: '4798518',
    GITHUB_APP_SLUG: 'inkdrafts',
    GITHUB_APP_PRIVATE_KEY: await generateThrowawayPrivateKey(),
    GITHUB_CLIENT_ID: 'client-id',
    GITHUB_CLIENT_SECRET: 'client-secret',
    NOTION_CLIENT_ID: 'not-used',
    NOTION_CLIENT_SECRET: 'not-used',
  };
  if (withValidatedTemplate) await saveNotionTemplateResolution(env.JOBS, {
    version: 1,
    jobId: 'job-123',
    resolution: {
      pagesDatabaseId: '11111111-1111-4111-8111-111111111111',
      postsDatabaseId: '22222222-2222-4222-8222-222222222222',
      templateSchemaVersion: 1,
      scannedDatabaseCount: 2,
      pagesSchema: {
        databaseId: '11111111-1111-4111-8111-111111111111',
        propertyTypes: {
          Slug: 'rich_text', Type: 'select', 'Nav Order': 'number', 'Show in Nav': 'checkbox', Status: 'select',
        },
        optionNames: { Type: ['home', 'blog-list', 'blog', 'markdown'], Status: ['Draft', 'Published'] },
      },
      postsSchema: {
        databaseId: '22222222-2222-4222-8222-222222222222',
        propertyTypes: { Slug: 'rich_text', 'Publish Date': 'date', Tags: 'multi_select', Status: 'select' },
        optionNames: { Status: ['Draft', 'Published'] },
      },
      resolvedAt: Date.now(),
    },
  });
  return env;
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
  test('blocks GitHub connection until Notion schema validation has completed', async () => {
    const env = await githubEnv(new MemoryKV(), new MemoryQueue<ProvisioningMessage>(), false);

    const response = await route(new Request('https://example.com/connect/github?job_id=job-123'), env);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'notion_template_not_validated',
      message: 'Connect Notion and complete the Pages and Posts database check before connecting GitHub.',
    });
  });

  test('rechecks the validated schema before exchanging the GitHub code', async () => {
    const kv = new MemoryKV();
    const env = await githubEnv(kv);
    const { state } = await getInstallState(env);
    await kv.put('notion:template-resolution:job-123', JSON.stringify({ version: 1, jobId: 'job-123' }));
    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = (async () => {
      providerCalls += 1;
      throw new Error('GitHub must not be contacted');
    }) as typeof fetch;

    try {
      const response = await route(
        new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(state)}&code=one-time-code`),
        env,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'notion_template_not_validated',
        message: 'Connect Notion and complete the Pages and Posts database check before connecting GitHub.',
      });
      expect(providerCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('creates a signed, expiring install URL bound to the onboarding job', async () => {
    const kv = new MemoryKV();
    const env = await githubEnv(kv);
    const { state, jobId } = await getInstallState(env);

    expect(state.split('.')).toHaveLength(2);
    expect(state).not.toContain(jobId);
    expect(kv.entries().join('\n')).not.toContain('client-secret');
  });

  test('generates the repository from the template, queues the rest of provisioning, and records only non-secret identity', async () => {
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
      expect(callback.status).toBe(202);
      expect(await callback.json()).toEqual({
        ok: true,
        status: 'provisioning',
        job_id: 'job-123',
        installation_id: 123,
        github: { id: 42, login: 'alice' },
        repository: {
          name: 'alice.github.io',
          url: 'https://alice.github.io',
          baseurl: '',
          id: 1001,
          html_url: 'https://github.com/alice/alice.github.io',
          default_branch: 'main',
        },
      });
      expect(generateBodies).toEqual([{
        name: 'alice.github.io',
        description: 'Notion-powered site published with InkDrafts',
        private: false,
        include_all_branches: false,
      }]);

      // The rest of provisioning (Pages, config, sync, deploy) is now the
      // durable queue's job, not this request's — see the "provisioning
      // queue" describe block for those steps.
      expect(queue.sent).toEqual([{ jobId: 'job-123' }]);

      const stored = await kv.get<ProvisioningJob>('github:onboarding-job:job-123', 'json');
      expect(stored?.status).toBe('queued');
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

  test('records an enqueue failure on the job instead of leaving it queued forever', async () => {
    class FailingQueue {
      readonly sent: unknown[] = [];
      async send(): Promise<void> {
        throw new Error('queue unavailable');
      }
      async sendBatch(): Promise<void> {
        throw new Error('MemoryQueue.sendBatch is not used by this project');
      }
    }
    const kv = new MemoryKV();
    const queue = new FailingQueue();
    const env = await githubEnv(kv, queue as unknown as MemoryQueue<ProvisioningMessage>);
    const { state } = await getInstallState(env);
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input, init) => {
      const request = new Request(input, init);
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
        return Response.json([]);
      }
      if (request.url === 'https://api.github.com/repos/inkdrafts/notiongit-template/commits/main') {
        return Response.json({ sha: 'template-head-sha', commit: { tree: { sha: 'template-tree-sha' } } });
      }
      if (request.url === 'https://api.github.com/repos/inkdrafts/notiongit-template/generate') {
        return Response.json(generatedRepositoryBody('alice.github.io'), { status: 201 });
      }
      throw new Error(`unexpected URL: ${request.url}`);
    }) as typeof fetch;

    try {
      const callback = await route(
        new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(state)}&code=one-time-code&installation_id=123&setup_action=install`),
        env,
      );
      expect(callback.status).toBe(502);
      expect(await callback.json()).toEqual({ error: 'github_authorization_unavailable' });

      // The durable record must not sit `queued` with no message and no
      // trace of why: the enqueue failure is marked on the job itself.
      const stored = await kv.get<ProvisioningJob>('github:onboarding-job:job-123', 'json');
      expect(stored?.status).toBe('dead_letter');
      expect(stored?.completedAt).not.toBeNull();
      expect(stored?.steps.verify_repository.status).toBe('failed');
      expect(stored?.steps.verify_repository.lastError).toEqual({
        code: 'provisioning_enqueue_failed',
        retryable: false,
      });
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
      expect(callback.status).toBe(202);
      expect(calls).toBe(7);
      expect(queue.sent).toEqual([{ jobId: 'job-123' }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('reuses an already-generated repository instead of creating a duplicate', async () => {
    const { response, requests, kv } = await runProvisioningCallback({
      owned: [generatedRepositoryBody('alice.github.io')],
    });

    expect(response.status).toBe(202);
    const body = await response.json() as Record<string, any>;
    expect(body.repository).toMatchObject({ name: 'alice.github.io', id: 1001 });
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

    expect(response.status).toBe(202);
    expect(generateNames).toEqual(['alice.github.io']);
    const body = await response.json() as Record<string, any>;
    expect(body.repository).toMatchObject({ name: 'alice.github.io' });

    const stored = await kv.get<ProvisioningJob>('github:onboarding-job:job-123', 'json');
    expect(stored?.data.generatedRepository).toMatchObject({ reused: true });
  });

  test('advances to the next deterministic name when a foreign repository holds the first', async () => {
    const { response, generateNames } = await runProvisioningCallback({
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

    expect(response.status).toBe(202);
    expect(generateNames).toEqual(['alice.github.io', 'alice-inkdrafts']);
    const body = await response.json() as Record<string, any>;
    expect(body.repository).toMatchObject({
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
    await saveProvisioningJob(env.JOBS as unknown as KVNamespace, job);

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
