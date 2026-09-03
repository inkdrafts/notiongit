import { describe, expect, test } from 'bun:test';

import {
  CONFIG_PATCH_COMMIT_MESSAGE,
  GithubConfigError,
  patchRepositoryConfig,
} from '../src/repository-config';
import { repositoryDestination } from '../src/repository-naming';

const TOKEN = 'installation-token';

function encode(content: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(content)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decode(content: string): string {
  const binary = atob(content);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function fileResponse(content: string, sha: string): Response {
  return Response.json({ type: 'file', encoding: 'base64', content: encode(content), sha });
}

const ORIGINAL_CONFIG = `# Keep this comment and ordering.
title: "A user's title"
url: ""
baseurl: '' # deployment-owned value

author:
  name: "A user's name"
custom_key: true
`;

describe('patchRepositoryConfig', () => {
  test.each([
    ['apex', repositoryDestination('Alice', 'alice.github.io'), 'https://alice.github.io', ''],
    ['project', repositoryDestination('Alice', 'alice-inkdrafts'), 'https://alice.github.io/alice-inkdrafts', '/alice-inkdrafts'],
  ])('patches %s URL values while preserving unrelated YAML', async (_kind, destination, expectedUrl, expectedBaseurl) => {
    const requests: Request[] = [];
    let putBody: { message: string; content: string; sha: string; branch: string } | undefined;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === 'GET') return fileResponse(ORIGINAL_CONFIG, 'old-sha');
      putBody = await request.json() as typeof putBody;
      return Response.json({ content: { sha: 'new-sha' }, commit: { sha: 'new-commit' } });
    };

    const result = await patchRepositoryConfig(TOKEN, 'alice/alice-inkdrafts', destination, { fetcher });
    expect(result).toEqual({ changed: true, contentSha: 'new-sha', commitSha: 'new-commit' });
    expect(putBody).toMatchObject({
      message: CONFIG_PATCH_COMMIT_MESSAGE,
      sha: 'old-sha',
      branch: 'main',
    });
    const patched = decode(putBody!.content);
    expect(patched).toContain(`url: "${expectedUrl}"`);
    expect(patched).toContain(expectedBaseurl === ''
      ? "baseurl: '' # deployment-owned value"
      : `baseurl: "${expectedBaseurl}" # deployment-owned value`);
    expect(patched).toContain('# Keep this comment and ordering.');
    expect(patched).toContain('title: "A user\'s title"');
    expect(patched).toContain('custom_key: true');
    expect(requests).toHaveLength(2);
    expect(requests[0].headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(requests[0].url).toBe('https://api.github.com/repos/alice/alice-inkdrafts/contents/_config.yml?ref=main');
  });

  test('does not create a commit when both owned values already match', async () => {
    let calls = 0;
    const current = `title: "Preserve me"\nurl: https://alice.github.io\nbaseurl: \"\"\n`;
    const result = await patchRepositoryConfig(
      TOKEN,
      'alice/alice.github.io',
      repositoryDestination('alice', 'alice.github.io'),
      {
        fetcher: async (_input, init) => {
          calls += 1;
          expect(new Request(_input, init).method).toBe('GET');
          return fileResponse(current, 'already-configured-sha');
        },
      },
    );

    expect(result).toEqual({ changed: false, contentSha: 'already-configured-sha', commitSha: null });
    expect(calls).toBe(1);
  });

  test('rereads after a SHA conflict and preserves a concurrent unrelated edit', async () => {
    const concurrentConfig = `# Keep this comment.\ntitle: "Edited by the user"\nurl: "https://old.example"\nbaseurl: ""\ncustom_key: keep\n`;
    let reads = 0;
    const putBodies: Array<{ content: string; sha: string }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      if (request.method === 'GET') {
        reads += 1;
        return reads === 1 ? fileResponse(ORIGINAL_CONFIG, 'first-sha') : fileResponse(concurrentConfig, 'second-sha');
      }
      const body = await request.json() as { content: string; sha: string };
      putBodies.push(body);
      return putBodies.length === 1
        ? new Response('{}', { status: 409 })
        : Response.json({ content: { sha: 'final-sha' }, commit: { sha: 'final-commit' } });
    };

    const result = await patchRepositoryConfig(
      TOKEN,
      'alice/alice.github.io',
      repositoryDestination('alice', 'alice.github.io'),
      { fetcher },
    );

    expect(result).toEqual({ changed: true, contentSha: 'final-sha', commitSha: 'final-commit' });
    expect(putBodies.map((body) => body.sha)).toEqual(['first-sha', 'second-sha']);
    expect(decode(putBodies[1].content)).toContain('title: "Edited by the user"');
    expect(decode(putBodies[1].content)).toContain('custom_key: keep');
    expect(decode(putBodies[1].content)).toContain('url: "https://alice.github.io"');
  });

  test('returns a distinct conflict after bounded retries', async () => {
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      return request.method === 'GET'
        ? fileResponse(ORIGINAL_CONFIG, crypto.randomUUID())
        : new Response('{}', { status: 409 });
    };

    await expect(patchRepositoryConfig(
      TOKEN,
      'alice/alice.github.io',
      repositoryDestination('alice', 'alice.github.io'),
      { fetcher, maxAttempts: 2 },
    )).rejects.toMatchObject({
      code: 'github_config_conflict',
      status: 409,
    } satisfies Partial<GithubConfigError>);
  });
});
