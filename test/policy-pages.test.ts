/**
 * The policy documents must stay reachable before consent and must keep
 * describing what the implementation actually does. The reachability tests
 * fail if a consent entry surface loses its links; the claim tests fail if a
 * retention or token claim drifts from the constant or documented platform
 * figure it describes.
 */
import { describe, expect, test } from 'bun:test';

import { errorPage } from '../src/error-page';
import { LANDING_PAGE } from '../src/landing-page';
import { POLICY_PAGES, POLICY_PATHS } from '../src/policy-pages';
import { PROVISIONING_JOB_TTL_SECONDS } from '../src/provisioning-job';
import { progressPage } from '../src/progress-page';
import { projectProvisioning } from '../src/progress';
import { createProvisioningJob } from '../src/provisioning-job';
import { STATUS_SESSION_TTL_SECONDS } from '../src/status';
import { statusPage, type StatusPageChrome, type StatusPageModel } from '../src/status-page';
import { route } from '../src/index';

const JOB_RETENTION_HOURS = String(PROVISIONING_JOB_TTL_SECONDS / 3600);
const SESSION_HOURS = String(STATUS_SESSION_TTL_SECONDS / 3600);

const APP_ROUTES = new Set([
  '/',
  '/healthz',
  '/connect/github',
  '/connect/notion',
  '/progress',
  '/progress/status',
  '/progress/site-check',
  '/status',
  '/status/rerun',
  '/auth/github/callback',
  '/auth/notion/callback',
  ...POLICY_PATHS,
]);

describe('policy pages', () => {
  test('every policy route serves an HTML document through the router', async () => {
    for (const path of POLICY_PATHS) {
      const response = await route(new Request(`https://inkdrafts.example${path}`));
      expect(response).toBeInstanceOf(Response);
      expect(response!.status).toBe(200);
      expect(response!.headers.get('content-type')).toContain('text/html');
      expect(await response!.text()).toContain('<html lang="en">');
    }
  });

  test('each document is self-contained and structurally accessible', () => {
    for (const path of POLICY_PATHS) {
      const document = POLICY_PAGES[path]!.document;
      expect(document.startsWith('<!doctype html>')).toBe(true);
      expect(document.match(/<h1[ >]/gu)).toHaveLength(1);
      expect(document).toContain('class="skip-link" href="#main-content"');
      expect(document).toContain('<main id="main-content">');
      expect(document).toContain('<nav aria-label="Policies">');
      expect(document).not.toContain('<script');
      expect(document).not.toMatch(/\ssrc="https?:\/\//u);
      expect(new TextEncoder().encode(document).byteLength).toBeLessThan(24_000);
    }
  });

  test('every internal link points at a route the service serves', () => {
    for (const path of POLICY_PATHS) {
      const links = [...POLICY_PAGES[path]!.document.matchAll(/href="(\/[^"]*)"/gu)].map((match) => match[1]!);
      for (const link of links) {
        expect(APP_ROUTES.has(link)).toBe(true);
      }
    }
  });

  test('the landing page links every policy before the consent CTA', () => {
    for (const path of POLICY_PATHS) {
      expect(LANDING_PAGE).toContain(`href="${path}"`);
    }
    expect(LANDING_PAGE.indexOf('href="/privacy"')).toBeLessThan(LANDING_PAGE.indexOf('id="how-it-works"'));
  });

  test('the Notion consent handoff links the privacy policy', () => {
    const job = createProvisioningJob({
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
      now: 1_000_000,
    });
    const document = progressPage('job-123', projectProvisioning(job, 1_000_010));
    expect(document).toContain('href="/privacy"');
  });

  test('the dashboard leaving card and the error page link their policies', () => {
    const model: StatusPageModel = { kind: 'no_site', viewer: { login: 'alice' } };
    const chrome: StatusPageChrome = { notice: null, rerunFormToken: null };
    expect(statusPage(model, chrome)).toContain('href="/leaving"');
    expect(errorPage({ code: 'github_state_expired', status: 400, retryAfterSeconds: null, restartHref: null }))
      .toContain('href="/support"');
  });

  test('retention claims match the constants and documented platform figures', () => {
    const privacy = POLICY_PAGES['/privacy']!.document;
    expect(privacy).toContain(`${JOB_RETENTION_HOURS} hours`);
    expect(privacy).toContain('three months');
    expect(privacy).toContain('seven days');
    expect(privacy).toContain(`${SESSION_HOURS} hours`);
    expect(privacy).toContain('libsodium');
  });

  test('no policy claims certification or perfect security', () => {
    for (const path of POLICY_PATHS) {
      const document = POLICY_PAGES[path]!.document.toLowerCase();
      expect(document).not.toMatch(/soc 2|iso 27001|bank-level|bank-grade|certified|hack-proof|unbreakable/u);
    }
  });
});
