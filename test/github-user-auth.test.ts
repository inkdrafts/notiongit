import { afterEach, describe, expect, test } from 'bun:test';

import {
  exchangeGithubCode,
  findInstallationRecord,
  findUserInstallation,
  getAuthenticatedGithubUser,
  GithubApiError,
} from '../src/github-user-auth';

type FetchCall = { url: string; userAgent: string | null; authorization: string | null };

const realFetch = globalThis.fetch;
const calls: FetchCall[] = [];
let responder: (url: string) => Response = () => response(200, {});

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function installFetchStub(): void {
  calls.length = 0;
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const request = new Request(input as RequestInfo, init as RequestInit);
    calls.push({
      url: request.url,
      userAgent: request.headers.get('user-agent'),
      authorization: request.headers.get('authorization'),
    });
    return responder(request.url);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const INSTALLATION = {
  id: 159561063,
  app_id: 4798518,
  account: { id: 95985935, login: 'USER', type: 'User' },
  suspended_at: null,
  suspended_by: null,
};

describe('github-user-auth provider calls', () => {
  test('every api.github.com call carries a User-Agent (workerd sends none; GitHub 403s without one)', async () => {
    installFetchStub();
    responder = (url) =>
      url.endsWith('/user')
        ? response(200, { id: 95985935, login: 'USER', type: 'User' })
        : response(200, { installations: [INSTALLATION] });
    const user = await getAuthenticatedGithubUser('Bearer token');
    expect(user.login).toBe('USER');
    await findUserInstallation('Bearer token', '4798518');
    await findInstallationRecord('Bearer token', '4798518', 159561063);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call.userAgent).toBe('InkDrafts (https://github.com/inkdrafts/notiongit)');
    }
  });

  test('findInstallationRecord reads the installation from the list endpoint, not the per-id endpoint', async () => {
    installFetchStub();
    responder = () => response(200, { installations: [INSTALLATION] });
    const record = await findInstallationRecord('Bearer token', '4798518', 159561063);
    expect(record.id).toBe(159561063);
    expect(record.account?.login).toBe('USER');
    for (const call of calls) {
      expect(call.url).toBe('https://api.github.com/user/installations');
      expect(call.url).not.toContain('/user/installations/159561063');
    }
  });

  test('findInstallationRecord 404s when the id is absent from the list (GitHub 404s the per-id endpoint instead)', async () => {
    installFetchStub();
    responder = () => response(200, { installations: [INSTALLATION] });
    let thrown: unknown;
    try {
      await findInstallationRecord('Bearer token', '4798518', 999999);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GithubApiError);
    expect((thrown as GithubApiError).status).toBe(404);
  });

  test('findUserInstallation prefers the installation owned by the authenticated account', async () => {
    installFetchStub();
    responder = () =>
      response(200, {
        installations: [
          { ...INSTALLATION, id: 222, account: { id: 555, login: 'ORG', type: 'Organization' } },
          INSTALLATION,
        ],
      });
    const record = await findUserInstallation('Bearer token', '4798518', 95985935);
    expect(record.id).toBe(159561063);
  });

  test('exchangeGithubCode maps GitHub 200-with-error-body rejections to 401, not the transport status', async () => {
    installFetchStub();
    responder = () => response(200, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' });
    let thrown: unknown;
    try {
      await exchangeGithubCode('code', { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'secret' }, 'https://inkdrafts.com/auth/github/callback');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GithubApiError);
    expect((thrown as GithubApiError).status).toBe(401);
    expect(calls[0]?.url).toBe('https://github.com/login/oauth/access_token');
    expect(calls[0]?.userAgent).toBe('InkDrafts (https://github.com/inkdrafts/notiongit)');
  });
});
