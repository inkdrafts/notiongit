import { describe, expect, test } from 'bun:test';

import {
  NOTION_TEMPLATE_RESOLUTION_PREFIX,
  NOTION_TEMPLATE_RESOLUTION_TTL_SECONDS,
} from '../src/index';
import {
  loadNotionTemplateResolution,
  normalizeNotionId,
  notionTemplateResolutionKey,
  NotionTemplateError,
  parseNotionCanonicalUrl,
  resolveNotionTemplateDatabases,
  saveNotionTemplateResolution,
  validateNotionTemplateSchemas,
} from '../src/notion-template';

// Synthetic identifiers only — no real workspace IDs, tokens, or content.
const ROOT_DASHED = '55555555-5555-4555-8555-555555555555';
const ROOT_UNDASHED = '55555555555545558555555555555555';
const PAGES_DB = '11111111-1111-4111-8111-111111111111';
const POSTS_DB = '22222222-2222-4222-8222-222222222222';
const UNRELATED_DB = '33333333-3333-4333-8333-333333333333';
const SUB_PAGE = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'synthetic-notion-access-token';

const compact = (id: string): string => id.replaceAll('-', '');
const PAGES_DB_URL = `https://www.notion.so/workspace/Pages-${compact(PAGES_DB)}`;
const POSTS_DB_URL = `https://www.notion.so/workspace/Posts-${compact(POSTS_DB)}`;
const ROOT_PAGE_URL = `https://www.notion.so/workspace/My-Site-${compact(ROOT_DASHED)}`;

function pagesProperties(): Record<string, unknown> {
  return {
    Title: { type: 'title' },
    Slug: { type: 'rich_text' },
    Type: {
      type: 'select',
      select: { options: [{ name: 'home' }, { name: 'blog-list' }, { name: 'blog' }, { name: 'markdown' }] },
    },
    'Nav Order': { type: 'number' },
    'Show in Nav': { type: 'checkbox' },
    Status: { type: 'select', select: { options: [{ name: 'Draft' }, { name: 'Published' }] } },
    Description: { type: 'rich_text' },
  };
}

function postsProperties(): Record<string, unknown> {
  return {
    Title: { type: 'title' },
    Slug: { type: 'rich_text' },
    Status: { type: 'select', select: { options: [{ name: 'Draft' }, { name: 'Published' }] } },
    'Publish Date': { type: 'date' },
    Tags: { type: 'multi_select', multi_select: { options: [{ name: 'guide' }] } },
    'Cover Image': { type: 'files' },
  };
}

function databaseResponse(id: string, properties: Record<string, unknown>, url: string | null = `https://www.notion.so/workspace/db-${compact(id)}`): Response {
  const body: Record<string, unknown> = {
    object: 'database',
    id,
    title: [{ type: 'text', text: { content: 'A title the user may have renamed' } }],
    properties,
  };
  if (url !== null) body.url = url;
  return Response.json(body);
}

function pageResponse(id: string, url: string | null = `https://www.notion.so/workspace/My-Site-${compact(id)}`): Response {
  const body: Record<string, unknown> = { object: 'page', id };
  if (url !== null) body.url = url;
  return Response.json(body);
}

function block(id: string, type: string): unknown {
  return { object: 'block', id, type, [type]: {} };
}

function childrenList(results: unknown[], hasMore = false, nextCursor: string | null = null): Response {
  return Response.json({ object: 'list', results, has_more: hasMore, next_cursor: nextCursor });
}

interface RecordedCall {
  request: Request;
  url: URL;
}

/**
 * Minimal provider fake: routes by path against a queue of responses per
 * resource, so tests can stage eventual-consistency and rate-limit behavior
 * without any network access. The last response in a queue repeats, and an
 * unexpected request fails loudly.
 */
class NotionFake {
  readonly calls: RecordedCall[] = [];
  private readonly childrenQueues = new Map<string, Array<Response | Error>>();
  private readonly databaseQueues = new Map<string, Array<Response | Error>>();
  private readonly pageQueues = new Map<string, Array<Response | Error>>();

  children(blockId: string, responses: Array<Response | Error>): this {
    this.childrenQueues.set(blockId, [...responses]);
    return this;
  }

  database(databaseId: string, responses: Array<Response | Error>): this {
    this.databaseQueues.set(databaseId, [...responses]);
    return this;
  }

  page(pageId: string, responses: Array<Response | Error>): this {
    this.pageQueues.set(pageId, [...responses]);
    return this;
  }

  fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    this.calls.push({ request, url });
    // /v1/blocks/{id}/children, /v1/databases/{id}, and /v1/pages/{id} all
    // carry the id at the third path segment.
    const segments = url.pathname.split('/');
    // The root-page capture is best-effort; an unstaged root still answers so
    // a resolution test exercises link capture unless it stages a failure.
    const queue =
      segments[2] === 'blocks' ? this.childrenQueues.get(segments[3])
        : segments[2] === 'databases' ? this.databaseQueues.get(segments[3])
          : segments[2] === 'pages' ? (this.pageQueues.get(segments[3]) ?? [pageResponse(segments[3])])
            : undefined;
    if (!queue || queue.length === 0) {
      throw new Error(`unexpected provider request: ${request.method} ${url.pathname}`);
    }
    const next = queue.shift()!;
    // The last staged response repeats, so multi-attempt retries see a
    // stable workspace instead of an unexpected request.
    if (queue.length === 0) queue.push(next);
    if (next instanceof Error) throw next;
    // A Response body can only be read once; every serving hands out a
    // fresh clone so repeats and retries read a live body.
    return next.clone();
  };

  childrenCallCount(blockId: string): number {
    return this.calls.filter(({ url }) => url.pathname === `/v1/blocks/${blockId}/children`).length;
  }

  databaseCallCount(databaseId: string): number {
    return this.calls.filter(({ url }) => url.pathname === `/v1/databases/${databaseId}`).length;
  }
}

function noSleep(): (milliseconds: number) => Promise<void> {
  return () => Promise.resolve();
}

function recordingSleep(sleeps: number[]): (milliseconds: number) => Promise<void> {
  return (milliseconds) => {
    sleeps.push(milliseconds);
    return Promise.resolve();
  };
}

class MemoryKV {
  private values = new Map<string, string>();
  readonly puts: Array<{ key: string; value: string; ttl?: number }> = [];

  async get<T>(key: string, type?: string): Promise<T | string | null> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return type === 'json' ? JSON.parse(value) as T : value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.values.set(key, value);
    this.puts.push({ key, value, ttl: options?.expirationTtl });
  }
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

function templateErrorCode(error: unknown): string {
  expect(error).toBeInstanceOf(NotionTemplateError);
  return (error as NotionTemplateError).code;
}

describe('Notion template ID normalization', () => {
  test('accepts dashed and compact UUIDs and rejects anything else', () => {
    expect(normalizeNotionId(ROOT_DASHED)).toBe(ROOT_DASHED);
    expect(normalizeNotionId(ROOT_UNDASHED)).toBe(ROOT_DASHED);
    expect(normalizeNotionId(` ${ROOT_DASHED.toUpperCase()} `)).toBe(ROOT_DASHED);
    expect(normalizeNotionId('not-a-uuid')).toBeNull();
    expect(normalizeNotionId('55555555-5555-4555-8555-5555555555')).toBeNull();
    expect(normalizeNotionId('')).toBeNull();
  });
});

describe('Notion canonical URL parsing', () => {
  test('accepts only absolute https URLs on notion.so or a subdomain', () => {
    expect(parseNotionCanonicalUrl(ROOT_PAGE_URL)).toBe(ROOT_PAGE_URL);
    expect(parseNotionCanonicalUrl('https://notion.so/My-Site')).toBe('https://notion.so/My-Site');
    expect(parseNotionCanonicalUrl('https://www.notion.so/workspace/Pages-11111111111141118111111111111111')).toBe(
      'https://www.notion.so/workspace/Pages-11111111111141118111111111111111',
    );
  });

  test('treats everything else as not captured', () => {
    expect(parseNotionCanonicalUrl('http://notion.so/My-Site')).toBeNull();
    expect(parseNotionCanonicalUrl('https://example.com/My-Site')).toBeNull();
    expect(parseNotionCanonicalUrl('https://notion.so.evil.example/My-Site')).toBeNull();
    expect(parseNotionCanonicalUrl('ftp://notion.so/My-Site')).toBeNull();
    expect(parseNotionCanonicalUrl('not a url')).toBeNull();
    expect(parseNotionCanonicalUrl('')).toBeNull();
    expect(parseNotionCanonicalUrl(undefined)).toBeNull();
    expect(parseNotionCanonicalUrl(1234)).toBeNull();
  });
});

describe('Notion template resolution', () => {
  test('resolves renamed, paginated, nested databases by schema and pins the API version', async () => {
    const fake = new NotionFake();
    // Page one of the root: an extra unrelated database and a nested page.
    fake.children(ROOT_DASHED, [
      childrenList(
        [
          block('66666666-6666-4666-8666-666666666666', 'paragraph'),
          block(PAGES_DB, 'child_database'),
          block(UNRELATED_DB, 'child_database'),
          block(SUB_PAGE, 'child_page'),
        ],
        true,
        'cursor-1',
      ),
      // Page two finishes the root's children.
      childrenList([block('77777777-7777-4777-8777-777777777777', 'paragraph')]),
    ]);
    // The Posts database lives one level down, inside the sub-page.
    fake.children(SUB_PAGE, [childrenList([block(POSTS_DB, 'child_database')])]);
    fake.database(PAGES_DB, [databaseResponse(PAGES_DB, pagesProperties(), PAGES_DB_URL)]);
    fake.database(POSTS_DB, [databaseResponse(POSTS_DB, postsProperties(), POSTS_DB_URL)]);
    // An unrelated database the workspace already had: a candidate that
    // matches nothing and is ignored.
    fake.database(UNRELATED_DB, [databaseResponse(UNRELATED_DB, { Name: { type: 'rich_text' } })]);

    const resolution = await resolveNotionTemplateDatabases(TOKEN, ROOT_UNDASHED, {
      fetcher: fake.fetcher,
      sleep: noSleep(),
    });

    expect(resolution.pagesDatabaseId).toBe(PAGES_DB);
    expect(resolution.postsDatabaseId).toBe(POSTS_DB);
    expect(resolution.templateSchemaVersion).toBe(1);
    expect(resolution.scannedDatabaseCount).toBe(3);
    expect(resolution.pagesSchema.propertyTypes['Nav Order']).toBe('number');
    expect(resolution.pagesSchema.optionNames.Status).toEqual(['Draft', 'Published']);
    expect(resolution.postsSchema.optionNames.Tags).toEqual(['guide']);
    expect(resolution.postsSchema.propertyTypes['Publish Date']).toBe('date');
    // The canonical URLs ride along on responses the resolution already fetches.
    expect(resolution.templateRootUrl).toBe(ROOT_PAGE_URL);
    expect(resolution.pagesUrl).toBe(PAGES_DB_URL);
    expect(resolution.postsUrl).toBe(POSTS_DB_URL);
    expect(fake.calls.some(({ url }) => url.pathname === `/v1/pages/${ROOT_DASHED}`)).toBe(true);

    // Every request carries the ADR-pinned version and the token only in its
    // Authorization header; pagination followed the provided cursor.
    for (const { request } of fake.calls) {
      expect(request.headers.get('notion-version')).toBe('2022-06-28');
      expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    }
    expect(fake.childrenCallCount(ROOT_DASHED)).toBe(2);
    const rootChildrenCalls = fake.calls.filter(({ url }) => url.pathname === `/v1/blocks/${ROOT_DASHED}/children`);
    expect(rootChildrenCalls[1].url.searchParams.get('start_cursor')).toBe('cursor-1');
    expect(rootChildrenCalls[1].url.searchParams.get('page_size')).toBe('100');
    // The token never leaks into the result.
    expect(JSON.stringify(resolution)).not.toContain(TOKEN);
  });

  test('rejects a missing required property with a per-database validation issue', async () => {
    const pages = pagesProperties();
    delete pages['Nav Order'];
    const fake = new NotionFake();
    fake.children(ROOT_DASHED, [childrenList([block(PAGES_DB, 'child_database'), block(POSTS_DB, 'child_database')])]);
    fake.database(PAGES_DB, [databaseResponse(PAGES_DB, pages)]);
    fake.database(POSTS_DB, [databaseResponse(POSTS_DB, postsProperties())]);

    const error = await caught(resolveNotionTemplateDatabases(TOKEN, ROOT_DASHED, { fetcher: fake.fetcher, sleep: noSleep() }));

    expect(templateErrorCode(error)).toBe('notion_template_schema_invalid');
    expect((error as NotionTemplateError).details).toMatchObject({
      validation: { pages: { valid: false, issues: [{ code: 'missing_property', property: 'Nav Order' }] } },
    });
  });

  test('rejects a wrong property type with the expected and actual types', async () => {
    const posts = postsProperties();
    posts.Tags = { type: 'rich_text' };
    const fake = new NotionFake();
    fake.children(ROOT_DASHED, [childrenList([block(PAGES_DB, 'child_database'), block(POSTS_DB, 'child_database')])]);
    fake.database(PAGES_DB, [databaseResponse(PAGES_DB, pagesProperties())]);
    fake.database(POSTS_DB, [databaseResponse(POSTS_DB, posts)]);

    const error = await caught(resolveNotionTemplateDatabases(TOKEN, ROOT_DASHED, { fetcher: fake.fetcher, sleep: noSleep() }));

    expect(templateErrorCode(error)).toBe('notion_template_schema_invalid');
    expect((error as NotionTemplateError).details).toMatchObject({
      validation: {
        posts: {
          issues: [{ code: 'wrong_property_type', property: 'Tags', expectedTypes: ['multi_select'], actualType: 'rich_text' }],
        },
      },
    });
  });

  test('rejects unsupported select options before onboarding succeeds', async () => {
    const pages = pagesProperties();
    (pages.Type as { select: { options: Array<{ name: string }> } }).select.options.push({ name: 'portfolio' });
    const fake = new NotionFake();
    fake.children(ROOT_DASHED, [childrenList([block(PAGES_DB, 'child_database'), block(POSTS_DB, 'child_database')])]);
    fake.database(PAGES_DB, [databaseResponse(PAGES_DB, pages)]);
    fake.database(POSTS_DB, [databaseResponse(POSTS_DB, postsProperties())]);

    const error = await caught(resolveNotionTemplateDatabases(TOKEN, ROOT_DASHED, { fetcher: fake.fetcher, sleep: noSleep() }));

    expect(templateErrorCode(error)).toBe('notion_template_schema_invalid');
    expect((error as NotionTemplateError).details).toMatchObject({
      validation: { pages: { issues: [{ code: 'unsupported_option', property: 'Type', unsupportedOptions: ['portfolio'] }] } },
    });
  });

  test('rejects a select that cannot provide the Published workflow value', async () => {
    const posts = postsProperties();
    (posts.Status as { select: { options: Array<{ name: string }> } }).select.options = [{ name: 'Draft' }];
    const fake = new NotionFake();
    fake.children(ROOT_DASHED, [childrenList([block(PAGES_DB, 'child_database'), block(POSTS_DB, 'child_database')])]);
    fake.database(PAGES_DB, [databaseResponse(PAGES_DB, pagesProperties())]);
    fake.database(POSTS_DB, [databaseResponse(POSTS_DB, posts)]);

    const error = await caught(resolveNotionTemplateDatabases(TOKEN, ROOT_DASHED, { fetcher: fake.fetcher, sleep: noSleep() }));

    expect(templateErrorCode(error)).toBe('notion_template_schema_invalid');
    expect((error as NotionTemplateError).details).toMatchObject({
      validation: { posts: { issues: [{ code: 'unsupported_option', property: 'Status', requiredOptions: ['Published'] }] } },
    });
  });

  test('allows optional fallback fields to be absent but validates them when present', () => {
    const valid = validateNotionTemplateSchemas({
      pagesSchema: {
        databaseId: PAGES_DB,
        propertyTypes: { Slug: 'rich_text', Type: 'select', 'Nav Order': 'number', 'Show in Nav': 'checkbox', Status: 'select' },
        optionNames: { Type: ['home', 'blog-list', 'blog', 'markdown'], Status: ['Published'] },
      },
      postsSchema: {
        databaseId: POSTS_DB,
        propertyTypes: { Slug: 'rich_text', 'Publish Date': 'date', Tags: 'multi_select', Status: 'select' },
        optionNames: { Status: ['Published'] },
      },
    });

    expect(valid.valid).toBe(true);
    expect(valid.pages.issues).toEqual([]);
    expect(valid.posts.issues).toEqual([]);
  });

  test('retries an eventually-consistent empty root and then resolves', async () => {
    const fake = new NotionFake();
    fake.children(ROOT_DASHED, [
      childrenList([]),
      childrenList([]),
      childrenList([block(PAGES_DB, 'child_database'), block(POSTS_DB, 'child_database')]),
    ]);
    fake.database(PAGES_DB, [databaseResponse(PAGES_DB, pagesProperties())]);
    fake.database(POSTS_DB, [databaseResponse(POSTS_DB, postsProperties())]);

    const sleeps: number[] = [];
    const resolution = await resolveNotionTemplateDatabases(TOKEN, ROOT_DASHED, {
      fetcher: fake.fetcher,
      sleep: recordingSleep(sleeps),
    });

    expect(resolution.pagesDatabaseId).toBe(PAGES_DB);
    expect(resolution.postsDatabaseId).toBe(POSTS_DB);
    expect(fake.childrenCallCount(ROOT_DASHED)).toBe(3);
    expect(sleeps).toEqual([500, 1_000]);
  });

  test('retries a database that 404s right after duplication', async () => {
    const fake = new NotionFake();
    fake.children(ROOT_DASHED, [
      childrenList([block(PAGES_DB, 'child_database'), block(POSTS_DB, 'child_database')]),
      childrenList([block(PAGES_DB, 'child_database'), block(POSTS_DB, 'child_database')]),
    ]);
    fake.database(PAGES_DB, [databaseResponse(PAGES_DB, pagesProperties())]);
    fake.database(POSTS_DB, [
      new Response('not propagated yet', { status: 404 }),
      databaseResponse(POSTS_DB, postsProperties()),
    ]);

    const resolution = await resolveNotionTemplateDatabases(TOKEN, ROOT_DASHED, {
      fetcher: fake.fetcher,
      sleep: noSleep(),
    });

    expect(resolution.postsDatabaseId).toBe(POSTS_DB);
    expect(fake.databaseCallCount(POSTS_DB)).toBe(2);
  });

  test('honors Retry-After on a rate-limited walk before succeeding', async () => {
    const fake = new NotionFake();
    fake.children(ROOT_DASHED, [
      new Response('rate limited', { status: 429, headers: { 'Retry-After': '7' } }),
      childrenList([block(PAGES_DB, 'child_database'), block(POSTS_DB, 'child_database')]),
    ]);
    fake.database(PAGES_DB, [databaseResponse(PAGES_DB, pagesProperties())]);
    fake.database(POSTS_DB, [databaseResponse(POSTS_DB, postsProperties())]);

    const sleeps: number[] = [];
    const resolution = await resolveNotionTemplateDatabases(TOKEN, ROOT_DASHED, {
      fetcher: fake.fetcher,
      sleep: recordingSleep(sleeps),
    });

    expect(resolution.pagesDatabaseId).toBe(PAGES_DB);
    // Retry-After wins over the backoff but is capped at maxDelayMs to bound
    // the request.
    expect(sleeps).toEqual([4_000]);
  });

  test('reports an empty root distinctly after exhausting the eventual-consistency retries', async () => {
    const fake = new NotionFake();
    fake.children(ROOT_DASHED, [childrenList([])]);

    const error = await caught(
      resolveNotionTemplateDatabases(TOKEN, ROOT_DASHED, { fetcher: fake.fetcher, sleep: noSleep() }),
    );

    expect(templateErrorCode(error)).toBe('notion_template_root_empty');
    expect((error as NotionTemplateError).status).toBe(502);
    expect(fake.childrenCallCount(ROOT_DASHED)).toBe(4);
  });

  test('reports a still-invisible root distinctly after retries', async () => {
    const fake = new NotionFake();
    fake.children(ROOT_DASHED, [new Response('not found', { status: 404 })]);

    const error = await caught(
      resolveNotionTemplateDatabases(TOKEN, ROOT_DASHED, { fetcher: fake.fetcher, sleep: noSleep() }),
    );

    expect(templateErrorCode(error)).toBe('notion_template_root_unavailable');
    expect((error as NotionTemplateError).status).toBe(502);
    expect(fake.childrenCallCount(ROOT_DASHED)).toBe(4);
  });

  test('rejects a token that cannot read the root immediately, without retrying', async () => {
    const fake = new NotionFake();
    fake.children(ROOT_DASHED, [new Response('unauthorized', { status: 401 })]);

    const error = await caught(
      resolveNotionTemplateDatabases(TOKEN, ROOT_DASHED, { fetcher: fake.fetcher, sleep: noSleep() }),
    );

    expect(templateErrorCode(error)).toBe('notion_template_root_unshared');
    expect((error as NotionTemplateError).status).toBe(403);
    expect(fake.childrenCallCount(ROOT_DASHED)).toBe(1);
  });

  test('rejects a duplicated-template value that cannot be a Notion ID without any request', async () => {
    const fake = new NotionFake();
    const error = await caught(
      resolveNotionTemplateDatabases(TOKEN, 'not-a-page-id', { fetcher: fake.fetcher, sleep: noSleep() }),
    );

    expect(templateErrorCode(error)).toBe('notion_template_root_invalid');
    expect((error as NotionTemplateError).status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  test('never guesses between two databases matching the same fingerprint', async () => {
    const duplicatePosts = '88888888-8888-4888-8888-888888888888';
    const fake = new NotionFake();
    fake.children(ROOT_DASHED, [
      childrenList([block(PAGES_DB, 'child_database'), block(POSTS_DB, 'child_database'), block(duplicatePosts, 'child_database')]),
    ]);
    fake.database(PAGES_DB, [databaseResponse(PAGES_DB, pagesProperties())]);
    fake.database(POSTS_DB, [databaseResponse(POSTS_DB, postsProperties())]);
    fake.database(duplicatePosts, [databaseResponse(duplicatePosts, postsProperties())]);

    const error = await caught(
      resolveNotionTemplateDatabases(TOKEN, ROOT_DASHED, { fetcher: fake.fetcher, sleep: noSleep() }),
    );

    expect(templateErrorCode(error)).toBe('notion_template_database_ambiguous');
    expect((error as NotionTemplateError).status).toBe(422);
    expect((error as NotionTemplateError).details).toEqual({
      scanned: 3,
      duplicated_roles: ['posts'],
      ambiguous_databases: 0,
    });
  });

  test('reports a database that matches both fingerprints as ambiguous', async () => {
    const both = '99999999-9999-4999-8999-999999999999';
    const fake = new NotionFake();
    fake.children(ROOT_DASHED, [childrenList([block(both, 'child_database')])]);
    fake.database(both, [
      databaseResponse(both, {
        ...pagesProperties(),
        ...postsProperties(),
        Slug: { type: 'rich_text' },
        Status: { type: 'select' },
      }),
    ]);

    const error = await caught(
      resolveNotionTemplateDatabases(TOKEN, ROOT_DASHED, { fetcher: fake.fetcher, sleep: noSleep() }),
    );

    expect(templateErrorCode(error)).toBe('notion_template_database_ambiguous');
    expect((error as NotionTemplateError).details).toEqual({
      scanned: 1,
      duplicated_roles: [],
      ambiguous_databases: 1,
    });
  });

  test('reports no match with the missing roles named, without retrying a fetched mismatch', async () => {
    const fake = new NotionFake();
    fake.children(ROOT_DASHED, [childrenList([block(UNRELATED_DB, 'child_database')])]);
    fake.database(UNRELATED_DB, [databaseResponse(UNRELATED_DB, { Name: { type: 'rich_text' } })]);

    const sleeps: number[] = [];
    const error = await caught(
      resolveNotionTemplateDatabases(TOKEN, ROOT_DASHED, {
        fetcher: fake.fetcher,
        sleep: recordingSleep(sleeps),
      }),
    );

    expect(templateErrorCode(error)).toBe('notion_template_database_missing');
    expect((error as NotionTemplateError).status).toBe(422);
    expect((error as NotionTemplateError).details).toEqual({ missing: ['pages', 'posts'], scanned: 1 });
    expect(fake.childrenCallCount(ROOT_DASHED)).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test('reports a single missing role when only the other database matches', async () => {
    const fake = new NotionFake();
    fake.children(ROOT_DASHED, [childrenList([block(PAGES_DB, 'child_database')])]);
    fake.database(PAGES_DB, [databaseResponse(PAGES_DB, pagesProperties())]);

    const error = await caught(
      resolveNotionTemplateDatabases(TOKEN, ROOT_DASHED, { fetcher: fake.fetcher, sleep: noSleep() }),
    );

    expect(templateErrorCode(error)).toBe('notion_template_database_missing');
    expect((error as NotionTemplateError).details).toEqual({ missing: ['posts'], scanned: 1 });
  });

  test('retries while a missing role might still be propagating, then reports unavailability', async () => {
    const fake = new NotionFake();
    const rootContent = [childrenList([block(PAGES_DB, 'child_database'), block(POSTS_DB, 'child_database')])];
    fake.children(ROOT_DASHED, [...rootContent, ...rootContent, ...rootContent, ...rootContent]);
    fake.database(PAGES_DB, [databaseResponse(PAGES_DB, pagesProperties())]);
    fake.database(POSTS_DB, [
      new Response('not propagated yet', { status: 404 }),
      new Response('still not', { status: 404 }),
      new Response('nope', { status: 404 }),
      new Response('no', { status: 404 }),
    ]);

    const error = await caught(
      resolveNotionTemplateDatabases(TOKEN, ROOT_DASHED, { fetcher: fake.fetcher, sleep: noSleep() }),
    );

    expect(templateErrorCode(error)).toBe('notion_template_unavailable');
    expect((error as NotionTemplateError).status).toBe(502);
    expect(fake.childrenCallCount(ROOT_DASHED)).toBe(4);
  });

  test('bounds the walk by depth so far-nested content cannot be traversed unbounded', async () => {
    const l1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const l2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const l3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const deepDb = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const fake = new NotionFake();
    fake.children(ROOT_DASHED, [childrenList([block(l1, 'child_page')])]);
    fake.children(l1, [childrenList([block(l2, 'child_page')])]);
    fake.children(l2, [childrenList([block(l3, 'child_page')])]);
    fake.children(l3, [childrenList([block(deepDb, 'child_database')])]);

    const error = await caught(
      resolveNotionTemplateDatabases(TOKEN, ROOT_DASHED, {
        fetcher: fake.fetcher,
        sleep: noSleep(),
        maxAttempts: 1,
      }),
    );

    // The root plus two child-page levels (depth budget 3) are walked; the
    // third level is out of budget, so nothing resolves and the failure is
    // the bounded empty-root outcome rather than an unbounded traversal.
    expect(templateErrorCode(error)).toBe('notion_template_root_empty');
    expect(fake.calls.filter(({ url }) => url.pathname.endsWith('/children'))).toHaveLength(3);
  });

  test('a failed root-page capture degrades to a null link without blocking resolution', async () => {
    const fake = new NotionFake();
    fake.children(ROOT_DASHED, [childrenList([block(PAGES_DB, 'child_database'), block(POSTS_DB, 'child_database')])]);
    fake.database(PAGES_DB, [databaseResponse(PAGES_DB, pagesProperties(), PAGES_DB_URL)]);
    fake.database(POSTS_DB, [databaseResponse(POSTS_DB, postsProperties(), POSTS_DB_URL)]);
    fake.page(ROOT_DASHED, [new Response('root fetch failed', { status: 500 })]);

    const resolution = await resolveNotionTemplateDatabases(TOKEN, ROOT_DASHED, {
      fetcher: fake.fetcher,
      sleep: noSleep(),
    });

    expect(resolution.pagesDatabaseId).toBe(PAGES_DB);
    expect(resolution.postsDatabaseId).toBe(POSTS_DB);
    expect(resolution.templateRootUrl).toBeNull();
    expect(resolution.pagesUrl).toBe(PAGES_DB_URL);
    expect(resolution.postsUrl).toBe(POSTS_DB_URL);
  });

  test('a root capture with a hostile or missing url degrades to a null link without blocking resolution', async () => {
    for (const staged of [pageResponse(ROOT_DASHED, 'https://evil.example/My-Site'), pageResponse(ROOT_DASHED, null)]) {
      const fake = new NotionFake();
      fake.children(ROOT_DASHED, [childrenList([block(PAGES_DB, 'child_database'), block(POSTS_DB, 'child_database')])]);
      fake.database(PAGES_DB, [databaseResponse(PAGES_DB, pagesProperties(), PAGES_DB_URL)]);
      fake.database(POSTS_DB, [databaseResponse(POSTS_DB, postsProperties(), POSTS_DB_URL)]);
      fake.page(ROOT_DASHED, [staged]);

      const resolution = await resolveNotionTemplateDatabases(TOKEN, ROOT_DASHED, {
        fetcher: fake.fetcher,
        sleep: noSleep(),
      });

      expect(resolution.templateRootUrl).toBeNull();
      expect(resolution.pagesUrl).toBe(PAGES_DB_URL);
    }
  });

  test('database responses without a usable canonical URL capture a null link', async () => {
    const fake = new NotionFake();
    fake.children(ROOT_DASHED, [childrenList([block(PAGES_DB, 'child_database'), block(POSTS_DB, 'child_database')])]);
    fake.database(PAGES_DB, [databaseResponse(PAGES_DB, pagesProperties(), 'https://evil.example/Pages')]);
    fake.database(POSTS_DB, [databaseResponse(POSTS_DB, postsProperties(), null)]);

    const resolution = await resolveNotionTemplateDatabases(TOKEN, ROOT_DASHED, {
      fetcher: fake.fetcher,
      sleep: noSleep(),
    });

    expect(resolution.pagesUrl).toBeNull();
    expect(resolution.postsUrl).toBeNull();
    expect(resolution.templateRootUrl).toBe(ROOT_PAGE_URL);
  });
});

describe('Notion template resolution record', () => {
  test('round-trips through KV under the job-scoped key with the rolling TTL', async () => {
    const kv = new MemoryKV();
    const record = {
      version: 1 as const,
      jobId: 'job-record',
      resolution: {
        pagesDatabaseId: PAGES_DB,
        postsDatabaseId: POSTS_DB,
        templateSchemaVersion: 1,
        scannedDatabaseCount: 2,
        pagesSchema: { databaseId: PAGES_DB, propertyTypes: { Slug: 'rich_text' }, optionNames: {} },
        postsSchema: { databaseId: POSTS_DB, propertyTypes: { Slug: 'rich_text' }, optionNames: {} },
        resolvedAt: 1_000,
        templateRootUrl: ROOT_PAGE_URL,
        pagesUrl: PAGES_DB_URL,
        postsUrl: POSTS_DB_URL,
      },
    };

    await saveNotionTemplateResolution(kv as unknown as KVNamespace, record);
    expect(kv.puts[0].key).toBe(notionTemplateResolutionKey('job-record'));
    expect(kv.puts[0].key.startsWith(NOTION_TEMPLATE_RESOLUTION_PREFIX)).toBe(true);
    expect(kv.puts[0].ttl).toBe(NOTION_TEMPLATE_RESOLUTION_TTL_SECONDS);
    expect(await loadNotionTemplateResolution(kv as unknown as KVNamespace, 'job-record')).toEqual(record);
    expect(await loadNotionTemplateResolution(kv as unknown as KVNamespace, 'other-job')).toBeNull();
  });

  test('defaults the captured links to null for a record written before URL capture', async () => {
    const kv = new MemoryKV();
    const record = {
      version: 1 as const,
      jobId: 'job-record',
      resolution: {
        pagesDatabaseId: PAGES_DB,
        postsDatabaseId: POSTS_DB,
        templateSchemaVersion: 1,
        scannedDatabaseCount: 2,
        pagesSchema: { databaseId: PAGES_DB, propertyTypes: { Slug: 'rich_text' }, optionNames: {} },
        postsSchema: { databaseId: POSTS_DB, propertyTypes: { Slug: 'rich_text' }, optionNames: {} },
        resolvedAt: 1_000,
      },
    };
    await kv.put(notionTemplateResolutionKey('job-record'), JSON.stringify(record));

    const loaded = await loadNotionTemplateResolution(kv as unknown as KVNamespace, 'job-record');
    expect(loaded?.resolution.templateRootUrl).toBeNull();
    expect(loaded?.resolution.pagesUrl).toBeNull();
    expect(loaded?.resolution.postsUrl).toBeNull();
  });
});

