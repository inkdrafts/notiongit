import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FAILURE_REGISTRY,
  FLOW_FAILURE_CODES,
  GENERATE_FAILURE_CODES,
  GITHUB_FAILURE_CODES,
  NOTION_FAILURE_CODES,
  PROVISION_FAILURE_CODES,
  callbackFailure,
  classifyProvisioningError,
  failureCause,
  failureDescriptor,
  failureStage,
  failureSupport,
  FlowFailure,
  isProvisioningFailureCode,
  userCopy,
  type ProvisioningFailureCode,
} from '../src/failures';
import type { GithubActionsSecretsErrorCode } from '../src/actions-secrets';
import { GithubAppAuthError } from '../src/github-app-auth';
import type { GithubConfigErrorCode } from '../src/repository-config';
import type { GithubDeployErrorCode } from '../src/site-deployment';
import type { GithubGenerateErrorCode } from '../src/repository-generation';
import type { GithubPagesErrorCode } from '../src/github-pages';
import type { GithubSyncErrorCode } from '../src/notion-sync';
import type { NotionOAuthErrorCode } from '../src/notion-oauth';
import type { NotionTemplateErrorCode } from '../src/notion-template';

/** Compile-time proof that every code a provider module can report is in the taxonomy. */
type AssertSubset<T extends ProvisioningFailureCode> = true;
const MODULE_CODES_ARE_TAXONOMY_CODES: [
  AssertSubset<NotionOAuthErrorCode>,
  AssertSubset<NotionTemplateErrorCode>,
  AssertSubset<GithubConfigErrorCode>,
  AssertSubset<GithubGenerateErrorCode>,
  AssertSubset<GithubPagesErrorCode>,
  AssertSubset<GithubSyncErrorCode>,
  AssertSubset<GithubDeployErrorCode>,
  AssertSubset<GithubActionsSecretsErrorCode>,
] = [true, true, true, true, true, true, true, true];

const STAGE_TUPLES = [
  ['flow', FLOW_FAILURE_CODES],
  ['notion', NOTION_FAILURE_CODES],
  ['github', GITHUB_FAILURE_CODES],
  ['generate', GENERATE_FAILURE_CODES],
  ['provision', PROVISION_FAILURE_CODES],
] as const;

const ALL_CODES: ProvisioningFailureCode[] = STAGE_TUPLES.flatMap(([, codes]) => [...codes]);

describe('registry completeness', () => {
  test('every tuple code is registered, and the guard round-trips', () => {
    for (const code of ALL_CODES) {
      expect(isProvisioningFailureCode(code)).toBe(true);
      expect(FAILURE_REGISTRY[code]).toBeDefined();
      expect(isProvisioningFailureCode(FAILURE_REGISTRY[code])).toBe(false);
    }
  });

  test('the merged registry holds exactly the union of the tuples', () => {
    expect(new Set(ALL_CODES).size).toBe(ALL_CODES.length);
    expect(Object.keys(FAILURE_REGISTRY).length).toBe(ALL_CODES.length);
  });

  test('the guard rejects non-codes', () => {
    expect(isProvisioningFailureCode('github_state_missing ')).toBe(false);
    expect(isProvisioningFailureCode('github_code_missing')).toBe(false);
    expect(isProvisioningFailureCode(undefined)).toBe(false);
    expect(isProvisioningFailureCode(null)).toBe(false);
    expect(isProvisioningFailureCode(42)).toBe(false);
  });

  test('every code reports the stage that owns it', () => {
    for (const [stage, codes] of STAGE_TUPLES) {
      for (const code of codes) {
        expect(failureStage(code)).toBe(stage);
      }
    }
  });

  test('accessors agree with the registry', () => {
    for (const code of ALL_CODES) {
      expect(failureDescriptor(code)).toBe(FAILURE_REGISTRY[code]);
      expect(userCopy(code)).toBe(FAILURE_REGISTRY[code].user);
    }
  });

  test('failureSupport joins registry metadata with the caller\u2019s correlation id', () => {
    const support = failureSupport('github_pages_validation_failed', 'job-123');
    expect(support).toEqual({
      code: 'github_pages_validation_failed',
      stage: 'provision',
      area: 'github',
      jobId: 'job-123',
      note: FAILURE_REGISTRY.github_pages_validation_failed.support.note,
    });
  });
});

describe('descriptor discriminant', () => {
  test('a code is retryable exactly when its recovery is retry_step', () => {
    for (const code of ALL_CODES) {
      const descriptor = FAILURE_REGISTRY[code];
      expect(descriptor.recovery === 'retry_step').toBe(descriptor.retryable);
      if (descriptor.retryable) expect(descriptor.recovery).toBe('retry_step');
      else expect(descriptor.recovery).not.toBe('retry_step');
    }
  });

  test('every terminal recovery names a path that does not dead-end', () => {
    for (const code of ALL_CODES) {
      const descriptor = FAILURE_REGISTRY[code];
      if (descriptor.retryable) continue;
      const terminal = descriptor.recovery;
      const actionable = terminal === 'restart_flow'
        || terminal === 'contact_support'
        || (typeof terminal === 'object' && terminal.kind === 'user_action' && terminal.action.length > 0);
      expect(actionable).toBe(true);
    }
  });
});

describe('copy hygiene', () => {
  const PROVIDER_DOMAINS = ['api.github.com', 'github.com', 'api.notion.com', 'notion.so'];

  function assertClean(text: string): void {
    expect(text.toLowerCase()).not.toContain('bearer');
    expect(text.toLowerCase()).not.toContain('http');
    expect(text).not.toMatch(/[0-9a-f]{16,}/iu);
    expect(text).not.toMatch(/\d{6,}/u);
    for (const domain of PROVIDER_DOMAINS) {
      expect(text.toLowerCase()).not.toContain(domain);
    }
  }

  test('no secret or provider detail leaks into user copy or support notes', () => {
    for (const code of ALL_CODES) {
      const descriptor = FAILURE_REGISTRY[code];
      assertClean(descriptor.user.message);
      assertClean(descriptor.user.action);
      assertClean(descriptor.support.note);
    }
  });
});

describe('issue scenarios', () => {
  test('name taken is a terminal conflict', () => {
    expect(FAILURE_REGISTRY.github_generate_name_exhausted).toMatchObject({ retryable: false, httpStatus: 409 });
  });

  test('page unshared is a terminal user action on a 403', () => {
    expect(FAILURE_REGISTRY.notion_template_root_unshared).toMatchObject({
      retryable: false,
      httpStatus: 403,
      recovery: { kind: 'user_action' },
    });
  });

  test('access revoked mid-flow is terminal for app-auth and pages', () => {
    expect(FAILURE_REGISTRY.github_app_auth_failed).toMatchObject({ retryable: false, httpStatus: 502 });
    expect(FAILURE_REGISTRY.github_pages_permission_denied).toMatchObject({ retryable: false, httpStatus: 403 });
  });

  test('pages 422 is terminal support work', () => {
    expect(FAILURE_REGISTRY.github_pages_validation_failed).toMatchObject({
      retryable: false,
      httpStatus: 422,
      recovery: 'contact_support',
    });
  });

  test('org install refused is a terminal 403', () => {
    expect(FAILURE_REGISTRY.github_organization_installation_not_supported).toMatchObject({
      retryable: false,
      httpStatus: 403,
    });
  });

  test('rate limits are retryable 429s', () => {
    expect(FAILURE_REGISTRY.github_rate_limited).toMatchObject({
      retryable: true,
      recovery: 'retry_step',
      httpStatus: 429,
    });
    expect(FAILURE_REGISTRY.github_pages_rate_limited).toMatchObject({
      retryable: true,
      recovery: 'retry_step',
      httpStatus: 429,
    });
  });

  test('duplicate callbacks are terminal 400s on both providers', () => {
    expect(FAILURE_REGISTRY.github_state_replayed).toMatchObject({ retryable: false, httpStatus: 400 });
    expect(FAILURE_REGISTRY.notion_state_replayed).toMatchObject({ retryable: false, httpStatus: 400 });
  });
});

describe('FlowFailure', () => {
  test('carries its code and classifies as terminal', () => {
    const failure = new FlowFailure('github_account_mismatch');
    expect(failure).toBeInstanceOf(Error);
    expect(failure.code).toBe('github_account_mismatch');
    expect(classifyProvisioningError(failure)).toEqual({
      code: 'github_account_mismatch',
      retryable: false,
      retryAfterSeconds: null,
    });
  });

  test('resolves through the callback mapper to its registry status', () => {
    const failure = callbackFailure(new FlowFailure('github_organization_installation_not_supported'), 'github');
    expect(failure).toEqual({
      code: 'github_organization_installation_not_supported',
      status: 403,
      retryAfterSeconds: null,
      details: null,
    });
  });
});

describe('classifyProvisioningError', () => {
  test('falls back to a retryable step failure for uncoded errors', () => {
    expect(classifyProvisioningError(new TypeError('network blip'))).toEqual({
      code: 'provisioning_step_failed',
      retryable: true,
      retryAfterSeconds: null,
    });
  });

  test('classifies app-auth failures from the code derived at the throw site', () => {
    expect(classifyProvisioningError(new GithubAppAuthError(429))).toEqual({
      code: 'github_rate_limited',
      retryable: true,
      retryAfterSeconds: null,
    });
    expect(classifyProvisioningError(new GithubAppAuthError(503))).toEqual({
      code: 'github_app_unavailable',
      retryable: true,
      retryAfterSeconds: null,
    });
    expect(classifyProvisioningError(new GithubAppAuthError(404))).toEqual({
      code: 'github_app_auth_failed',
      retryable: false,
      retryAfterSeconds: null,
    });
  });

  test('reads retry-after structurally from the error instance', () => {
    class RetryableError extends Error {
      readonly code = 'github_pages_rate_limited';
      readonly retryAfterSeconds: number | null;
      constructor(retryAfterSeconds: number | null) {
        super('github_pages_rate_limited');
        this.retryAfterSeconds = retryAfterSeconds;
      }
    }
    expect(classifyProvisioningError(new RetryableError(42)).retryAfterSeconds).toBe(42);
    expect(classifyProvisioningError(new RetryableError(null)).retryAfterSeconds).toBeNull();
  });
});

describe('failureCause', () => {
  test('exposes only the code and provider status class', () => {
    class CodedError extends Error {
      readonly code = 'github_sync_run_failed';
      readonly status = 502;
      constructor() {
        super('github_sync_run_failed');
      }
    }
    expect(failureCause(new CodedError())).toEqual({ code: 'github_sync_run_failed', providerStatus: 502 });
    expect(failureCause(new TypeError('network blip'))).toEqual({ code: null, providerStatus: null });
    expect(failureCause(null)).toEqual({ code: null, providerStatus: null });
  });
});

describe('callbackFailure', () => {
  test('falls back per context for uncoded errors', () => {
    expect(callbackFailure(new TypeError('kv blip'), 'github')).toEqual({
      code: 'github_authorization_unavailable',
      status: 502,
      retryAfterSeconds: null,
      details: null,
    });
    expect(callbackFailure(new TypeError('kv blip'), 'notion')).toEqual({
      code: 'notion_unavailable',
      status: 502,
      retryAfterSeconds: null,
      details: null,
    });
  });

  test('keeps non-secret remediation details from coded errors only', () => {
    class DetailedError extends Error {
      readonly code = 'notion_template_schema_invalid';
      readonly details = { remediation: 'Restore the databases, then reconnect.' };
      constructor() {
        super('notion_template_schema_invalid');
      }
    }
    expect(callbackFailure(new DetailedError(), 'notion')).toEqual({
      code: 'notion_template_schema_invalid',
      status: 422,
      retryAfterSeconds: null,
      details: { remediation: 'Restore the databases, then reconnect.' },
    });
  });
});

/**
 * Orphan-row lint: a registry entry only earns its place if some site in
 * src/ can actually produce it. See docs/decisions/0006-failure-taxonomy-
 * followups.md for why the module `ErrorCode` unions above aren't proof by
 * themselves — a union member is a declared possibility, not evidence
 * anything throws or returns it. This scans src/ for the shapes that do
 * carry that evidence: a literal passed to one of the taxonomy's throwable
 * classes, a literal assigned to a `code` field, and a literal `return` or
 * ternary branch inside a function that resolves a code (`admissionFailureCode`,
 * `GithubAppAuthError`). Every entry above already proves module codes are a
 * taxonomy subset; this proves the taxonomy has no member none of them ever
 * reach.
 */
describe('orphan rows', () => {
  const PRODUCING_CLASSES = [
    'FlowFailure',
    'GithubActionsSecretsError',
    'GithubConfigError',
    'GithubDeployError',
    'GithubGenerateError',
    'GithubPagesError',
    'GithubSyncError',
    'NotionOAuthError',
    'NotionTemplateError',
  ];
  const CODE = '([a-z][a-z0-9_]*)';
  const PRODUCING_PATTERNS = [
    new RegExp(`\\bnew (?:${PRODUCING_CLASSES.join('|')})\\(\\s*'${CODE}'`, 'gu'),
    new RegExp(`(?<![A-Za-z])code:\\s*'${CODE}'`, 'gu'),
    new RegExp(`\\breturn\\s+'${CODE}'`, 'gu'),
    new RegExp(`\\?\\s*'${CODE}'\\s*:\\s*'${CODE}'`, 'gu'),
  ];

  /** Every code from `knownCodes` that a producing shape in `text` names. */
  function producedCodes(text: string, knownCodes: ReadonlySet<string>): Set<string> {
    const produced = new Set<string>();
    for (const pattern of PRODUCING_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        for (const group of match.slice(1)) {
          if (group !== undefined && knownCodes.has(group)) produced.add(group);
        }
      }
    }
    return produced;
  }

  test('the scanner recognizes a construction, a code field, a return, and a chained ternary', () => {
    const known = new Set([
      'github_state_missing', 'github_config_conflict', 'provisioning_paused',
      'github_app_unavailable', 'github_app_auth_failed', 'never_written',
    ]);
    const text = [
      `throw new FlowFailure('github_state_missing');`,
      `return failureResponse({ code: 'github_config_conflict', status: 409, retryAfterSeconds: null });`,
      `function pick(): ProvisioningFailureCode { return 'provisioning_paused'; }`,
      `this.code = status === 429 ? 'github_rate_limited' : status >= 500 ? 'github_app_unavailable' : 'github_app_auth_failed';`,
    ].join('\n');
    expect(producedCodes(text, known)).toEqual(new Set([
      'github_state_missing', 'github_config_conflict', 'provisioning_paused',
      'github_app_unavailable', 'github_app_auth_failed',
    ]));
  });

  test('every registry code has a producing site in src/', () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const registryFile = join(srcDir, 'failures.ts');

    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith('.ts') && path !== registryFile ? [path] : [];
    });

    const knownCodes = new Set(ALL_CODES);
    const reachable = new Set<string>();
    for (const file of walk(srcDir)) {
      for (const code of producedCodes(readFileSync(file, 'utf8'), knownCodes)) reachable.add(code);
    }

    const orphans = ALL_CODES.filter((code) => !reachable.has(code));
    expect(orphans).toEqual([]);
  });
});
