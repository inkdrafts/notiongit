/**
 * Resolve the duplicated InkDrafts Notion template into its two database IDs.
 *
 * The duplicated root page is identified by the `duplicated_template_id` the
 * OAuth token exchange already handed back; this module walks that page's
 * block children and decides which child database is "Pages" and which is
 * "Posts" by schema fingerprint (required property names *and* Notion
 * property types), never by title — titles are the first thing a user
 * renames (see ADR 0002 and `docs/notion-template.md` §Schema version).
 *
 * Version note (ADR 0002): every request pins `Notion-Version` to the value
 * exported by `notion-oauth.ts` (`2022-06-28`), which predates the
 * database/data-source split, so `GET /v1/databases/{id}` returns
 * `properties` directly. If the backend is ever migrated to a newer
 * `Notion-Version`, this module must first resolve the database's
 * `data_sources[0].id` and read `properties` from that object instead.
 *
 * Secrecy: the Notion access token is used for immediate, request-local calls
 * and is never stored, logged, or included in a result. Database IDs are
 * non-secret provisioning metadata and flow only into the short-lived
 * resolution record and, later, the repository's Actions secrets. Nothing
 * from page content (titles, text, rows) is read or returned.
 */

import { NOTION_API_VERSION } from './notion-oauth';

/** Bumped with the template build sheet when a required property changes. */
export const NOTION_TEMPLATE_SCHEMA_VERSION = 1;

export const PAGES_FINGERPRINT = {
  role: 'pages',
  required: {
    Slug: 'rich_text',
    Type: 'select',
    'Nav Order': 'number',
    'Show in Nav': 'checkbox',
    Status: 'select',
  },
} as const;

export const POSTS_FINGERPRINT = {
  role: 'posts',
  required: {
    Slug: 'rich_text',
    'Publish Date': 'date',
    Tags: 'multi_select',
    Status: 'select',
  },
} as const;

/**
 * The sync engine's complete database contract. The five/four properties in
 * `required` are also the schema fingerprint used to identify each database.
 * The remaining fields are deliberately optional because the engine has a
 * documented fallback when they are absent. An optional field is still
 * checked when present: a wrong Notion type would otherwise become a silent
 * no-op in the first scheduled sync.
 */
export const PAGES_SCHEMA_CONTRACT = {
  required: {
    Slug: { names: ['Slug', 'slug'], types: ['rich_text'] },
    Type: {
      names: ['Type', 'type'],
      types: ['select'],
      options: ['home', 'blog-list', 'blog', 'markdown'],
      allowedOptions: ['home', 'blog-list', 'blog', 'markdown'],
    },
    'Nav Order': { names: ['Nav Order', 'Nav order', 'Order'], types: ['number'] },
    'Show in Nav': { names: ['Show in Nav', 'Show In Nav', 'Nav'], types: ['checkbox'] },
    Status: { names: ['Status'], types: ['select'], options: ['Published'], allowedOptions: ['Draft', 'Published'] },
  },
  optional: {
    Title: { names: ['Title', 'title', 'Name'], types: ['title', 'rich_text'] },
    Description: { names: ['Description', 'Excerpt', 'Summary'], types: ['rich_text'] },
    Name: { names: ['Name', 'Display Name', 'Author Name'], types: ['rich_text'] },
    'Profile Picture': { names: ['Profile Picture', 'Avatar', 'Photo'], types: ['rich_text'] },
    Tagline: { names: ['Tagline', 'Short Bio', 'Subtitle'], types: ['rich_text'] },
    'Social Links': { names: ['Social Links', 'Socials', 'Links'], types: ['rich_text'] },
  },
} as const;

export const POSTS_SCHEMA_CONTRACT = {
  required: {
    Slug: { names: ['Slug', 'slug'], types: ['rich_text'] },
    'Publish Date': { names: ['Publish Date', 'Date', 'Published'], types: ['date'] },
    Tags: { names: ['Tags'], types: ['multi_select'] },
    Status: { names: ['Status'], types: ['select'], options: ['Published'], allowedOptions: ['Draft', 'Published'] },
  },
  optional: {
    Title: { names: ['Title', 'title', 'Name'], types: ['title', 'rich_text'] },
    Description: { names: ['Description', 'Excerpt', 'Summary'], types: ['rich_text'] },
    'Cover Image': { names: ['Cover Image'], types: ['files'] },
    'Canonical URL': { names: ['Canonical URL'], types: ['url'] },
    Featured: { names: ['Featured'], types: ['checkbox'] },
  },
} as const;

const FINGERPRINTS = [PAGES_FINGERPRINT, POSTS_FINGERPRINT] as const;

/**
 * Fraction of a fingerprint's required properties that must match by both
 * name and type before it counts. Chosen so the intentional Slug/Status
 * overlap between the two schemas (2 shared names) can never by itself
 * produce a match: Pages needs 4 of 5, Posts 4 of 4.
 */
const MATCH_THRESHOLD = 0.8;

export const RESOLUTION_MAX_ATTEMPTS = 4;
export const RESOLUTION_INITIAL_DELAY_MS = 500;
export const RESOLUTION_MAX_DELAY_MS = 4_000;

/**
 * The template keeps both databases as direct children of the root, but a
 * user may drag them into a sub-page after duplication; the walk therefore
 * also descends into `child_page` blocks down to this depth (root = depth 0)
 * so nesting never breaks resolution.
 */
export const TEMPLATE_MAX_WALK_DEPTH = 3;
/** Total block-children page fetches allowed per resolution attempt. */
export const TEMPLATE_MAX_BLOCK_PAGE_FETCHES = 25;
/** Upper bound on distinct child databases considered per attempt. */
export const TEMPLATE_MAX_CANDIDATE_DATABASES = 32;

export const NOTION_TEMPLATE_RESOLUTION_PREFIX = 'notion:template-resolution:';
export const NOTION_TEMPLATE_RESOLUTION_TTL_SECONDS = 24 * 60 * 60;

const NOTION_API = 'https://api.notion.com';
const BLOCK_CHILDREN_PAGE_SIZE = 100;

export type TemplateDatabaseRole = 'pages' | 'posts';

/**
 * Non-secret schema snapshot of one matched database: property names/types
 * and select/multi-select option names, enough for issue #8's schema
 * validation and for actionable error messages without a second API pass.
 */
export interface NotionDatabaseSchemaSummary {
  databaseId: string;
  propertyTypes: Record<string, string>;
  optionNames: Record<string, string[]>;
}

export interface NotionTemplateResolution {
  pagesDatabaseId: string;
  postsDatabaseId: string;
  templateSchemaVersion: number;
  /** How many distinct child databases were inspected, for diagnostics only. */
  scannedDatabaseCount: number;
  pagesSchema: NotionDatabaseSchemaSummary;
  postsSchema: NotionDatabaseSchemaSummary;
  resolvedAt: number;
}

export type NotionTemplateErrorCode =
  | 'notion_template_not_duplicated'
  | 'notion_template_root_invalid'
  | 'notion_template_root_unavailable'
  | 'notion_template_root_empty'
  | 'notion_template_database_missing'
  | 'notion_template_database_ambiguous'
  | 'notion_template_schema_invalid'
  | 'notion_template_unavailable';

/** Distinct, actionable failure modes; `details` carries only non-secret schema metadata. */
export class NotionTemplateError extends Error {
  readonly code: NotionTemplateErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | null;

  constructor(code: NotionTemplateErrorCode, status: number, details: Record<string, unknown> | null = null) {
    super(code);
    this.name = 'NotionTemplateError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

interface NotionPropertyShape {
  type?: unknown;
  select?: { options?: Array<{ name?: unknown }> };
  multi_select?: { options?: Array<{ name?: unknown }> };
}

interface NotionDatabaseResponse {
  object?: unknown;
  id?: unknown;
  properties?: Record<string, NotionPropertyShape>;
}

interface NotionBlockShape {
  object?: unknown;
  id?: unknown;
  type?: unknown;
}

interface NotionBlockChildrenResponse {
  results?: NotionBlockShape[];
  has_more?: unknown;
  next_cursor?: unknown;
}

interface NotionGetResult<T> {
  status: number;
  retryAfterSeconds: number | null;
  body: T | null;
}

export interface NotionTemplateResolveOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export type NotionSchemaValidationIssueCode =
  | 'missing_property'
  | 'wrong_property_type'
  | 'unsupported_option';

export interface NotionSchemaValidationIssue {
  code: NotionSchemaValidationIssueCode;
  property: string;
  expectedTypes?: string[];
  actualType?: string | null;
  requiredOptions?: string[];
  unsupportedOptions?: string[];
}

export interface NotionDatabaseSchemaValidation {
  database: TemplateDatabaseRole;
  valid: boolean;
  issues: NotionSchemaValidationIssue[];
  remediation: string;
}

export interface NotionTemplateSchemaValidation {
  valid: boolean;
  pages: NotionDatabaseSchemaValidation;
  posts: NotionDatabaseSchemaValidation;
}

/**
 * Normalized dashed-lowercase Notion UUID, or `null` when the value cannot
 * be one — accepted in either the dashed or the compact 32-hex form.
 */
export function normalizeNotionId(value: string): string | null {
  const compact = value.trim().toLowerCase().replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/u.test(compact)) return null;
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20, 32),
  ].join('-');
}

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function notionGetJson<T>(
  path: string,
  accessToken: string,
  fetcher: typeof fetch,
): Promise<NotionGetResult<T>> {
  let response: Response;
  try {
    response = await fetcher(`${NOTION_API}${path}`, {
      headers: new Headers({
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'Notion-Version': NOTION_API_VERSION,
      }),
    });
  } catch {
    // Network failure: classified by the caller as transient.
    return { status: 0, retryAfterSeconds: null, body: null };
  }
  let body: T | null = null;
  try {
    body = (await response.json()) as T;
  } catch {
    body = null;
  }
  const retryHeader = response.headers.get('retry-after');
  const retryValue = retryHeader === null ? null : Number(retryHeader);
  const retryAfterSeconds =
    retryValue !== null && Number.isSafeInteger(retryValue) && retryValue >= 0 ? retryValue : null;
  return {
    status: response.status,
    retryAfterSeconds,
    body,
  };
}

type WalkResult =
  | { kind: 'ok'; databaseIds: string[]; truncated: boolean }
  | { kind: 'root_missing' }
  | { kind: 'forbidden' }
  | { kind: 'transient'; retryAfterSeconds: number | null };

/**
 * Breadth-first walk from the duplicated root through paginated block
 * children, collecting `child_database` blocks (whose block id *is* the
 * database id per Notion's block reference) and descending into `child_page`
 * blocks within the depth and fetch budgets.
 */
async function walkTemplateDatabaseIds(
  accessToken: string,
  rootId: string,
  fetcher: typeof fetch,
): Promise<WalkResult> {
  const databaseIds: string[] = [];
  const visitedPages = new Set<string>([rootId]);
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  let fetchedPages = 0;

  while (queue.length > 0) {
    const node = queue.shift()!;
    let cursor: string | null = null;
    do {
      if (fetchedPages >= TEMPLATE_MAX_BLOCK_PAGE_FETCHES) {
        return { kind: 'ok', databaseIds, truncated: true };
      }
      fetchedPages += 1;
      // Explicit annotations: inside the do/while back edge, TS cannot infer
      // these without a circularity error.
      const cursorPart: string = cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : '';
      const result: NotionGetResult<NotionBlockChildrenResponse> = await notionGetJson<NotionBlockChildrenResponse>(
        `/v1/blocks/${node.id}/children?page_size=${BLOCK_CHILDREN_PAGE_SIZE}${cursorPart}`,
        accessToken,
        fetcher,
      );
      if (result.status === 404) return { kind: 'root_missing' };
      if (result.status === 401 || result.status === 403) return { kind: 'forbidden' };
      if (result.status === 0 || result.status === 429 || result.status >= 500) {
        return { kind: 'transient', retryAfterSeconds: result.retryAfterSeconds };
      }
      if (result.status !== 200 || !result.body || !Array.isArray(result.body.results)) {
        return { kind: 'transient', retryAfterSeconds: null };
      }
      for (const block of result.body.results) {
        if (typeof block?.id !== 'string' || typeof block.type !== 'string') continue;
        if (block.type === 'child_database') {
          const databaseId = normalizeNotionId(block.id);
          if (databaseId && !databaseIds.includes(databaseId)) databaseIds.push(databaseId);
        } else if (
          block.type === 'child_page' &&
          node.depth + 1 < TEMPLATE_MAX_WALK_DEPTH &&
          !visitedPages.has(block.id)
        ) {
          visitedPages.add(block.id);
          queue.push({ id: normalizeNotionId(block.id) ?? block.id, depth: node.depth + 1 });
        }
      }
      // Notion's list contract: keep following next_cursor while has_more is
      // true; a has_more=true response without a cursor ends the walk rather
      // than looping forever.
      cursor =
        result.body.has_more === true && typeof result.body.next_cursor === 'string'
          ? result.body.next_cursor
          : null;
    } while (cursor);
  }
  return { kind: 'ok', databaseIds, truncated: false };
}

type DatabaseFetchResult =
  | { kind: 'ok'; databaseId: string; database: NotionDatabaseResponse }
  | { kind: 'invisible' }
  | { kind: 'forbidden' };

async function fetchTemplateDatabase(
  databaseId: string,
  accessToken: string,
  fetcher: typeof fetch,
): Promise<DatabaseFetchResult> {
  const result = await notionGetJson<NotionDatabaseResponse>(`/v1/databases/${databaseId}`, accessToken, fetcher);
  if (result.status === 200) {
    // A 200 body without a usable properties map means the API shape changed
    // under us; treating it as an invisible candidate surfaces that as a
    // transient resolution failure instead of a misleading "schema missing".
    if (result.body && typeof result.body.properties === 'object' && result.body.properties !== null) {
      return { kind: 'ok', databaseId, database: result.body };
    }
    return { kind: 'invisible' };
  }
  if (result.status === 404 || result.status === 429 || result.status >= 500 || result.status === 0) {
    return { kind: 'invisible' };
  }
  if (result.status === 401 || result.status === 403) return { kind: 'forbidden' };
  return { kind: 'invisible' };
}

function optionNamesFor(property: NotionPropertyShape): string[] {
  const options = property.type === 'multi_select' ? property.multi_select?.options : property.select?.options;
  if (!Array.isArray(options)) return [];
  return options
    .map((option) => (typeof option?.name === 'string' ? option.name : null))
    .filter((name): name is string => name !== null);
}

function summarizeDatabase(databaseId: string, properties: Record<string, NotionPropertyShape>): NotionDatabaseSchemaSummary {
  const propertyTypes: Record<string, string> = {};
  const optionNames: Record<string, string[]> = {};
  for (const [name, property] of Object.entries(properties)) {
    if (typeof property?.type !== 'string') continue;
    propertyTypes[name] = property.type;
    if (property.type === 'select' || property.type === 'multi_select') {
      optionNames[name] = optionNamesFor(property);
    }
  }
  return { databaseId, propertyTypes, optionNames };
}

type SchemaPropertyContract = {
  names: readonly string[];
  types: readonly string[];
  options?: readonly string[];
  allowedOptions?: readonly string[];
};

function findSchemaProperty(
  summary: NotionDatabaseSchemaSummary,
  contract: SchemaPropertyContract,
): { name: string; type: string } | null {
  for (const name of contract.names) {
    const type = summary.propertyTypes[name];
    if (typeof type === 'string') return { name, type };
  }
  return null;
}

function normalizedOption(role: TemplateDatabaseRole, property: string, option: string): string {
  // The sync engine deliberately accepts page Type values case-insensitively;
  // Status is sent to Notion as an exact query value and remains case-sensitive.
  return role === 'pages' && property === 'Type' ? option.toLowerCase() : option;
}

function validateDatabaseSchema(
  role: TemplateDatabaseRole,
  summary: NotionDatabaseSchemaSummary,
  contract: {
    required: Readonly<Record<string, SchemaPropertyContract>>;
    optional: Readonly<Record<string, SchemaPropertyContract>>;
  },
): NotionDatabaseSchemaValidation {
  const issues: NotionSchemaValidationIssue[] = [];
  const validateProperty = (property: string, requirement: SchemaPropertyContract, required: boolean): void => {
    const actual = findSchemaProperty(summary, requirement);
    if (!actual) {
      if (required) issues.push({ code: 'missing_property', property });
      return;
    }

    if (!requirement.types.includes(actual.type)) {
      issues.push({
        code: 'wrong_property_type',
        property,
        expectedTypes: [...requirement.types],
        actualType: actual.type,
      });
      return;
    }

    if (!requirement.options) return;
    const actualOptions = summary.optionNames[actual.name] ?? [];
    const requiredOptions = requirement.options.filter(
      (option) => !actualOptions.some(
        (actualOption) => normalizedOption(role, property, actualOption) === normalizedOption(role, property, option),
      ),
    );
    const allowedOptions = requirement.allowedOptions ?? requirement.options;
    const unsupportedOptions = actualOptions.filter(
      (option) => !allowedOptions.some(
        (allowed) => normalizedOption(role, property, option) === normalizedOption(role, property, allowed),
      ),
    );
    if (requiredOptions.length > 0 || unsupportedOptions.length > 0) {
      issues.push({
        code: 'unsupported_option',
        property,
        ...(requiredOptions.length > 0 ? { requiredOptions } : {}),
        ...(unsupportedOptions.length > 0 ? { unsupportedOptions } : {}),
      });
    }
  };

  for (const [property, requirement] of Object.entries(contract.required)) {
    validateProperty(property, requirement, true);
  }
  for (const [property, requirement] of Object.entries(contract.optional)) {
    validateProperty(property, requirement, false);
  }

  return {
    database: role,
    valid: issues.length === 0,
    issues,
    remediation:
      role === 'pages'
        ? 'Open the Pages database in Notion and restore the listed fields and select values, or change each field to the expected type.'
        : 'Open the Posts database in Notion and restore the listed fields and select values, or change each field to the expected type.',
  };
}

/** Validate both resolved databases without reading any rows or page content. */
export function validateNotionTemplateSchemas(
  resolution: Pick<NotionTemplateResolution, 'pagesSchema' | 'postsSchema'>,
): NotionTemplateSchemaValidation {
  const pages = validateDatabaseSchema('pages', resolution.pagesSchema, PAGES_SCHEMA_CONTRACT);
  const posts = validateDatabaseSchema('posts', resolution.postsSchema, POSTS_SCHEMA_CONTRACT);
  return { valid: pages.valid && posts.valid, pages, posts };
}

interface FingerprintScore {
  role: TemplateDatabaseRole;
  score: number;
  missing: Array<{ property: string; expectedType: string; actualType: string | null }>;
}

function scoreFingerprint(
  fingerprint: (typeof FINGERPRINTS)[number],
  properties: Record<string, NotionPropertyShape>,
): FingerprintScore {
  const requiredEntries = Object.entries(fingerprint.required);
  const missing: FingerprintScore['missing'] = [];
  let hits = 0;
  for (const [propertyName, expectedType] of requiredEntries) {
    const contract = fingerprint.role === 'pages'
      ? PAGES_SCHEMA_CONTRACT.required[propertyName as keyof typeof PAGES_SCHEMA_CONTRACT.required]
      : POSTS_SCHEMA_CONTRACT.required[propertyName as keyof typeof POSTS_SCHEMA_CONTRACT.required];
    const actual = contract?.names.map((name) => properties[name]).find((property) => property !== undefined);
    const actualType = typeof actual?.type === 'string' ? actual.type : null;
    if (actualType === expectedType) hits += 1;
    else missing.push({ property: propertyName, expectedType, actualType });
  }
  return { role: fingerprint.role, score: hits / requiredEntries.length, missing };
}

type DatabaseIdentity = TemplateDatabaseRole | 'ambiguous' | 'unrecognized';

interface IdentifiedCandidate {
  summary: NotionDatabaseSchemaSummary;
  identity: DatabaseIdentity;
  scores: Record<TemplateDatabaseRole, FingerprintScore>;
}

function identifyTemplateDatabase(databaseId: string, database: NotionDatabaseResponse): IdentifiedCandidate {
  const properties = database.properties as Record<string, NotionPropertyShape>;
  const scores = {
    pages: scoreFingerprint(PAGES_FINGERPRINT, properties),
    posts: scoreFingerprint(POSTS_FINGERPRINT, properties),
  } as Record<TemplateDatabaseRole, FingerprintScore>;

  const passing = FINGERPRINTS.filter((fingerprint) => scores[fingerprint.role].score >= MATCH_THRESHOLD);
  // Keep a near-match associated with its most likely role long enough for
  // validation to report the exact missing/wrong property. Without this,
  // Posts with one broken required field (3/4 hits) would only produce the
  // much less useful database-level "missing" error.
  const likely = passing.length === 0
    ? FINGERPRINTS.filter((fingerprint) => scores[fingerprint.role].score >= 0.6)
    : [];
  const candidates = passing.length > 0 ? passing : likely;
  const identity: DatabaseIdentity =
    candidates.length === 1 ? candidates[0].role : candidates.length > 1 ? 'ambiguous' : 'unrecognized';

  return {
    summary: summarizeDatabase(databaseId, properties),
    identity,
    scores,
  };
}

function missingRolesFor(identified: IdentifiedCandidate[]): TemplateDatabaseRole[] {
  return FINGERPRINTS.map((fingerprint) => fingerprint.role).filter(
    (role) => !identified.some((candidate) => candidate.identity === role),
  );
}

/**
 * Resolve the duplicated template root into exactly one Pages and one Posts
 * database. Outcome contract:
 *
 * - resolved: both fingerprints matched exactly once, by schema, never title.
 * - `notion_template_database_ambiguous` (422): a database matched more than
 *   one fingerprint, or one fingerprint matched more than one database —
 *   never guessed between.
 * - `notion_template_database_missing` (422): every child database was
 *   fetched and fingerprinted, and a role has no match.
 * - `notion_template_root_unavailable` (403): Notion rejected the token;
 *   (502): the root was still not visible after all attempts — right after
 *   duplication this is usually eventual consistency, otherwise the page is
 *   not shared with the connection.
 * - `notion_template_root_empty` (502): the root was reachable but showed no
 *   child databases after all attempts.
 * - `notion_template_unavailable` (502): transient provider failures kept
 *   some found databases unfetchable after all attempts.
 *
 * Eventual consistency: a freshly duplicated page can briefly serve empty or
 * partial block children, and a just-copied database can 404, so outcomes
 * that look like propagation (no databases found, or candidates that could
 * not be fetched) are retried with backoff within the same request. Schema
 * mismatches among fully fetched databases are definitive and fail fast —
 * retrying cannot repair a deleted or altered database.
 */
export async function resolveNotionTemplateDatabases(
  accessToken: string,
  duplicatedTemplateId: string,
  options: NotionTemplateResolveOptions = {},
): Promise<NotionTemplateResolution> {
  const {
    maxAttempts = RESOLUTION_MAX_ATTEMPTS,
    initialDelayMs = RESOLUTION_INITIAL_DELAY_MS,
    maxDelayMs = RESOLUTION_MAX_DELAY_MS,
    fetcher = fetch,
    sleep = defaultSleep,
  } = options;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('invalid template resolution attempt limit');
  }

  const rootId = normalizeNotionId(duplicatedTemplateId);
  if (!rootId) throw new NotionTemplateError('notion_template_root_invalid', 400);

  let pending: 'root_missing' | 'empty' | 'unavailable' = 'empty';
  let pendingRetryAfterMs: number | null = null;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      // A Retry-After from a rate-limited attempt takes precedence over the
      // exponential backoff, capped so a stale header cannot stretch this
      // request unboundedly.
      await sleep(pendingRetryAfterMs ?? delay);
      pendingRetryAfterMs = null;
      delay = Math.min(delay * 2, maxDelayMs);
    }

    const walked = await walkTemplateDatabaseIds(accessToken, rootId, fetcher);
    if (walked.kind === 'forbidden') {
      throw new NotionTemplateError('notion_template_root_unavailable', 403);
    }
    if (walked.kind === 'root_missing') {
      pending = 'root_missing';
      continue;
    }
    if (walked.kind === 'transient') {
      pending = 'unavailable';
      pendingRetryAfterMs =
        walked.retryAfterSeconds !== null ? Math.min(walked.retryAfterSeconds * 1000, maxDelayMs) : null;
      continue;
    }

    const candidates = walked.databaseIds.slice(0, TEMPLATE_MAX_CANDIDATE_DATABASES);
    if (candidates.length === 0) {
      pending = 'empty';
      continue;
    }

    const identified: IdentifiedCandidate[] = [];
    let invisible = 0;
    for (const databaseId of candidates) {
      const fetched = await fetchTemplateDatabase(databaseId, accessToken, fetcher);
      if (fetched.kind === 'ok') identified.push(identifyTemplateDatabase(fetched.databaseId, fetched.database));
      else if (fetched.kind === 'forbidden') {
        throw new NotionTemplateError('notion_template_root_unavailable', 403);
      } else invisible += 1;
    }

    const duplicates = FINGERPRINTS.filter(
      (fingerprint) => identified.filter((candidate) => candidate.identity === fingerprint.role).length > 1,
    );
    const ambiguousSelf = identified.filter((candidate) => candidate.identity === 'ambiguous');
    if (duplicates.length > 0 || ambiguousSelf.length > 0) {
      throw new NotionTemplateError('notion_template_database_ambiguous', 422, {
        scanned: identified.length,
        duplicated_roles: duplicates.map((fingerprint) => fingerprint.role),
        ambiguous_databases: ambiguousSelf.length,
      });
    }

    const missingRoles = missingRolesFor(identified);
    if (missingRoles.length === 0) {
      const pages = identified.find((candidate) => candidate.identity === 'pages');
      const posts = identified.find((candidate) => candidate.identity === 'posts');
      if (!pages || !posts) continue;
      const resolution: NotionTemplateResolution = {
        pagesDatabaseId: pages.summary.databaseId,
        postsDatabaseId: posts.summary.databaseId,
        templateSchemaVersion: NOTION_TEMPLATE_SCHEMA_VERSION,
        scannedDatabaseCount: identified.length,
        pagesSchema: pages.summary,
        postsSchema: posts.summary,
        resolvedAt: Date.now(),
      };
      const validation = validateNotionTemplateSchemas(resolution);
      if (!validation.valid) {
        throw new NotionTemplateError('notion_template_schema_invalid', 422, {
          validation,
          remediation: 'Update the matching database schemas in Notion, then reconnect Notion so InkDrafts can validate them again.',
        });
      }
      return resolution;
    }

    // A role is missing: if some candidates could not be fetched this may
    // still be propagation, so retry; otherwise the template is genuinely
    // shaped wrong and retrying cannot help.
    if (invisible > 0) {
      pending = 'unavailable';
      continue;
    }
    throw new NotionTemplateError('notion_template_database_missing', 422, {
      missing: missingRoles,
      scanned: identified.length,
    });
  }

  if (pending === 'root_missing') {
    throw new NotionTemplateError('notion_template_root_unavailable', 502);
  }
  if (pending === 'unavailable') {
    throw new NotionTemplateError('notion_template_unavailable', 502);
  }
  throw new NotionTemplateError('notion_template_root_empty', 502);
}

export interface NotionTemplateResolutionRecord {
  version: 1;
  jobId: string;
  resolution: NotionTemplateResolution;
}

export function notionTemplateResolutionKey(jobId: string): string {
  return `${NOTION_TEMPLATE_RESOLUTION_PREFIX}${jobId}`;
}

/**
 * Persist the resolution for later provisioning steps (secret writing, schema
 * validation). The record holds only database IDs and schema metadata — never
 * the access token, which has already been discarded by the time this runs.
 */
export async function saveNotionTemplateResolution(
  kv: KVNamespace,
  record: NotionTemplateResolutionRecord,
  ttlSeconds: number = NOTION_TEMPLATE_RESOLUTION_TTL_SECONDS,
): Promise<void> {
  await kv.put(notionTemplateResolutionKey(record.jobId), JSON.stringify(record), { expirationTtl: ttlSeconds });
}

export async function loadNotionTemplateResolution(
  kv: KVNamespace,
  jobId: string,
): Promise<NotionTemplateResolutionRecord | null> {
  const record = await kv.get<NotionTemplateResolutionRecord>(notionTemplateResolutionKey(jobId), 'json');
  if (!record || record.version !== 1 || typeof record.jobId !== 'string') return null;
  return record;
}
