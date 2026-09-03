import { describe, expect, test } from 'bun:test';

import { route, type Env } from '../src/index';

class MemoryKV {
  private values = new Map<string, string>();

  async get<T>(key: string, type?: string): Promise<T | string | null> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) as T : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  entries(): string[] {
    return [...this.values.values()];
  }
}

function githubEnv(kv = new MemoryKV()): Partial<Env> {
  return {
    JOBS: kv as unknown as KVNamespace,
    GITHUB_APP_ID: '4798518',
    GITHUB_APP_SLUG: 'inkdrafts',
    GITHUB_APP_PRIVATE_KEY: 'not-used-by-this-test',
    GITHUB_CLIENT_ID: 'client-id',
    GITHUB_CLIENT_SECRET: 'client-secret',
    NOTION_CLIENT_ID: 'not-used',
    NOTION_CLIENT_SECRET: 'not-used',
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
    const response = route(
      new Request('https://example.com/auth/notion/callback?code=redacted'),
    );

    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: 'not_implemented' });
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
    const env = githubEnv(kv);
    const { state, jobId } = await getInstallState(env);

    expect(state.split('.')).toHaveLength(2);
    expect(state).not.toContain(jobId);
    expect(kv.entries().join('\n')).not.toContain('client-secret');
  });

  test('exchanges the code, verifies the user installation, and stores metadata only', async () => {
    const kv = new MemoryKV();
    const env = githubEnv(kv);
    const { state } = await getInstallState(env);
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];

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
      throw new Error(`unexpected URL: ${request.url}`);
    };

    try {
      const callback = await route(
        new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(state)}&code=one-time-code&installation_id=123&setup_action=install`),
        env,
      );
      expect(callback.status).toBe(200);
      expect(await callback.json()).toEqual({
        ok: true,
        job_id: 'job-123',
        installation_id: 123,
        github: { id: 42, login: 'alice' },
      });
      expect(kv.entries().join('\n')).not.toContain('user-token');
      expect(kv.entries().join('\n')).not.toContain('one-time-code');

      const replay = await route(
        new Request(`https://example.com/auth/github/callback?state=${encodeURIComponent(state)}&code=one-time-code&installation_id=123`),
        env,
      );
      expect(replay.status).toBe(400);
      expect(await replay.json()).toEqual({ error: 'github_state_replayed' });
      expect(requests).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('accepts a setup callback before the OAuth callback', async () => {
    const kv = new MemoryKV();
    const env = githubEnv(kv);
    const keyPair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
    const privateKeyDer = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
    let privateKeyBase64 = '';
    for (const byte of privateKeyDer) privateKeyBase64 += String.fromCharCode(byte);
    env.GITHUB_APP_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${btoa(privateKeyBase64)}\n-----END PRIVATE KEY-----`;
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
      expect(callback.status).toBe(200);
      expect(calls).toBe(4);
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
    const env = githubEnv(kv);
    const { state } = await getInstallState(env);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'user-token' });
      if (request.url === 'https://api.github.com/user') return Response.json({ id: 42, login: 'alice', type: 'User' });
      if (request.url === 'https://api.github.com/user/installations/123') return Response.json(installation);
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
    const env = githubEnv();
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
