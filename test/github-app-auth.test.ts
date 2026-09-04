import { describe, expect, test } from 'bun:test';

import { GithubAppAuthError, listInstallationRepositories } from '../src/github-app-auth';

const INSTALLATION_TOKEN = 'installation-token';

function response(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function repositories(count: number, firstId: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    id: firstId + index,
    name: `repo-${firstId + index}`,
    full_name: `alice/repo-${firstId + index}`,
    html_url: `https://github.com/alice/repo-${firstId + index}`,
    default_branch: 'main',
    description: null,
    fork: false,
  }));
}

describe('listInstallationRepositories', () => {
  test('lists one short page and stops there', async () => {
    let calls = 0;
    const summaries = await listInstallationRepositories(INSTALLATION_TOKEN, async (input, init) => {
      const request = new Request(input, init);
      calls += 1;
      expect(request.url).toBe('https://api.github.com/installation/repositories?per_page=100&page=1');
      expect(request.headers.get('authorization')).toBe(`Bearer ${INSTALLATION_TOKEN}`);
      return response(200, { total_count: 2, repositories: repositories(2, 1) });
    });
    expect(calls).toBe(1);
    expect(summaries.map((repository) => repository.name)).toEqual(['repo-1', 'repo-2']);
  });

  test('pages until a short page arrives', async () => {
    const pages: number[] = [];
    const summaries = await listInstallationRepositories(INSTALLATION_TOKEN, async (input) => {
      const page = Number(new URL(String(input)).searchParams.get('page'));
      pages.push(page);
      return page < 3
        ? response(200, { repositories: repositories(100, (page - 1) * 100 + 1) })
        : response(200, { repositories: repositories(20, 201) });
    });
    expect(pages).toEqual([1, 2, 3]);
    expect(summaries).toHaveLength(220);
  });

  test('caps the listing at five pages of 100', async () => {
    let calls = 0;
    const summaries = await listInstallationRepositories(INSTALLATION_TOKEN, async () => {
      calls += 1;
      return response(200, { repositories: repositories(100, calls * 100) });
    });
    expect(calls).toBe(5);
    expect(summaries).toHaveLength(500);
  });

  test('keeps entries without the needed fields out of the result', async () => {
    const summaries = await listInstallationRepositories(INSTALLATION_TOKEN, async () =>
      response(200, { repositories: [{ id: 1 }, { name: 'kept', full_name: 'alice/kept' }] }));
    expect(summaries).toHaveLength(1);
    expect(summaries[0].name).toBe('kept');
  });

  test('reports rate limits, absence, and unreadable bodies distinctly', async () => {
    await expect(listInstallationRepositories(INSTALLATION_TOKEN, async () =>
      response(429, {}, { 'retry-after': '30' }))).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 30,
    });
    await expect(listInstallationRepositories(INSTALLATION_TOKEN, async () => response(404)))
      .rejects.toMatchObject({ status: 404 });
    await expect(listInstallationRepositories(INSTALLATION_TOKEN, async () => response(200, {})))
      .rejects.toMatchObject({ status: 502 });
  });
});
