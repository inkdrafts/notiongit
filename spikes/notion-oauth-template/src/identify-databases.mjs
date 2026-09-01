// Identify which child database under a duplicated template page is the
// InkDrafts "Pages" database and which is the "Posts" database, using each
// database's property schema (name + Notion property type) rather than its
// human-editable title. Titles are the first thing a user renames; schemas
// are not exposed for casual editing and are what the sync engine actually
// depends on.
//
// Input shape matches `GET /v1/databases/{database_id}` responses: an object
// with a `properties` map keyed by property name, each value carrying a
// `type` discriminator (https://developers.notion.com/reference/property-object).
//
// As of Notion API version 2025-09-03, `properties` moved off this response
// onto a separate `GET /v1/data_sources/{data_source_id}` object (reachable
// via the database's new `data_sources` array) — see ADR 0002. This module
// intentionally targets the pre-split shape: the provisioning backend pins
// an explicit `Notion-Version` header older than 2025-09-03 on every
// request, which Notion documents as continuing to work indefinitely for a
// database with a single data source — true for every database InkDrafts's
// own template creates. If a future migration moves the backend onto a
// newer `Notion-Version`, this module must first resolve
// `data_sources[0].id` and read `properties` from THAT object instead.

export const PAGES_FINGERPRINT = {
  name: 'pages',
  required: {
    Slug: 'rich_text',
    Type: 'select',
    'Nav Order': 'number',
    'Show in Nav': 'checkbox',
    Status: 'select',
  },
};

export const POSTS_FINGERPRINT = {
  name: 'posts',
  required: {
    Slug: 'rich_text',
    'Publish Date': 'date',
    Tags: 'multi_select',
    Status: 'select',
  },
};

const FINGERPRINTS = [PAGES_FINGERPRINT, POSTS_FINGERPRINT];

// Fraction of a fingerprint's required properties that must match by both
// name and type before we call it a match. Chosen so that Status/Slug
// overlap between the two schemas (both real, both intentional) can never by
// itself produce a match: Pages needs 5 hits, Posts needs 4, and the two
// schemas only share 2 property names.
const MATCH_THRESHOLD = 0.8;

function scoreFingerprint(fingerprint, properties) {
  const requiredEntries = Object.entries(fingerprint.required);
  let hits = 0;
  const missing = [];
  for (const [propName, propType] of requiredEntries) {
    const actual = properties?.[propName];
    if (actual && actual.type === propType) {
      hits += 1;
    } else {
      missing.push({ property: propName, expectedType: propType, actualType: actual?.type ?? null });
    }
  }
  return { score: hits / requiredEntries.length, hits, total: requiredEntries.length, missing };
}

/**
 * @param {{id: string, title?: unknown, properties: Record<string, {type: string}>}} database
 *   A single `retrieve a database` response.
 * @returns {{
 *   databaseId: string,
 *   identity: 'pages' | 'posts' | 'ambiguous' | 'unrecognized',
 *   scores: Record<string, {score: number, hits: number, total: number, missing: Array}>,
 * }}
 */
export function identifyDatabase(database) {
  const scores = {};
  for (const fingerprint of FINGERPRINTS) {
    scores[fingerprint.name] = scoreFingerprint(fingerprint, database.properties ?? {});
  }

  const passing = FINGERPRINTS.filter((fp) => scores[fp.name].score >= MATCH_THRESHOLD);

  let identity;
  if (passing.length === 1) {
    identity = passing[0].name;
  } else if (passing.length > 1) {
    // Never guess between two plausible matches. A production caller must
    // surface this as a validation failure, not silently pick one — see
    // ADR 0002 and issue #8 (schema validation before provisioning).
    identity = 'ambiguous';
  } else {
    identity = 'unrecognized';
  }

  return { databaseId: database.id, identity, scores };
}

/**
 * Resolves a set of child databases (as returned by walking a page's block
 * children and retrieving each `child_database` block's database) into named
 * roles. Throws if resolution is not exactly one Pages database and one
 * Posts database — a template with the wrong shape must fail provisioning
 * loudly rather than sync into the wrong slot.
 *
 * @param {Array<{id: string, properties: Record<string, {type: string}>}>} databases
 */
export function resolveTemplateDatabases(databases) {
  const results = databases.map(identifyDatabase);
  const byIdentity = { pages: [], posts: [], ambiguous: [], unrecognized: [] };
  for (const result of results) byIdentity[result.identity].push(result);

  const problems = [];
  if (byIdentity.pages.length !== 1) {
    problems.push(`expected exactly 1 Pages database, found ${byIdentity.pages.length}`);
  }
  if (byIdentity.posts.length !== 1) {
    problems.push(`expected exactly 1 Posts database, found ${byIdentity.posts.length}`);
  }
  if (byIdentity.ambiguous.length > 0) {
    problems.push(`${byIdentity.ambiguous.length} database(s) matched more than one fingerprint`);
  }

  if (problems.length > 0) {
    const error = new Error(`Cannot resolve template databases: ${problems.join('; ')}`);
    error.results = results;
    throw error;
  }

  return {
    pagesDatabaseId: byIdentity.pages[0].databaseId,
    postsDatabaseId: byIdentity.posts[0].databaseId,
    results,
  };
}
