// Walks from a duplicated template page down to its child databases.
//
// Per https://developers.notion.com/reference/block#child-database, a
// `child_database` block's `id` IS the database id — no separate lookup is
// needed to go from "this page has a child database block" to "here is the
// database_id to pass to retrieve-a-database / query-a-database". Pagination
// follows the standard Notion list shape (`has_more` / `next_cursor`).

/**
 * @param {(cursor: string | null) => Promise<{results: Array<{id: string, type: string}>, has_more: boolean, next_cursor: string | null}>} fetchPage
 *   Fetches one page of `GET /v1/blocks/{block_id}/children`. Injected so this
 *   function has no network dependency and can be exercised against fixtures.
 */
export async function collectChildDatabaseIds(fetchPage) {
  const ids = [];
  let cursor = null;
  do {
    const page = await fetchPage(cursor);
    for (const block of page.results) {
      if (block.type === 'child_database') ids.push(block.id);
    }
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return ids;
}
