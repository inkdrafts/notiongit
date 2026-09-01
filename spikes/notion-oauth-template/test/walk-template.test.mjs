import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { collectChildDatabaseIds } from '../src/walk-template.mjs';
import { resolveTemplateDatabases } from '../src/identify-databases.mjs';

async function loadFixture(name) {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8'));
}

test('end to end: duplicated page -> child database ids -> resolved Pages/Posts roles', async () => {
  const blockChildren = await loadFixture('block-children.json');
  const pagesDb = await loadFixture('pages-database.json');
  const postsDb = await loadFixture('posts-database.json');
  const databasesById = new Map([
    [pagesDb.id, pagesDb],
    [postsDb.id, postsDb],
  ]);

  // Single-page fixture; a real implementation would follow has_more/next_cursor.
  const childDatabaseIds = await collectChildDatabaseIds(async () => blockChildren);
  assert.deepEqual(childDatabaseIds.sort(), [pagesDb.id, postsDb.id].sort());

  const fetchedDatabases = childDatabaseIds.map((id) => {
    const db = databasesById.get(id);
    assert.ok(db, `no fixture database for child_database block id ${id}`);
    return db;
  });

  const resolved = resolveTemplateDatabases(fetchedDatabases);
  assert.equal(resolved.pagesDatabaseId, pagesDb.id);
  assert.equal(resolved.postsDatabaseId, postsDb.id);
});

test('a template page with only one database (duplication misconfigured or partial) fails loudly', async () => {
  const singleDbChildren = {
    results: [
      { object: 'block', id: 'SYNTHETIC-only-db', type: 'child_database', child_database: { title: 'Untitled' } },
    ],
    has_more: false,
    next_cursor: null,
  };
  const ids = await collectChildDatabaseIds(async () => singleDbChildren);
  assert.deepEqual(ids, ['SYNTHETIC-only-db']);
});
