import { expect, test } from 'bun:test';

/**
 * Read-only acceptance check for the development repository. Set both
 * variables when running it; the token is never printed or persisted.
 *
 *   GITHUB_PAGES_INTEGRATION_REPOSITORY=OWNER/REPO \
 *   GITHUB_PAGES_INTEGRATION_TOKEN=... \
 *   bun test test/github-pages.integration.test.ts
 */
const repository = process.env.GITHUB_PAGES_INTEGRATION_REPOSITORY;
const token = process.env.GITHUB_PAGES_INTEGRATION_TOKEN;

test.skipIf(!repository || !token)('development repository reports legacy Pages from main:/', async () => {
  const response = await fetch(`https://api.github.com/repos/${repository}/pages`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  expect(response.status).toBe(200);
  const body = await response.json() as {
    build_type?: string;
    source?: { branch?: string; path?: string };
  };
  if (body.build_type !== undefined) expect(body.build_type).toBe('legacy');
  expect(body.source).toEqual({ branch: 'main', path: '/' });
});
