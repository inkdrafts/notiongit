import { describe, expect, test } from 'bun:test';

import { REDACTED, Secret } from '../src/secret';

describe('Secret', () => {
  test('named factories label the kind and never leak through coercion', () => {
    const notion = Secret.notionUserAccess('synthetic-notion-token');
    const githubUser = Secret.githubUserAccess('synthetic-github-user-token');
    const installation = Secret.githubInstallation('synthetic-installation-token');

    expect(notion.kind).toBe('notion-user-access');
    expect(githubUser.kind).toBe('github-user-access');
    expect(installation.kind).toBe('github-installation');

    for (const secret of [notion, githubUser, installation]) {
      expect(`${secret}`).toBe(REDACTED);
      expect(String(secret)).toBe(REDACTED);
      expect(secret.toJSON()).toBe(REDACTED);
      expect(JSON.stringify({ nested: [secret] })).toBe(`{"nested":["${REDACTED}"]}`);
    }
  });

  test('raw and bearer are the only unwraps', () => {
    const secret = Secret.githubUserAccess('synthetic-github-user-token');
    expect(secret.raw).toBe('synthetic-github-user-token');
    expect(secret.bearer()).toBe('Bearer synthetic-github-user-token');
  });

  test('raw exposes the same copy the Secret already held, without copying through any other surface', () => {
    const value = 'synthetic-installation-token';
    const secret = Secret.githubInstallation(value);
    expect(secret.raw).toBe(value);
  });
});
