import { expect, test } from 'bun:test';

import { resolveNotionTemplateDatabases } from '../src/notion-template';

/**
 * Read-only check against a disposable development workspace: a duplicated
 * InkDrafts template root resolves into its Pages and Posts database IDs by
 * schema alone. Set both variables when running it; the token is never
 * printed or persisted, and nothing in the workspace is modified.
 *
 *   NOTION_TEMPLATE_INTEGRATION_TOKEN=secret_... \
 *   NOTION_TEMPLATE_INTEGRATION_ROOT=<duplicated root page id> \
 *   bun run test:notion-template-integration
 *
 * Prepare the workspace by authorizing the development Notion connection and
 * choosing "Duplicate template" (the duplicated root page id is in the token
 * exchange response as `duplicated_template_id`), or duplicate the public
 * template manually and share the copy with the integration.
 */
const token = process.env.NOTION_TEMPLATE_INTEGRATION_TOKEN;
const root = process.env.NOTION_TEMPLATE_INTEGRATION_ROOT;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

test.skipIf(!token || !root)('development workspace duplicate resolves into distinct Pages and Posts IDs', async () => {
  const resolution = await resolveNotionTemplateDatabases(token!, root!);

  expect(resolution.pagesDatabaseId).toMatch(UUID_PATTERN);
  expect(resolution.postsDatabaseId).toMatch(UUID_PATTERN);
  expect(resolution.postsDatabaseId).not.toBe(resolution.pagesDatabaseId);
  expect(resolution.templateSchemaVersion).toBe(1);
  expect(resolution.pagesSchema.propertyTypes['Status']).toBe('select');
  expect(resolution.pagesSchema.optionNames.Status).toContain('Published');
  expect(resolution.postsSchema.propertyTypes['Publish Date']).toBe('date');
  expect(resolution.postsSchema.propertyTypes['Tags']).toBe('multi_select');
});
