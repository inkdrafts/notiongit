import { describe, expect, test } from 'bun:test';

import { route } from '../src/index';

describe('HTTP foundation', () => {
  test('returns a deterministic health response without bindings or secrets', async () => {
    const response = route(new Request('https://example.com/healthz'));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true, service: 'notiongit' });
  });

  test('serves the public landing page', async () => {
    const response = route(new Request('https://example.com/'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<title>InkDrafts</title>');
  });

  test('reserves provider callback namespaces', async () => {
    const response = route(
      new Request('https://example.com/auth/notion/callback?code=redacted'),
    );

    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: 'not_implemented' });
  });

  test('returns JSON for unknown routes', async () => {
    const response = route(new Request('https://example.com/nope'));

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});
