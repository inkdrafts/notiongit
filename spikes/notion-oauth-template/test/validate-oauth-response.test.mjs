import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { validateOAuthTokenResponse } from '../src/validate-oauth-response.mjs';

async function loadFixture(name) {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8'));
}

test('the synthetic redacted token response fixture matches the documented shape', async () => {
  const response = await loadFixture('oauth-token-response.json');
  const result = validateOAuthTokenResponse(response);
  assert.deepEqual(result.problems, []);
  assert.equal(result.valid, true);
  assert.equal(result.hasDuplicatedTemplate, true);
});

test('a response without duplicated_template_id is still a valid token response', () => {
  const response = {
    access_token: 'SYNTHETIC-token',
    token_type: 'bearer',
    bot_id: 'SYNTHETIC-bot',
    workspace_id: 'SYNTHETIC-workspace',
  };
  const result = validateOAuthTokenResponse(response);
  assert.equal(result.valid, true);
  assert.equal(result.hasDuplicatedTemplate, false);
});

test('a response missing access_token fails validation', () => {
  const response = {
    token_type: 'bearer',
    bot_id: 'SYNTHETIC-bot',
    workspace_id: 'SYNTHETIC-workspace',
  };
  const result = validateOAuthTokenResponse(response);
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((p) => p.includes('access_token')));
});

test('null/non-object input is rejected without throwing', () => {
  assert.equal(validateOAuthTokenResponse(null).valid, false);
  assert.equal(validateOAuthTokenResponse(undefined).valid, false);
  assert.equal(validateOAuthTokenResponse('not an object').valid, false);
});
