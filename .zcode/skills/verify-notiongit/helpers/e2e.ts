/**
 * Playwright end-to-end verification for the notiongit (InkDrafts) Worker,
 * shipped by .zcode/skills/verify-notiongit. Drives the local verification
 * instance (see ../SKILL.md for the launch command) in real Chrome the way a
 * user would: follow links, watch navigations, and read what renders.
 *
 * Provider boundaries are isolated at the browser level: github.com cannot
 * resolve inside the driven Chrome, so a user path that leaves for GitHub
 * performs the real navigation and the harness observes the exact requested
 * URL, with the request stopping at DNS. JSON/header contracts stay with the
 * curl recipes in features/; this script covers what only a browser can
 * prove.
 *
 * Usage (from the repository root, instance running and doctor-passing):
 *
 *   bun run .zcode/skills/verify-notiongit/helpers/e2e.ts <BASE> <ART_DIR>
 *
 *   BASE     defaults to http://127.0.0.1:8799
 *   ART_DIR  defaults to .zcode/skills/verify-notiongit/artifacts/e2e-<ts>
 *
 * Uses the system Google Chrome via channel 'chrome' (playwright-core ships
 * no browsers). Exits non-zero if any check fails; screenshots and this
 * script's stdout are the evidence and must land under ART_DIR, which
 * survives instance cleanup.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, request } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8799';
const ART_DIR = process.argv[3] ?? `.zcode/skills/verify-notiongit/artifacts/e2e-${Date.now()}`;
mkdirSync(ART_DIR, { recursive: true });

const POLICY_PAGES: ReadonlyArray<readonly [string, string]> = [
  ['/privacy', 'Privacy Policy'],
  ['/terms', 'Terms of Service'],
  ['/security', 'Security and Data Handling'],
  ['/acceptable-use', 'Acceptable Use Policy'],
  ['/support', 'Support'],
  ['/leaving', 'Leaving InkDrafts'],
];

const results: Array<{ id: string; ok: boolean; detail: string }> = [];

async function check(id: string, artSub: string, fn: (page: Page, art: string) => Promise<string>) {
  const art = join(ART_DIR, artSub);
  mkdirSync(art, { recursive: true });
  let context: BrowserContext | undefined;
  try {
    // The local instance serves self-signed TLS (the worker 301s plaintext
    // http ahead of every route), so the browser must tolerate the cert.
    context = await browser!.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const detail = await fn(page, art);
    results.push({ id, ok: true, detail });
    console.log(`PASS ${id} ${detail}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ id, ok: false, detail });
    console.log(`FAIL ${id} ${detail}`);
  } finally {
    await context?.close();
  }
}

let browser: Browser | undefined;

async function main() {
  // Doctor first: never drive an instance that does not answer exactly right.
  const api = await request.newContext({ ignoreHTTPSErrors: true });
  const health = await api.get(`${BASE}/healthz`);
  const healthBody = (await health.text()).trim();
  if (!health.ok() || healthBody !== '{"ok":true,"service":"notiongit"}') {
    console.log(`FAIL doctor status=${health.status()} body=${healthBody}`);
    process.exit(2);
  }
  console.log(`PASS doctor ${healthBody}`);
  await api.dispose();

  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    // Provider isolation: the browser performs the real navigation, but
    // github.com cannot resolve, so nothing leaves the machine. Playwright
    // route interception cannot stop a server-issued 302 chain — its
    // redirect target bypasses routing entirely — so the harness observes
    // the requested URL and asserts the request fails instead.
    args: ['--host-resolver-rules=MAP github.com ~NOTFOUND'],
  });

  await check('landing-render', 'landing-page', async (page, art) => {
    const response = await page.goto(`${BASE}/`);
    if (response?.status() !== 200) throw new Error(`status ${response?.status()}`);
    const title = await page.title();
    if (title !== 'InkDrafts') throw new Error(`title ${title!}`);
    const anchors = await page.locator('a[href="/connect/github"]').count();
    if (anchors < 1) throw new Error('no /connect/github anchor');
    const { scripts, externalAssets } = await page.evaluate(() => ({
      scripts: document.querySelectorAll('script').length,
      externalAssets: [...document.querySelectorAll('[src]')].filter((el) => /^https?:/i.test(el.src)).length,
    }));
    if (scripts !== 0) throw new Error(`${scripts} script tags`);
    if (externalAssets !== 0) throw new Error(`${externalAssets} external asset loads`);
    await page.screenshot({ path: join(art, 'landing.png'), fullPage: true });
    return `title=InkDrafts anchors=${anchors} scripts=0 externalAssets=0`;
  });

  await check('landing-cta-navigates', 'onboarding-entry', async (page, art) => {
    await page.goto(`${BASE}/`);
    const githubRequest = page.waitForRequest((r) => new URL(r.url()).host === 'github.com');
    const githubFailed = page.waitForEvent('requestfailed', (r) => new URL(r.url()).host === 'github.com');
    await Promise.all([githubRequest, githubFailed, page.click('a[href="/connect/github"]')]);
    const request = await githubRequest;
    const url = request.url();
    if (!url.startsWith('https://github.com/apps/') || !url.includes('/installations/new?state=')) {
      throw new Error(`browser navigated to ${url}`);
    }
    const failure = (await githubFailed).failure();
    if (!failure || !failure.errorText.includes('ERR_NAME_NOT_RESOLVED')) {
      throw new Error(`expected DNS isolation to stop the request, got ${JSON.stringify(failure)}`);
    }
    await page.screenshot({ path: join(art, 'cta-navigation.png') });
    return `browser navigated to ${new URL(url).host}${new URL(url).pathname}?state=... (stopped by DNS isolation)`;
  });

  for (const [path, expectedTitle] of POLICY_PAGES) {
    await check(`policy-${path}`, 'policy-pages', async (page, art) => {
      const response = await page.goto(`${BASE}${path}`);
      if (response?.status() !== 200) throw new Error(`status ${response?.status()}`);
      const title = await page.title();
      if (!title.startsWith(expectedTitle)) throw new Error(`title ${title!}`);
      await page.screenshot({ path: join(art, `${path.slice(1)}.png`), fullPage: true });
      return `title=${title}`;
    });
  }

  await check('progress-missing', 'progress', async (page, art) => {
    const jobId = `verify-e2e-${Date.now()}`;
    const response = await page.goto(`${BASE}/progress?job_id=${jobId}`);
    if (response?.status() !== 404) throw new Error(`status ${response?.status()}`);
    const copy = 'We could not find a site setup in progress for this link';
    if (!(await page.getByText(copy).count())) throw new Error('missing-job copy not rendered');
    await page.screenshot({ path: join(art, 'progress-missing.png'), fullPage: true });
    const malformed = await page.request.get(`${BASE}/progress/status?job_id=bad/id`);
    if (malformed.status() !== 400) throw new Error(`malformed id status ${malformed.status()}`);
    return `unknown id -> 404 with missing copy; malformed id -> 400`;
  });

  await check('status-render-and-connect', 'status-surface', async (page, art) => {
    const response = await page.goto(`${BASE}/status`);
    if (response?.status() !== 200) throw new Error(`status ${response?.status()}`);
    if ((await page.title()) !== 'Check your site') throw new Error(`title ${await page.title()}`);
    if (!(await page.locator('h1', { hasText: 'Check your site' }).count())) throw new Error('no h1');
    await page.screenshot({ path: join(art, 'status-home.png'), fullPage: true });
    const githubRequest = page.waitForRequest((r) => new URL(r.url()).host === 'github.com');
    const githubFailed = page.waitForEvent('requestfailed', (r) => new URL(r.url()).host === 'github.com');
    const connectResponse = page.waitForResponse((r) => r.url().includes('/status?connect=1') && r.status() === 302);
    await Promise.all([githubRequest, githubFailed, connectResponse, page.click('a[href="/status?connect=1"]')]);
    const request = await githubRequest;
    const url = request.url();
    if (!url.startsWith('https://github.com/login/oauth/authorize?client_id=')) {
      throw new Error(`browser navigated to ${url}`);
    }
    const failure = (await githubFailed).failure();
    if (!failure || !failure.errorText.includes('ERR_NAME_NOT_RESOLVED')) {
      throw new Error(`expected DNS isolation to stop the request, got ${JSON.stringify(failure)}`);
    }
    // The cookie carries the __Host- + Secure prefix, so Chrome over plain
    // http refuses to STORE it; the contract observable is the Set-Cookie
    // header on the redirect response itself.
    const setCookies = (await (await connectResponse).allHeaders())['set-cookie'] ?? '';
    if (!setCookies.includes('__Host-status-state=')) {
      throw new Error(`no __Host-status-state Set-Cookie on redirect; got: ${setCookies}`);
    }
    await page.screenshot({ path: join(art, 'status-connect-navigation.png') });
    return `connect -> github.com/login/oauth/authorize, __Host-status-state Set-Cookie on the 302 (stopped by DNS isolation)`;
  });

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`e2e summary: ${results.length - failed.length} passed, ${failed.length} failed (artifacts: ${ART_DIR})`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (error) => {
  console.log(`FAIL e2e-driver ${error instanceof Error ? error.message : String(error)}`);
  await browser?.close().catch(() => {});
  process.exit(2);
});
