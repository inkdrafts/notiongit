import { describe, expect, test } from 'bun:test';

import { userCopy, type ProvisioningFailureCode } from '../src/failures';

/** Consent-handoff failures render the shared HTML error page; assert the
 * status, the visible machine code, and the registry's canonical copy. */
async function expectErrorPage(response: Response, status: number, code: ProvisioningFailureCode): Promise<string> {
  expect(response.status).toBe(status);
  const text = await response.text();
  expect(response.headers.get('content-type')).toContain('text/html');
  expect(text).toContain(`Error code: <code>${code}</code>`);
  expect(text).toContain(userCopy(code).message);
  return text;
}


import {
  createProvisioningJob,
  NOTION_STATE_COOKIE,
  NOTION_STATE_PREFIX,
  route,
  saveProvisioningJob,
  type Env,
  type NotionOAuthContinuation,
} from '../src/index';

class MemoryKV {
  private values = new Map<string, string>();
  readonly puts: Array<{ key: string; value: string; ttl?: number }> = [];

  async get<T>(key: string, type?: string): Promise<T | string | null> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) as T : value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.values.set(key, value);
    this.puts.push({ key, value, ttl: options?.expirationTtl });
  }

  statePut(): { key: string; value: string; ttl?: number } {
    return this.puts.find((put) => put.key.startsWith(NOTION_STATE_PREFIX))!;
  }
}

function env(kv = new MemoryKV()): Partial<Env> {
  return {
    JOBS: kv as unknown as KVNamespace,
    NOTION_CLIENT_ID: 'notion-client-id',
    NOTION_CLIENT_SECRET: 'notion-client-secret',
  };
}

/** Notion authorization only starts for a job the GitHub callback created. */
async function saveJob(kv: MemoryKV): Promise<void> {
  await saveProvisioningJob(kv as unknown as KVNamespace, createProvisioningJob({
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
      templateHeadSha: 'template-head-sha',
      templateHeadTreeSha: 'template-tree-sha',
      headSha: null,
      headTreeSha: null,
      reused: false,
    },
    now: 1_000,
  }));
}

async function start(kv = new MemoryKV()) {
  await saveJob(kv);
  const response = await route(
    new Request('https://staging.example/connect/notion?job_id=job-123'),
    env(kv),
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!);
  const cookie = response.headers.get('set-cookie')!.split(';', 1)[0];
  return { response, location, cookie, kv };
}

function callbackUrl(location: URL, cookie: string, params: string): Request {
  return new Request(`https://staging.example/auth/notion/callback?state=${encodeURIComponent(location.searchParams.get('state')!)}&${params}`, {
    headers: { Cookie: cookie },
  });
}

const TOKEN_RESPONSE = {
  access_token: 'synthetic-access-token',
  token_type: 'bearer',
  refresh_token: 'synthetic-refresh-token',
  bot_id: 'synthetic-bot-id',
  workspace_id: 'synthetic-workspace-id',
  duplicated_template_id: 'synthetic-duplicated-root-id',
};

describe('Notion OAuth', () => {
  test('builds an environment-specific authorize URL and stores only signed state metadata', async () => {
    const { location, cookie, kv } = await start();

    expect(location.origin).toBe('https://api.notion.com');
    expect(location.pathname).toBe('/v1/oauth/authorize');
    expect(location.searchParams.get('owner')).toBe('user');
    expect(location.searchParams.get('client_id')).toBe('notion-client-id');
    expect(location.searchParams.get('redirect_uri')).toBe('https://staging.example/auth/notion/callback');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('state')).toContain('.');
    expect(cookie.startsWith(`${NOTION_STATE_COOKIE}=`)).toBe(true);
    const statePut = kv.statePut();
    expect(statePut.key.startsWith(NOTION_STATE_PREFIX)).toBe(true);
    expect(statePut.value).not.toContain('access_token');
    expect(statePut.value).not.toContain('workspace');
  });

  test('exchanges the code server-side and passes a redacted continuation', async () => {
    const { location, cookie, kv } = await start();
    let continuation: unknown;
    const requests: Request[] = [];

    const response = await route(
      callbackUrl(location, cookie, 'code=synthetic-code'),
      env(kv),
      {
        fetcher: async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          return Response.json(TOKEN_RESPONSE);
        },
        continueOnboarding: (value) => { continuation = value; },
      },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://staging.example/progress?job_id=job-123');
    expect(response.headers.get('set-cookie')).toContain(`${NOTION_STATE_COOKIE}=`);
    // The continuation hands the token over as a self-redacting Secret; the
    // value is only readable through the explicit raw unwrap.
    const handed = continuation as NotionOAuthContinuation;
    expect(handed.jobId).toBe('job-123');
    expect(handed.accessToken.kind).toBe('notion-user-access');
    expect(handed.accessToken.raw).toBe('synthetic-access-token');
    expect(handed.duplicatedTemplateId).toBe('synthetic-duplicated-root-id');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.notion.com/v1/oauth/token');
    expect(requests[0].headers.get('notion-version')).toBe('2022-06-28');
    expect(requests[0].headers.get('authorization')).toMatch(/^Basic /u);
    expect(await requests[0].json()).toEqual({
      grant_type: 'authorization_code',
      code: 'synthetic-code',
      redirect_uri: 'https://staging.example/auth/notion/callback',
    });
    expect(kv.puts.map((put) => put.value).join('\n')).not.toContain('synthetic-access-token');
    expect(kv.puts.map((put) => put.value).join('\n')).not.toContain('synthetic-duplicated-root-id');
  });

  test('rejects missing, tampered, and replayed state', async () => {
    const { location, cookie, kv } = await start();
    const missing = await route(new Request('https://staging.example/auth/notion/callback?code=x'), env(kv));
    await expectErrorPage(missing, 400, 'notion_state_missing');

    const tamperedState = `${location.searchParams.get('state')}x`;
    const tampered = await route(
      new Request(`https://staging.example/auth/notion/callback?state=${encodeURIComponent(tamperedState)}&code=x`, { headers: { Cookie: cookie } }),
      env(kv),
    );
    await expectErrorPage(tampered, 400, 'notion_state_invalid');

    const success = await route(
      callbackUrl(location, cookie, 'error=access_denied'),
      env(kv),
    );
    await expectErrorPage(success, 400, 'notion_authorization_denied');

    const replay = await route(
      callbackUrl(location, cookie, 'code=x'),
      env(kv),
    );
    await expectErrorPage(replay, 400, 'notion_state_replayed');
  });

  test('rejects an expired state record before calling Notion', async () => {
    const { location, cookie, kv } = await start();
    const statePut = kv.statePut();
    const stored = JSON.parse(statePut.value) as Record<string, unknown>;
    stored.expiresAt = 1;
    await kv.put(statePut.key, JSON.stringify(stored));

    const response = await route(
      callbackUrl(location, cookie, 'code=x'),
      env(kv),
      { fetcher: async () => { throw new Error('Notion must not be called'); } },
    );
    await expectErrorPage(response, 400, 'notion_state_expired');
  });

  test('rejects a callback from a different browser flow', async () => {
    const { location, kv } = await start();
    const response = await route(
      new Request(`https://staging.example/auth/notion/callback?state=${encodeURIComponent(location.searchParams.get('state')!)}&code=x`),
      env(kv),
    );
    await expectErrorPage(response, 400, 'notion_state_invalid');
  });

  test('does not echo provider errors or credentials', async () => {
    const { location, cookie, kv } = await start();
    const response = await route(
      callbackUrl(location, cookie, 'code=secret-one-time-code'),
      env(kv),
      {
        fetcher: async () => Response.json({
          error: 'invalid_grant',
          access_token: 'provider-token-that-must-not-leak',
          workspace_id: 'private-workspace-id',
        }, { status: 400 }),
      },
    );
    const body = await expectErrorPage(response, 400, 'notion_authorization_failed');
    expect(body).not.toContain('secret-one-time-code');
    expect(body).not.toContain('provider-token-that-must-not-leak');
    expect(body).not.toContain('private-workspace-id');
  });

  test('accepts a manual-page authorization without a duplicated template', async () => {
    const { location, cookie, kv } = await start();
    let duplicate: string | null | undefined;
    const response = await route(
      callbackUrl(location, cookie, 'code=synthetic-code'),
      env(kv),
      {
        fetcher: async () => Response.json({
          ...TOKEN_RESPONSE,
          duplicated_template_id: null,
        }),
        continueOnboarding: ({ duplicatedTemplateId }) => { duplicate = duplicatedTemplateId; },
      },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://staging.example/progress?job_id=job-123');
    expect(duplicate).toBeNull();
  });
});
