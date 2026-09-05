/**
 * Automated accessibility gate: every representative page state is scanned
 * with axe-core inside jsdom and must report zero serious or critical
 * violations. Layout-dependent checks (notably color contrast) resolve as
 * "incomplete" rather than violations without a real layout engine, so the
 * manual matrix in docs/accessibility.md covers those in a real browser.
 *
 * The canary scan proves the gate can fail: a document with planted
 * structural violations must be reported, so a future harness regression
 * cannot silently scan nothing.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

import type { ProvisioningFailureCode } from '../src/failures';
import { LANDING_PAGE } from '../src/landing-page';
import { POLICY_PAGES, POLICY_PATHS } from '../src/policy-pages';
import { createProvisioningJob, PROVISIONING_STEP_ORDER, type ProvisioningJob } from '../src/provisioning-job';
import { progressPage, type SiteCheckOutcome } from '../src/progress-page';
import { projectProvisioning, type ProgressSnapshot } from '../src/progress';
import { statusPage, statusRefusalPage, type StatusPageChrome, type StatusPageModel } from '../src/status-page';
import type { DeployOutcome, SiteStatus, SyncOutcome } from '../src/status';

const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

// jsdom's "not implemented" notices (pseudo-element styles, canvas) are
// expected here and must not pollute the test output.
const silentConsole = new VirtualConsole();

interface AxeNode {
  readonly target: readonly string[];
}

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly nodes: readonly AxeNode[];
}

/** Runs axe against a full document and returns only its violations. */
function runAxe(documentHtml: string): Promise<readonly AxeViolation[]> {
  const { window } = new JSDOM(documentHtml, { pretendToBeVisual: true, runScripts: 'outside-only', virtualConsole: silentConsole });
  // jsdom has no layout engine, so hit-testing has no real answer; an empty
  // result degrades the dependent checks to "incomplete" instead of crashing.
  (window.document as unknown as { elementsFromPoint: () => unknown[] }).elementsFromPoint = () => [];
  window.eval(axeSource);
  const axe = window.eval('axe') as {
    run: (context: Document, options: object, callback: (error: Error | null, results: { violations: AxeViolation[] }) => void) => void;
  };
  return new Promise((resolve, reject) => {
    axe.run(window.document, { resultTypes: ['violations'] }, (error, results) => {
      if (error) reject(error);
      else resolve(results.violations);
      window.close();
    });
  });
}

function seriousOrCritical(violations: readonly AxeViolation[]): readonly AxeViolation[] {
  return violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
}

/** One line per violation so a CI failure names the rule, its impact, and
 * the selectors it hit, prefixed by the scanned state. */
function violationReport(label: string, violations: readonly AxeViolation[]): readonly string[] {
  return violations.map((violation) =>
    `[${label}] ${violation.id} (${violation.impact}): ${violation.help} at ${violation.nodes.map((node) => node.target.join(' ')).join('; ')}`);
}

async function expectAccessible(label: string, documentHtml: string): Promise<void> {
  const serious = seriousOrCritical(await runAxe(documentHtml));
  expect(violationReport(label, serious)).toEqual([]);
}

const CANARY = `<!doctype html>
<html>
<head><title>canary</title></head>
<body>
<img src="logo.png">
<input type="text">
<button></button>
</body>
</html>`;

describe('accessibility suite', () => {
  test('the scanner reports planted structural violations', async () => {
    const serious = seriousOrCritical(await runAxe(CANARY));
    const rules = new Set(serious.map((violation) => violation.id));
    expect(rules.has('image-alt')).toBe(true);
    expect(rules.has('label')).toBe(true);
    expect(rules.has('button-name')).toBe(true);
  });

  test('landing page has no serious or critical violations', async () => {
    await expectAccessible('landing', LANDING_PAGE);
  });

  test('every progress state has no serious or critical violations', async () => {
    for (const [label, documentHtml] of Object.entries(progressStates())) {
      await expectAccessible(`progress/${label}`, documentHtml);
    }
  });

  test('every status state has no serious or critical violations', async () => {
    for (const [label, documentHtml] of Object.entries(statusStates())) {
      await expectAccessible(`status/${label}`, documentHtml);
    }
  });

  test('every policy page has no serious or critical violations', async () => {
    for (const path of POLICY_PATHS) {
      await expectAccessible(`policy${path}`, POLICY_PAGES[path]!.document);
    }
  });
});

const NOW = 1_000_000;

function baseJob(): ProvisioningJob {
  return createProvisioningJob({
    jobId: 'job-123',
    installationId: 1,
    identity: { id: 1, login: 'alice', accountType: 'User' },
    repository: { name: 'alice.github.io', url: 'https://alice.github.io', baseurl: '', kind: 'apex' },
    generatedRepository: {
      id: 1001,
      fullName: 'alice/alice.github.io',
      name: 'alice.github.io',
      htmlUrl: 'https://github.com/alice/alice.github.io',
      defaultBranch: 'main',
      templateFullName: 'inkdrafts/notiongit-template',
      templateHeadSha: null,
      templateHeadTreeSha: null,
      headSha: null,
      headTreeSha: null,
      reused: false,
    },
    now: NOW,
  });
}

function snapshotFor(status: ProvisioningJob['status'], mutate: (job: ProvisioningJob) => void = () => {}): ProgressSnapshot {
  const job = baseJob();
  if (status !== 'awaiting_notion') {
    job.data.notionSecretsWrittenAt = NOW + 1;
    job.wait = { reason: 'global_throttled', untilMs: null, updatedAt: NOW };
  }
  mutate(job);
  job.status = status;
  return projectProvisioning(job, NOW + 10);
}

function succeedAll(job: ProvisioningJob): void {
  for (const step of PROVISIONING_STEP_ORDER) {
    job.steps[step] = { ...job.steps[step], status: 'succeeded', attempts: 1 };
  }
}

function failStep(job: ProvisioningJob, code: ProvisioningFailureCode): void {
  job.steps.verify_repository = {
    ...job.steps.verify_repository,
    status: 'failed',
    attempts: 5,
    lastError: { code, retryable: false },
  };
}

const NOTION_LINKS = {
  pagesUrl: 'https://www.notion.so/alice/Pages-11111111111141118111111111111111',
  postsUrl: 'https://www.notion.so/alice/Posts-22222222222242228222222222222222',
  templateRootUrl: 'https://www.notion.so/alice/My-Site-Home',
};

function progressStates(): Record<string, string> {
  const siteCheck: SiteCheckOutcome = { reachable: true, checkedAt: NOW + 20 };
  const siteCheckNotYet: SiteCheckOutcome = { reachable: false, checkedAt: NOW + 20 };
  return {
    active_notice: progressPage('job-123', snapshotFor('queued')),
    active_plain: progressPage('job-123', snapshotFor('queued', (job) => {
      job.wait = null;
    })),
    awaiting_notion: progressPage('job-123', snapshotFor('awaiting_notion')),
    succeeded: progressPage('job-123', snapshotFor('succeeded', (job) => {
      succeedAll(job);
      job.data.notionLinks = NOTION_LINKS;
    })),
    succeeded_checked: progressPage('job-123', snapshotFor('succeeded', (job) => {
      succeedAll(job);
      job.data.notionLinks = NOTION_LINKS;
    }), siteCheck),
    succeeded_not_up_yet: progressPage('job-123', snapshotFor('succeeded', (job) => {
      succeedAll(job);
      job.data.notionLinks = NOTION_LINKS;
    }), siteCheckNotYet),
    succeeded_links_missing: progressPage('job-123', snapshotFor('succeeded', succeedAll)),
    failed_restart: progressPage('job-123', snapshotFor('dead_letter', (job) => {
      failStep(job, 'github_identity_missing');
    })),
    failed_support: progressPage('job-123', snapshotFor('dead_letter', (job) => {
      failStep(job, 'github_rate_limited');
    })),
    missing: progressPage('job-123', projectProvisioning(null, NOW)),
  };
}

const REPOSITORY = { name: 'alice.github.io', url: 'https://github.com/alice/alice.github.io' };
const SITE = { url: 'https://alice.github.io' };

function siteStatus(sync: SyncOutcome, deploy: DeployOutcome, runInFlight = false): SiteStatus {
  return { repository: REPOSITORY, site: SITE, sync, deploy, runInFlight };
}

const CHROME: StatusPageChrome = { notice: null, rerunFormToken: null };

function statusStates(): Record<string, string> {
  const entry: StatusPageModel = { kind: 'entry' };
  const session = (sync: SyncOutcome, deploy: DeployOutcome, runInFlight = false): StatusPageModel => ({
    kind: 'session',
    viewer: { login: 'alice' },
    site: siteStatus(sync, deploy, runInFlight),
  });
  const noSite: StatusPageModel = { kind: 'no_site', viewer: { login: 'alice' } };
  return {
    entry: statusPage(entry, CHROME),
    entry_signin_required: statusPage(entry, { notice: 'signin_required', rerunFormToken: null }),
    session_idle: statusPage(session(
      { kind: 'never_ran' },
      { kind: 'never_built' },
    ), CHROME),
    session_running: statusPage(session(
      { kind: 'running', startedAtMs: 1, runUrl: 'https://github.com/alice/alice.github.io/actions/runs/9' },
      { kind: 'building' },
      true,
    ), { notice: 'already_running', rerunFormToken: 'token' }),
    session_synced: statusPage(session(
      { kind: 'succeeded', finishedAtMs: 2, runUrl: null },
      { kind: 'built', commitSha: 'abc123' },
    ), { notice: 'sync_triggered', rerunFormToken: 'token' }),
    session_failed: statusPage(session(
      { kind: 'failed', conclusion: 'failure', finishedAtMs: 3, runUrl: null },
      { kind: 'errored' },
    ), CHROME),
    no_site: statusPage(noSite, CHROME),
    installation_gone: statusPage({ kind: 'installation_gone', viewer: { login: 'alice' } }, CHROME),
    installation_suspended: statusPage({ kind: 'installation_suspended', viewer: { login: 'alice' } }, CHROME),
    github_unavailable: statusPage({ kind: 'github_unavailable', retryAfterSeconds: 120 }, CHROME),
    github_unavailable_no_hint: statusPage({ kind: 'github_unavailable', retryAfterSeconds: null }, CHROME),
    auth_denied: statusPage({ kind: 'auth_failed', reason: 'denied' }, CHROME),
    auth_state_invalid: statusPage({ kind: 'auth_failed', reason: 'state_invalid' }, CHROME),
    auth_no_installation: statusPage({ kind: 'auth_failed', reason: 'no_installation' }, CHROME),
    refusal: statusRefusalPage({
      title: 'Too many requests',
      body: 'InkDrafts is handling a lot of sign-ins right now.',
      retryAfterSeconds: 60,
    }),
    refusal_no_hint: statusRefusalPage({
      title: 'Service unavailable',
      body: 'A short outage is in progress.',
      retryAfterSeconds: null,
    }),
  };
}
