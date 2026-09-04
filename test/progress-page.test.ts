import { describe, expect, test } from 'bun:test';

import { createProvisioningJob, PROVISIONING_STEP_ORDER, type ProvisioningJob } from '../src/provisioning-job';
import type { ProvisioningFailureCode } from '../src/failures';
import { projectProvisioning, type ProgressSnapshot } from '../src/progress';
import {
  progressPage,
  PROGRESS_POLL_BASE_INTERVAL_FLOOR,
  PROGRESS_POLL_INTERVAL_MS,
  PROGRESS_POLL_MAX_INTERVAL_MS,
} from '../src/progress-page';

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

function failFirst(job: ProvisioningJob, code: ProvisioningFailureCode): void {
  job.steps.verify_repository = {
    ...job.steps.verify_repository,
    status: 'failed',
    attempts: 5,
    lastError: { code, retryable: false },
  };
}

const ACTIVE = snapshotFor('queued');
const AWAITING = snapshotFor('awaiting_notion');
const NOTION_LINKS = {
  pagesUrl: 'https://www.notion.so/alice/Pages-11111111111141118111111111111111',
  postsUrl: 'https://www.notion.so/alice/Posts-22222222222242228222222222222222',
  templateRootUrl: 'https://www.notion.so/alice/My-Site-Home',
};
const SUCCEEDED = snapshotFor('succeeded', succeedAll);
const SUCCEEDED_LINKS = snapshotFor('succeeded', (job) => {
  succeedAll(job);
  job.data.notionLinks = NOTION_LINKS;
});
const SUCCEEDED_PROJECT = snapshotFor('succeeded', (job) => {
  succeedAll(job);
  job.data.notionLinks = NOTION_LINKS;
  job.data.repository = {
    name: 'alice-inkdrafts',
    url: 'https://alice.github.io/alice-inkdrafts',
    baseurl: '/alice-inkdrafts',
    kind: 'project',
  };
  job.data.generatedRepository = {
    ...job.data.generatedRepository,
    fullName: 'alice/alice-inkdrafts',
    name: 'alice-inkdrafts',
    htmlUrl: 'https://github.com/alice/alice-inkdrafts',
  };
});
const FAILED = snapshotFor('dead_letter', (job) => failFirst(job, 'github_rate_limited'));
const MISSING: ProgressSnapshot = projectProvisioning(null, NOW);

describe('progress page', () => {
  test('is a complete document with one landmark structure and one top-level heading', () => {
    for (const snapshot of [ACTIVE, AWAITING, SUCCEEDED, FAILED, MISSING]) {
      const page = progressPage('job-123', snapshot);
      expect(page.startsWith('<!doctype html>')).toBe(true);
      expect(page).toContain('<html lang="en">');
      expect(page).toContain('class="skip-link" href="#main-content"');
      expect(page).toContain('<main id="main-content"');
      expect(page.match(/<h1[ >]/gu)).toHaveLength(1);
      expect(page.match(/role="status" aria-live="polite"/gu)).toHaveLength(1);
    }
  });

  test('renders every state panel and hides the ones the snapshot is not in', () => {
    const page = progressPage('job-123', ACTIVE);
    for (const status of ['active', 'awaiting_notion', 'succeeded', 'failed', 'missing']) {
      const expected = status === 'active' ? ' data-panel="active">' : ` data-panel="${status}" hidden>`;
      expect(page).toContain(expected);
    }
    expect(progressPage('job-123', SUCCEEDED)).toContain(' data-panel="succeeded">');
    expect(progressPage('job-123', MISSING)).toContain(' data-panel="missing">');
  });

  test('carries the seven-row checklist with per-row state and text state words', () => {
    const page = progressPage('job-123', ACTIVE);
    expect(page.match(/<li data-stage-id=/gu)).toHaveLength(7);
    expect(page).toContain('data-state="current"');
    expect(page).toContain('<span class="stage-state">In progress</span>');
    const done = progressPage('job-123', SUCCEEDED);
    expect(done.match(/<li data-stage-id="[^"]*" data-state="done"/gu)).toHaveLength(7);
    expect(progressPage('job-123', FAILED)).toContain('data-state="blocked"');
  });

  test('meta refresh appears only for non-terminal snapshots and honors the cadence hint', () => {
    const waiting = snapshotFor('queued', (job) => {
      job.wait = { reason: 'global_throttled', untilMs: NOW + 90_000, updatedAt: NOW };
    });

    expect(progressPage('job-123', ACTIVE))
      .toContain(`<noscript><meta http-equiv="refresh" content="${PROGRESS_POLL_BASE_INTERVAL_FLOOR}"></noscript>`);
    expect(progressPage('job-123', waiting)).toContain('<meta http-equiv="refresh" content="90">');
    expect(progressPage('job-123', AWAITING)).toContain('<meta http-equiv="refresh"');
    for (const snapshot of [SUCCEEDED, FAILED, MISSING]) {
      expect(progressPage('job-123', snapshot)).not.toContain('http-equiv="refresh"');
    }
  });

  test('disables the pulse animation under prefers-reduced-motion', () => {
    const page = progressPage('job-123', ACTIVE);
    expect(page).toContain('@media (prefers-reduced-motion: reduce)');
    expect(page.indexOf('@media (prefers-reduced-motion: reduce)'))
      .toBeGreaterThan(page.indexOf('@keyframes pulse'));
  });

  test('ships exactly one executable inline script and one JSON island, none fetched', () => {
    const page = progressPage('job-123', ACTIVE);
    expect(page.match(/<script>/gu)).toHaveLength(1);
    expect(page.match(/<script type="application\/json" id="progress-data">/gu)).toHaveLength(1);
    expect(page).not.toMatch(/<script[^>]*\ssrc=/u);
    expect(page).not.toMatch(/\ssrc="https?:/u);
    expect(page).toContain(`const POLL_MS = ${PROGRESS_POLL_INTERVAL_MS}`);
    expect(page).toContain(`const POLL_MAX_MS = ${PROGRESS_POLL_MAX_INTERVAL_MS}`);
    expect(page).not.toContain('innerHTML');
    expect(page).not.toContain('document.write');
  });

  test('makes no request outside the origin', () => {
    for (const snapshot of [ACTIVE, AWAITING, SUCCEEDED, FAILED, MISSING]) {
      const page = progressPage('job-123', snapshot);
      // The island may carry the allowlisted site and repository URLs as data;
      // the executable script must not reference any absolute URL at all.
      const script = page.slice(page.lastIndexOf('<script>'));
      expect(script).not.toMatch(/https?:\/\//u);
      expect(page).toContain('data-status-url="/progress/status?job_id=job-123"');
      expect(page).toContain('href="/connect/notion?job_id=job-123"');
    }
  });

  test('success renders the site link, the repository link, and the checklist complete', () => {
    const page = progressPage('job-123', SUCCEEDED);
    expect(page).toContain('<h1 id="progress-heading">Your site is live</h1>');
    expect(page).toContain('href="https://alice.github.io"');
    expect(page).toContain('href="https://github.com/alice/alice.github.io"');
    expect(page).toContain('alice.github.io</a>');
    expect(page).toContain('data-state="done"');
  });

  test('the success screen names its sections and keeps every promised affordance', () => {
    const page = progressPage('job-123', SUCCEEDED_LINKS);
    expect(page).toContain('<h2>Everyday writing happens in Notion</h2>');
    expect(page).toContain('<h2>Your site is a repository you own</h2>');
    expect(page).toContain('>View your site</a>');
    // The propagation line is always present, even though succeeded means the
    // server verified the site at publish time.
    expect(page).toContain('We checked that your site was live right before publishing finished.');
    expect(page).toContain('GitHub’s network may still be updating it. It is usually ready within a few minutes.');
    expect(page).toContain('Changes you make in Notion appear on your site automatically. Syncing runs about every 10 minutes.');
    expect(page).toContain('<a href="/status">your dashboard</a>');
    expect(page).toContain('href="https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site"');
    expect(page).toContain('Writing happens in Notion, so you never need GitHub for your everyday work.');
    expect(page).toContain('your site keeps working even if InkDrafts disappears.');
  });

  test('captured Notion links render as real anchors with their fallbacks hidden', () => {
    const page = progressPage('job-123', SUCCEEDED_LINKS);
    expect(page).toContain('<a id="notion-root-link" href="https://www.notion.so/alice/My-Site-Home">Open in Notion</a>');
    expect(page).toContain('<a id="notion-pages-link" href="https://www.notion.so/alice/Pages-11111111111141118111111111111111">Open in Notion</a>');
    expect(page).toContain('<a id="notion-posts-link" href="https://www.notion.so/alice/Posts-22222222222242228222222222222222">Open in Notion</a>');
    for (const id of ['notion-root-link-missing', 'notion-pages-link-missing', 'notion-posts-link-missing']) {
      expect(page).toContain(`id="${id}" class="notion-missing" hidden`);
    }
  });

  test('a null Notion link renders linkless fallback copy and never an empty href', () => {
    const page = progressPage('job-123', SUCCEEDED);
    for (const id of ['notion-root-link', 'notion-pages-link', 'notion-posts-link']) {
      expect(page).not.toContain(`<a id="${id}"`);
      expect(page).toContain(`id="${id}-missing" class="notion-missing">`);
    }
    expect(page).toContain('We could not capture a link here. You can find this page in your Notion workspace.');
    expect(page).not.toContain('href=""');
  });

  test('pins the exact live URL for both the apex and the project destination', () => {
    expect(progressPage('job-123', SUCCEEDED_LINKS))
      .toContain('<a id="site-link" class="cta" href="https://alice.github.io">View your site</a>');
    const project = progressPage('job-123', SUCCEEDED_PROJECT);
    expect(project).toContain('<a id="site-link" class="cta" href="https://alice.github.io/alice-inkdrafts">View your site</a>');
    expect(project).toContain('href="https://github.com/alice/alice-inkdrafts"');
  });

  test('failure renders taxonomy copy, the blocked stage, and a conditional restart link', () => {
    const page = progressPage('job-123', FAILED);
    expect(page).toContain('GitHub is temporarily limiting requests while we set up your site.');
    expect(page).toContain('We’ll keep trying automatically. If setup does not finish, start again later.');
    expect(page).toContain('id="failed-restart" class="cta" href="/connect/github" hidden');

    const restarting = snapshotFor('dead_letter', (job) => {
      job.steps.verify_repository = {
        ...job.steps.verify_repository,
        status: 'failed',
        attempts: 5,
        lastError: { code: 'github_sync_run_failed', retryable: false },
      };
    });
    expect(progressPage('job-123', restarting)).toContain(
      '<a id="failed-restart" class="cta" href="/connect/github">Connect GitHub to start again</a>',
    );
  });

  test('the poll script rewrites each panel’s dynamic text so a polled transition is not blank', () => {
    const page = progressPage('job-123', ACTIVE);
    const script = page.slice(page.lastIndexOf('<script>'));
    expect(script).toContain("setText('failed-message', progress.message)");
    expect(script).toContain("setText('failed-action', progress.action)");
    expect(script).toContain("setText('missing-message', progress.message)");
    expect(script).toContain("setText('missing-action', progress.action)");
    expect(script).toContain("setLink('site-link', progress.site.url)");
    expect(script).toContain("setLink('repository-link', progress.repository.url, progress.repository.name)");
    expect(script).toContain("setNotionLink('notion-root-link', progress.notionLinks.templateRootUrl)");
    expect(script).toContain("setNotionLink('notion-pages-link', progress.notionLinks.pagesUrl)");
    expect(script).toContain("setNotionLink('notion-posts-link', progress.notionLinks.postsUrl)");
  });

  test('polling stops at terminal and never navigates the page', () => {
    const script = progressPage('job-123', SUCCEEDED).slice(progressPage('job-123', SUCCEEDED).lastIndexOf('<script>'));
    // One guard in poll(), one after the initial render: both stop scheduling
    // at terminal, and no branch navigates or refreshes.
    expect(script.match(/if \(isTerminal\(snapshot\)\) return;/gu)).toHaveLength(2);
    expect(script).not.toContain('location.');
    expect(script).not.toContain('window.open');
  });

  test('escapes snapshot data in text, attributes, and the JSON island', () => {
    const hostile = snapshotFor('succeeded', (job) => {
      succeedAll(job);
      job.data.generatedRepository.name = 'alice<script>alert(1)</script>';
      job.data.generatedRepository.htmlUrl = 'https://github.com/alice/repo" onmouseover="alert(1)';
      job.data.repository = { ...job.data.repository, url: 'https://alice.github.io/" onmouseover="alert(6)' };
      job.data.notionLinks = {
        pagesUrl: 'https://www.notion.so/pages" onmouseover="alert(3)',
        postsUrl: 'https://www.notion.so/posts\' onload="alert(4)',
        templateRootUrl: 'https://www.notion.so/root" onclick="alert(5)',
      };
    });
    const page = progressPage('job-123', hostile);

    expect(page).toContain('alice&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).toContain('href="https://github.com/alice/repo&quot; onmouseover=&quot;alert(1)"');
    expect(page).toContain('href="https://alice.github.io/&quot; onmouseover=&quot;alert(6)"');
    expect(page).toContain('href="https://www.notion.so/pages&quot; onmouseover=&quot;alert(3)"');
    expect(page).toContain('href="https://www.notion.so/posts&#39; onload=&quot;alert(4)"');
    expect(page).toContain('href="https://www.notion.so/root&quot; onclick=&quot;alert(5)"');
    expect(page).toContain('alice\\u003cscript>alert(1)\\u003c/script>');
    expect(progressPage('job-1" <script>', MISSING)).toContain(
      'data-status-url="/progress/status?job_id=job-1%22%20%3Cscript%3E"',
    );
    expect(progressPage('job-1" <script>', MISSING)).toContain(
      'data-site-check-url="/progress/site-check?job_id=job-1%22%20%3Cscript%3E"',
    );
  });

  test('the aria-live region announces the current headline while active and the message when failed', () => {
    expect(progressPage('job-123', ACTIVE)).toContain('>Preparing your site settings.</p>');
    expect(progressPage('job-123', AWAITING)).toContain('>Connecting Notion.</p>');
    expect(progressPage('job-123', FAILED)).toContain(
      '<p id="progress-live" role="status" aria-live="polite">GitHub is temporarily limiting requests while we set up your site.</p>',
    );
  });

  test('the document title starts as the headline while active and the heading when done', () => {
    expect(progressPage('job-123', ACTIVE)).toContain('<title>Preparing your site settings.</title>');
    expect(progressPage('job-123', SUCCEEDED)).toContain('<title>Your site is live</title>');
  });
});
