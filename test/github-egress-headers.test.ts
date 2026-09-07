import { afterEach, describe, expect, test } from 'bun:test';

import { getGithubActionsPublicKey } from '../src/actions-secrets';
import { getGithubPagesSite } from '../src/github-pages';
import { dispatchNotionSyncWorkflow } from '../src/notion-sync';
import { patchRepositoryConfig } from '../src/repository-config';
import { getRepositoryMainHeadSha } from '../src/site-deployment';

type FetchCall = { url: string; userAgent: string | null };

const realFetch = globalThis.fetch;
const calls: FetchCall[] = [];
let responder: (url: string) => Response = () => new Response(null, { status: 204 });

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function installFetchStub(): void {
  calls.length = 0;
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const request = new Request(input as RequestInfo, init as RequestInit);
    calls.push({ url: request.url, userAgent: request.headers.get('user-agent') });
    return responder(request.url);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

const REPO = 'alice/alice.github.io';
const UA = 'InkDrafts (https://github.com/inkdrafts/notiongit)';

describe('provisioning-leg provider calls', () => {
  test('every api.github.com call carries a User-Agent (workerd sends none; GitHub 403s without one)', async () => {
    installFetchStub();

    const key = Uint8Array.from({ length: 32 }, (_, i) => i);
    const publicKey = btoa(String.fromCharCode(...key));
    responder = (url) => {
      if (url.endsWith('/actions/secrets/public-key')) return response(200, { key_id: 'k1', key: publicKey });
      if (url.endsWith('/commits/main')) return response(200, { sha: 'head-sha' });
      if (url.endsWith('/dispatches')) return new Response(null, { status: 204 });
      if (url.endsWith('/pages')) return response(200, { status: 'built', html_url: `https://alice.github.io/${REPO}/` });
      if (url.includes('/contents/')) return response(404, { message: 'Not Found' });
      return response(200, {});
    };

    const publicKeyResult = await getGithubActionsPublicKey('tok', REPO);
    expect(publicKeyResult.keyId).toBe('k1');
    await dispatchNotionSyncWorkflow('tok', REPO);
    await getGithubPagesSite('tok', REPO);
    await getRepositoryMainHeadSha('tok', REPO);
    // The config patch's first request is a read; a 404 there aborts the
    // patch, but the outgoing request is still recorded and pinned.
    let patchFailed = false;
    await patchRepositoryConfig('tok', REPO, { url: 'https://alice.github.io/', baseurl: 'https://alice.github.io' })
      .catch(() => {
        patchFailed = true;
      });
    expect(patchFailed).toBe(true);

    const touched = calls.filter((call) => call.url.startsWith('https://api.github.com'));
    expect(touched.length).toBeGreaterThanOrEqual(5);
    const withoutAgent = touched.filter((call) => call.userAgent !== UA);
    expect(withoutAgent).toEqual([]);
  });
});
