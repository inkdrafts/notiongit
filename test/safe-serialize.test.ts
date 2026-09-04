import { describe, expect, test } from 'bun:test';

import { Secret } from '../src/secret';
import { redactValue, reportError, serializeForLog } from '../src/safe-serialize';

class TaggedError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'TaggedError';
    this.code = code;
    this.status = status;
  }
}

describe('redactValue', () => {
  test('renders a Secret as the redaction marker at any depth', () => {
    const value = {
      outer: {
        list: [Secret.githubInstallation('synthetic-installation-token')],
      },
      plain: 'synthetic-plain-value',
    };
    expect(redactValue(value)).toEqual({
      outer: { list: ['[redacted]'] },
      plain: 'synthetic-plain-value',
    });
  });

  test('redacts by key name regardless of value', () => {
    const value = {
      access_token: 'synthetic-a',
      refresh_token: 'synthetic-b',
      client_secret: 'synthetic-c',
      Authorization: 'synthetic-d',
      private_key: 'synthetic-e',
      privateKey: 'synthetic-f',
      credentials: { password: 'synthetic-g' },
      workspace_name: 'synthetic-ok',
    };
    const redacted = redactValue(value) as Record<string, unknown>;
    expect(redacted.access_token).toBe('[redacted]');
    expect(redacted.refresh_token).toBe('[redacted]');
    expect(redacted.client_secret).toBe('[redacted]');
    expect(redacted.Authorization).toBe('[redacted]');
    expect(redacted.private_key).toBe('[redacted]');
    expect(redacted.privateKey).toBe('[redacted]');
    // The whole subtree under a credential-named key goes, not just leaves.
    expect(redacted.credentials).toBe('[redacted]');
    expect(redacted.workspace_name).toBe('synthetic-ok');
  });

  test('renders an Error as name, message, and its own fields, redacted', () => {
    const error = new TaggedError('synthetic_code', 429);
    (error as unknown as Record<string, unknown>).details = {
      accessToken: Secret.notionUserAccess('synthetic-notion-token'),
      scanned: 2,
    };
    expect(redactValue(error)).toEqual({
      name: 'TaggedError',
      message: 'synthetic_code',
      code: 'synthetic_code',
      status: 429,
      details: { accessToken: '[redacted]', scanned: 2 },
    });
  });

  test('bounds depth and survives cycles', () => {
    const deep: Record<string, unknown> = { leaf: 'synthetic-leaf' };
    let cursor = deep;
    for (let i = 0; i < 40; i += 1) {
      cursor = (cursor.next = { leaf: 'synthetic-leaf' }) as Record<string, unknown>;
    }
    const serialized = serializeForLog(deep);
    expect(serialized).toContain('[truncated]');
    // A 40-level chain must not grow the log line linearly.
    expect(serialized.length).toBeLessThan(600);

    const cyclic: Record<string, unknown> = { name: 'synthetic-root' };
    cyclic.self = cyclic;
    expect(serializeForLog(cyclic)).toContain('[circular]');
  });
});

describe('serializeForLog', () => {
  test('degrades unserializable input to a short safe string', () => {
    expect(typeof serializeForLog(123n)).toBe('string');
    expect(typeof serializeForLog(Symbol('synthetic'))).toBe('string');
    expect(typeof serializeForLog(() => 'synthetic')).toBe('string');
    expect(typeof serializeForLog(undefined)).toBe('string');
    expect(serializeForLog(undefined)).toBe('undefined');
    expect(typeof serializeForLog(new TaggedError('boom', 500))).toBe('string');
  });

  test('never emits a Secret value even inside an error carrying one', () => {
    const error = new TaggedError('boom', 500);
    (error as unknown as Record<string, unknown>).leaky = {
      installationToken: Secret.githubInstallation('synthetic-installation-token'),
    };
    const line = serializeForLog(error);
    expect(line).not.toContain('synthetic-installation-token');
    expect(line).toContain('"installationToken":"[redacted]"');
  });
});

describe('reportError', () => {
  test('writes one console.error line with the context and a redacted serialization', () => {
    const original = console.error;
    const calls: unknown[][] = [];
    console.error = (...args: unknown[]) => { calls.push(args); };
    try {
      reportError('synthetic_funnel', new TaggedError('synthetic_failure', 502));
    } finally {
      console.error = original;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('[notiongit] synthetic_funnel');
    expect(calls[0][1]).toContain('"status":502');
  });
});
