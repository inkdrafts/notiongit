import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { identifyDatabase, resolveTemplateDatabases } from '../src/identify-databases.mjs';

async function loadFixture(name) {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8'));
}

test('identifies the Pages database by schema even when the title has been renamed', async () => {
  const pagesDb = await loadFixture('pages-database.json');
  const result = identifyDatabase(pagesDb);
  assert.equal(result.identity, 'pages');
  assert.equal(result.scores.pages.score, 1);
});

test('identifies the Posts database by schema even with a default "Untitled" title', async () => {
  const postsDb = await loadFixture('posts-database.json');
  const result = identifyDatabase(postsDb);
  assert.equal(result.identity, 'posts');
  assert.equal(result.scores.posts.score, 1);
});

test('an unrelated database (e.g. a personal grocery list also in the workspace) is unrecognized, not misclassified', async () => {
  const unrelated = await loadFixture('unrelated-database.json');
  const result = identifyDatabase(unrelated);
  assert.equal(result.identity, 'unrecognized');
  assert.ok(result.scores.pages.score < 0.8);
  assert.ok(result.scores.posts.score < 0.8);
});

test('resolveTemplateDatabases returns both IDs when exactly one of each is present', async () => {
  const pagesDb = await loadFixture('pages-database.json');
  const postsDb = await loadFixture('posts-database.json');
  const resolved = resolveTemplateDatabases([postsDb, pagesDb]);
  assert.equal(resolved.pagesDatabaseId, pagesDb.id);
  assert.equal(resolved.postsDatabaseId, postsDb.id);
});

test('resolveTemplateDatabases throws rather than guessing when a database is missing', async () => {
  const pagesDb = await loadFixture('pages-database.json');
  assert.throws(
    () => resolveTemplateDatabases([pagesDb]),
    /expected exactly 1 Posts database, found 0/,
  );
});

test('resolveTemplateDatabases throws rather than guessing when duplicates are present', async () => {
  const pagesDb = await loadFixture('pages-database.json');
  const postsDb = await loadFixture('posts-database.json');
  assert.throws(
    () => resolveTemplateDatabases([pagesDb, pagesDb, postsDb]),
    /expected exactly 1 Pages database, found 2/,
  );
});

test('a hand-authored database that only overlaps on the two shared property names (Slug, Status) never matches either fingerprint', async () => {
  // Regression guard for the MATCH_THRESHOLD in src/identify-databases.mjs:
  // Pages and Posts intentionally share "Slug" (rich_text) and "Status"
  // (select) property names. A database that has only those two, plus
  // unrelated properties, must not be misidentified as either.
  const decoy = {
    id: 'SYNTHETIC-decoy-00000000-0000-0000-0000-000000000004',
    properties: {
      Slug: { type: 'rich_text' },
      Status: { type: 'select' },
      Notes: { type: 'rich_text' },
    },
  };
  const result = identifyDatabase(decoy);
  assert.equal(result.identity, 'unrecognized');
});
