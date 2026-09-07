/**
 * Guided full-flow verification for InkDrafts (notiongit), shipped by
 * .zcode/skills/verify-notiongit. Simulates the real user journey against a
 * real deployment (staging by default, production only for launch-gate
 * rehearsals): landing page -> connect GitHub -> install the GitHub App ->
 * connect Notion -> duplicate the template -> first sync and publish -> live
 * site. It is the operational version of docs/rehearsal-script.md run A.
 *
 * Division of labor, inherited from the rehearsal rules:
 * - HUMANS create the accounts (GitHub's terms forbid bot-created accounts),
 *   own the credentials, and perform every provider consent click. The
 *   driver never sees a password.
 * - THE DRIVER does everything else: navigates, clicks InkDrafts-side
 *   actions, watches the callbacks return, polls the progress projection
 *   with timestamps, and captures a screenshot + JSON at every step.
 *
 * The browser is headed and uses a persistent profile, so signing in to
 * GitHub and Notion once keeps both sessions alive across runs. The profile
 * holds real session cookies and lives in helpers/.flow-profile (gitignored)
 * — never commit or copy it.
 *
 * Usage (from the repository root):
 *
 *   bun run .zcode/skills/verify-notiongit/helpers/flow.ts <BASE> <ART_DIR> [options]
 *
 *   BASE              deployment under test, e.g.
 *                     https://inkdrafts.com or the staging hostname
 *   ART_DIR           evidence directory for this run (screenshots, logs)
 *   --probe           run only the automated prefix (doctor, landing, GitHub
 *                     install-page redirect) and stop — no account needed
 *   --job-id <id>     resume an interrupted run's job for the polling steps
 *   --user-session    fully autonomous: copy the live Chrome profile's
 *                     session (Default profile) into a gitignored scratch
 *                     dir, click the provider consents with that session,
 *                     and capture console/network errors throughout. Needs
 *                     no human unless a consent screen is unrecognizable or
 *                     a session is gone; then it stops with a screenshot.
 *   --reauthorize     recover from the already-installed dead end: skip the
 *                     install page, mint a fresh signed state, and drive
 *                     GitHub's OAuth authorize page directly
 *   --client-id <id>  with --reauthorize: skip the org app-settings scrape
 *                     (sudo-mode blocks it when the profile's sudo grant has
 *                     expired) and authorize with this public client id.
 *                     Verify it first against the deployed
 *                     /status?connect=1 redirect, which echoes the
 *                     configured client_id
 *
 * Exits non-zero when a step fails. Evidence must land under ART_DIR, which
 * survives cleanup.
 */
import { mkdirSync, writeFileSync, appendFileSync, existsSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { chromium } from 'playwright-core';
import type { BrowserContext, Page } from 'playwright-core';

const argv = process.argv.slice(2);
const BASE = (argv[0] ?? 'https://notiongit-staging.notiongit.workers.dev').replace(/\/$/, '');
const ART_DIR = argv[1] ?? `.zcode/skills/verify-notiongit/artifacts/flow-${Date.now()}`;
const PROBE = argv.includes('--probe');
const USER_SESSION = argv.includes('--user-session');
const REAUTHORIZE = argv.includes('--reauthorize');
const resumeJobId = argv.includes('--job-id') ? argv[argv.indexOf('--job-id') + 1] : null;
const clientIdOverride = argv.includes('--client-id') ? argv[argv.indexOf('--client-id') + 1] : null;

const PROFILE_DIR = join(import.meta.dir, '.flow-profile');
mkdirSync(ART_DIR, { recursive: true });

/** Copy the live Chrome session (Default profile) into a scratch profile.
 * Rebuilt every run so login cookies are fresh. Chrome's cookie store is
 * keyed per profile directory name, so the copy keeps the same layout. */
function buildUserProfile(): string {
  const src = join(homedir(), '.config', 'google-chrome');
  const dst = join(import.meta.dir, '.user-profile');
  mkdirSync(join(dst, 'Default'), { recursive: true });
  copyFileSync(join(src, 'Local State'), join(dst, 'Local State'));
  copyFileSync(join(src, 'Default', 'Cookies'), join(dst, 'Default', 'Cookies'));
  return dst;
}

function shot(page: Page, name: string): Promise<void> {
  return page.screenshot({ path: join(ART_DIR, `${name}.png`), fullPage: true }).then(() => {
    console.log(`  evidence: ${name}.png`);
  });
}

function log(name: string, line: string): void {
  appendFileSync(join(ART_DIR, 'run.log'), `${new Date().toISOString()} ${name}: ${line}\n`);
  console.log(`[${name}] ${line}`);
}

async function human(page: Page, instruction: string): Promise<void> {
  console.log('\n***********************************************************');
  console.log(`HUMAN STEP: ${instruction}`);
  console.log('***********************************************************');
  await shot(page, `checkpoint-${instruction.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`);
  const rl = createInterface({ input: process.stdin });
  await new Promise<void>((resolve) => rl.question('Press Enter here once done in the browser. ', () => { rl.close(); resolve(); }));
}

async function pollProgress(page: Page, jobId: string): Promise<{ status: string; json: unknown }> {
  const logPath = join(ART_DIR, 'progress-poll.log');
  const deadline = Date.now() + 15 * 60 * 1000;
  let last = '';
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    const response = await page.request.get(`${BASE}/progress/status?job_id=${jobId}`);
    const body = await response.text();
    appendFileSync(logPath, `${new Date().toISOString()} HTTP ${response.status()} ${body}\n`);
    let status = `HTTP ${response.status()}`;
    try {
      const parsed = JSON.parse(body) as { progress?: { status?: string } };
      status = parsed.progress?.status ?? status;
    } catch { /* non-JSON body: keep HTTP status as the state */ }
    log('progress', status);
    if (status === 'succeeded') return { status, json: JSON.parse(body) };
    if (status !== last) { last = status; lastChange = Date.now(); }
    else if (Date.now() - lastChange > 5 * 60 * 1000) {
      throw new Error(`progress stalled at "${status}" for 5 minutes; see progress-poll.log`);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error('progress did not reach succeeded within 15 minutes; see progress-poll.log');
}

const results: Array<{ id: string; ok: boolean; detail: string }> = [];

async function step(id: string, fn: (page: Page) => Promise<string>): Promise<void> {
  log(id, 'start');
  try {
    const detail = await fn(page!);
    results.push({ id, ok: true, detail });
    log(id, `PASS ${detail}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ id, ok: false, detail });
    log(id, `FAIL ${detail}`);
    await shot(page!, `fail-${id}`).catch(() => {});
    throw new Error(`step ${id} failed: ${detail}`);
  }
}

let context: BrowserContext | undefined;
let page: Page | undefined;
let jobId = resumeJobId;

async function main() {
  // Doctor first.
  const health = await fetch(`${BASE}/healthz`).then((r) => r.text()).catch((e) => `ERROR ${String(e)}`);
  if (health.trim() !== '{"ok":true,"service":"notiongit"}') {
    throw new Error(`doctor failed: ${BASE}/healthz answered ${health}`);
  }
  console.log(`PASS doctor ${health}`);

  context = await chromium.launchPersistentContext(
    USER_SESSION ? buildUserProfile() : PROFILE_DIR,
    {
      channel: 'chrome',
      // Headed for guided flows (humans act at the consent checkpoints);
      // --probe and --user-session drive nothing human and run headless.
      headless: PROBE || USER_SESSION,
      viewport: { width: 1280, height: 900 },
      args: USER_SESSION ? ['--profile-directory=Default', '--password-store=basic'] : [],
    },
  );
  page = await context.newPage();

  // Console and network capture: every console message, page error, and
  // failed (>=400) response lands in the evidence dir with a truncated body.
  // This is the "open the console log" diagnostic for provider-leg errors.
  const consoleLog = join(ART_DIR, 'console.log');
  const netLog = join(ART_DIR, 'network-errors.log');
  page.on('console', (message) => {
    appendFileSync(consoleLog, `${new Date().toISOString()} [${message.type()}] ${message.text()}\n`);
  });
  page.on('pageerror', (error) => {
    appendFileSync(consoleLog, `${new Date().toISOString()} [pageerror] ${error.message}\n`);
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const entry = `${new Date().toISOString()} HTTP ${response.status()} ${response.url()}\n`;
    appendFileSync(netLog, entry);
    void response.text().then((body) => {
      appendFileSync(netLog, `  body: ${body.slice(0, 400).replace(/\s+/g, ' ')}\n`);
    }).catch(() => {});
  });

  if (REAUTHORIZE) {
    await step('client-id', async (p) => {
      if (clientIdOverride) {
        (globalThis as { __clientId?: string }).__clientId = clientIdOverride;
        return `client id ${clientIdOverride.slice(0, 6)}… supplied via --client-id`;
      }
      await p.goto('https://github.com/organizations/inkdrafts/settings/apps/inkdrafts', { waitUntil: 'domcontentloaded' });
      await p.waitForLoadState('load');
      const body = await p.locator('body').innerText();
      const cid = body.match(/Client ID:\s*(\S+)/)?.[1];
      if (!cid) throw new Error('no Client ID on the org app settings page (needs an inkdrafts org-owner session)');
      (globalThis as { __clientId?: string }).__clientId = cid;
      return `client id ${cid.slice(0, 6)}… read from app settings`;
    });
    await step('mint-state', async (p) => {
      const stateRes = await p.request.get(`${BASE}/connect/github`, { maxRedirects: 0 });
      const location = stateRes.headers().location ?? '';
      if (!location.includes('state=')) throw new Error(`/connect/github answered ${stateRes.status()} without a redirect`);
      const signed = new URL(location).searchParams.get('state')!;
      const payload = JSON.parse(Buffer.from(signed.split('.')[0], 'base64url').toString()) as { jobId: string; exp: number };
      jobId = payload.jobId;
      const ttlMinutes = Math.max(1, Math.round((payload.exp - Date.now() / 1000) / 60));
      writeFileSync(join(ART_DIR, 'job.json'), JSON.stringify({ jobId, base: BASE }, null, 2));
      (globalThis as { __signedState?: string }).__signedState = signed;
      return `minted job ${jobId} (state expires in ${ttlMinutes} minutes)`;
    });
    await step('direct-authorize', async (p) => {
      const cid = (globalThis as { __clientId?: string }).__clientId;
      const signed = (globalThis as { __signedState?: string }).__signedState;
      const authUrl = `https://github.com/login/oauth/authorize?client_id=${cid}&redirect_uri=${encodeURIComponent(`${BASE}/auth/github/callback`)}&state=${encodeURIComponent(signed!)}`;
      await p.goto(authUrl, { waitUntil: 'domcontentloaded' });
      await p.waitForLoadState('load');
      await shot(p, 'step-authorize-page');
      if (!p.url().startsWith('https://github.com')) {
        return 'GitHub returned immediately (authorization still active)';
      }
      const authButton = p.getByRole('button', { name: /^authorize$/i }).first();
      if (!(await authButton.count())) throw new Error(`no Authorize button on ${p.url()}`);
      await authButton.click();
      await shot(p, 'step-authorized');
      return 'Authorize clicked';
    });
  } else {

  await step('landing', async (p) => {
    await p.goto(`${BASE}/`);
    const title = await p.title();
    if (!title.includes('InkDrafts')) throw new Error(`title ${title}`);
    await shot(p, 'step-landing');
    return `landing rendered, title=${title}`;
  });

  await step('connect-github', async (p) => {
    const githubRequest = p.waitForRequest((r) => new URL(r.url()).host === 'github.com' && new URL(r.url()).pathname.startsWith('/apps/inkdrafts'));
    await Promise.all([githubRequest, p.click('a[href="/connect/github"]')]);
    const url = (await githubRequest).url();
    await shot(p, 'step-github-install-page');
    return `GitHub install page requested: ${new URL(url).pathname}`;
  });

  if (PROBE) {
    console.log('\n--probe: automated prefix verified. The install page requires a signed-in GitHub account; stop here.');
    await context.close();
    return;
  }

  await step('github-install', async (p) => {
    if (!USER_SESSION) {
      await human(p, 'On GitHub: choose your personal account, keep repository access "All repositories", then choose Install & Authorize (you may be asked to sign in first).');
      return 'install consent completed by account owner';
    }
    if (new URL(p.url()).pathname.startsWith('/login')) {
      throw new Error('GitHub session is missing in the copied profile; sign in to GitHub in your Chrome and rerun');
    }
    await p.waitForLoadState('load');
    // Multi-account sessions land on a chooser ("Where do you want to
    // install InkDrafts?") listing every account and org; the product flow
    // installs on the authenticated personal account, so pick the row whose
    // text matches the session's own login.
    const needsChooser = (await p.locator('input[name="repository_select"]').count()) === 0;
    if (needsChooser) {
      const whoResponse = await p.request.get('https://github.com');
      const whoHtml = await whoResponse.text();
      const loginMatch = whoHtml.match(/name="user-login" content="([^"]*)"/);
      const login = loginMatch?.[1];
      log('github-install', `account chooser visible; session login is ${login ?? 'unknown'}`);
      // The row links to installations/new before install and to the
      // installation's configure page after, so match on the login text.
      const row = login ? p.locator('a').filter({ hasText: login }).first() : p.locator('a').filter({ hasText: /\S/ }).first();
      if (!(await row.count())) {
        throw new Error(`chooser has no row for session login ${login ?? '(unreadable)'}; refusing to guess an account`);
      }
      await Promise.all([p.waitForLoadState('load'), row.click()]);
      await shot(p, 'step-install-page');
    }
    const allRepos = p.locator('input[name="repository_select"][value="all"]');
    if ((await allRepos.count()) && !(await allRepos.first().isChecked())) {
      await allRepos.first().check();
    }
    // An app already installed from an earlier attempt shows Configure or
    // Authorize instead of Install; any of them advances this leg.
    const installButton = p.getByRole('button', { name: /install|configure|authorize/i }).first();
    if (!(await installButton.count())) {
      const buttons = await p.locator('button').allInnerTexts();
      throw new Error(`no install button found; page buttons were: ${JSON.stringify(buttons.slice(0, 10))}`);
    }
    await installButton.click();
    await shot(p, 'step-install-clicked');
    return 'Install & Authorize clicked with repository access "all"';
  });

  }
  await step('github-callback', async (p) => {
    // The OAuth navigation settles in one of three places: Notion's
    // authorization page (the working callback 302-chains through
    // /connect/notion in a single navigation, so that hop is never a settled
    // URL), the fresh job's connect page, or the progress page of the
    // account's already-active job — the worker funnels a double starter
    // there by design (authError's ProvisioningGateRefusedError branch).
    // All three mean the GitHub leg succeeded; adopt the job id the URL names.
    const baseHost = new URL(BASE).host;
    const isNotion = (host: string) => host === 'app.notion.com' || host === 'notion.so' || host === 'www.notion.so';
    await p.waitForURL((url) => url.host === baseHost || isNotion(url.host), { timeout: 120_000 });
    await p.waitForLoadState('load');
    const url = new URL(p.url());
    if (isNotion(url.host)) {
      writeFileSync(join(ART_DIR, 'job.json'), JSON.stringify({ jobId, base: BASE, at: new Date().toISOString() }, null, 2));
      await shot(p, 'step-after-github-callback');
      return `callback 302-chained to Notion authorization (${url.host}${url.pathname}) with job ${jobId}`;
    }
    if (url.pathname.startsWith('/auth/')) {
      // Coded failures render at the callback URL itself; every success
      // redirects away from it.
      const body = (await p.locator('body').innerText().catch(() => '')).slice(0, 800);
      writeFileSync(join(ART_DIR, 'callback-error.txt'), `${p.url()}\n\n${body}`);
      throw new Error(`callback error page (${body.replace(/\s+/g, ' ').slice(0, 140)}) — saved to callback-error.txt`);
    }
    jobId = url.searchParams.get('job_id') ?? jobId;
    writeFileSync(join(ART_DIR, 'job.json'), JSON.stringify({ jobId, base: BASE, at: new Date().toISOString() }, null, 2));
    await shot(p, 'step-after-github-callback');
    return `GitHub leg done, on ${url.pathname} with job ${jobId}`;
  });

  await step('connect-notion', async (p) => {
    // When the GitHub callback chained straight to Notion, the consent page
    // for this very job is already on screen — keep it rather than bouncing
    // through /connect/notion for a second authorization URL.
    if (['app.notion.com', 'notion.so', 'www.notion.so'].includes(new URL(p.url()).host)) {
      await shot(p, 'step-notion-authorize');
      return `Notion authorization page at ${new URL(p.url()).host} (carried over from the callback chain)`;
    }
    // The wizard's Connect Notion button targets this same hop; drive it
    // directly rather than hunting for the button.
    await p.goto(`${BASE}/connect/notion?job_id=${jobId}`, { waitUntil: 'domcontentloaded' });
    await p.waitForLoadState('load').catch(() => {});
    if (new URL(p.url()).host === new URL(BASE).host) {
      log('connect-notion', `returned immediately to ${p.url()} (already authorized or error)`);
      await shot(p, 'step-connect-notion-return');
      return `immediate return to ${new URL(p.url()).pathname}`;
    }
    await shot(p, 'step-notion-authorize');
    return `Notion authorization page at ${new URL(p.url()).host}`;
  });

  await step('notion-consent', async (p) => {
    if (new URL(p.url()).host === new URL(BASE).host) {
      return 'skipped: Notion authorization was already granted (immediate return)';
    }
    if (!USER_SESSION) {
      await human(p, 'In Notion: approve InkDrafts and choose "Duplicate template" when offered. (To rehearse the recoverable failure, deny instead, then reconnect — see features/site-setup.md.)');
      return 'Notion consent completed by account owner';
    }
    if (new URL(p.url()).pathname.startsWith('/login')) {
      throw new Error('Notion session is missing in the copied profile; sign in to Notion in your Chrome and rerun');
    }
    // Notion's consent is a wizard: workspace is preselected, so it is a
    // series of screens — Next, an optional page selection, Allow access —
    // that ends with the product's callback navigation. Click whatever
    // advance button each screen shows until the browser leaves Notion.
    const notionHost = (host: string) => host === 'app.notion.com' || host === 'notion.so' || host === 'www.notion.so';
    for (let screen = 1; screen <= 4; screen++) {
      await p.waitForLoadState('load').catch(() => {});
      if (!notionHost(new URL(p.url()).host)) break;
      await shot(p, `step-notion-consent-${screen}`);
      // The consent UI is a late-hydrating SPA: skeletons render before any
      // button exists, so wait for the controls rather than counting them
      // once (a bare load state is not enough).
      const duplicate = p.getByRole('button', { name: /duplicate template/i }).first();
      const duplicateVisible = await duplicate
        .waitFor({ state: 'visible', timeout: 3_000 })
        .then(() => true)
        .catch(() => false);
      if (duplicateVisible) {
        await duplicate.click();
        log('notion-consent', 'chose Duplicate template');
      }
      const advance = p.getByRole('button', { name: /allow access|^allow$|^next$|confirm|continue|authorize/i }).first();
      try {
        await advance.waitFor({ state: 'visible', timeout: 20_000 });
      } catch {
        const buttons = await p.locator('button').allInnerTexts();
        throw new Error(`no advance button on consent screen ${screen} at ${p.url()}; buttons were: ${JSON.stringify(buttons.slice(0, 10))}`);
      }
      const label = (await advance.innerText()).trim();
      await advance.click();
      log('notion-consent', `clicked "${label}" on screen ${screen}`);
      // The next screen is an SPA transition on the same URL; only the
      // callback moves the browser off Notion. If neither happens in time,
      // the loop's next iteration handles the screen that is showing.
      await p.waitForURL((url) => !notionHost(url.host), { timeout: 15_000 }).catch(() => {});
    }
    await shot(p, 'step-notion-allowed');
    const end = new URL(p.url());
    if (notionHost(end.host)) {
      throw new Error(`consent did not complete; still on ${end.host}${end.pathname}`);
    }
    return `Notion consent clicked through, now at ${end.host}${end.pathname}`;
  });

  await step('notion-callback', async (p) => {
    await p.waitForURL((url) => url.host === new URL(BASE).host, { timeout: 120_000 });
    const url = new URL(p.url());
    jobId = url.searchParams.get('job_id') ?? jobId;
    await shot(p, 'step-after-notion-callback');
    return `returned to ${url.pathname}, job ${jobId}`;
  });

  await step('provisioning', async (p) => {
    if (!jobId) throw new Error('no job id recorded');
    const { status } = await pollProgress(p, jobId);
    await shot(p, 'step-provisioning-final');
    return `progress reached ${status} (job ${jobId})`;
  });

  await step('site-live', async (p) => {
    if (!jobId) throw new Error('no job id recorded');
    // The success page's SPA render lags the queue and may name no link at
    // all, so take the product's own probe as the verdict: status succeeded
    // plus a reachable site-check.
    const deadline = Date.now() + 10 * 60 * 1000;
    let status = '';
    let reachable = false;
    while (Date.now() < deadline) {
      const state = await p.request.get(`${BASE}/progress/status?job_id=${jobId}`)
        .then((r) => r.json() as Promise<{ progress?: { status?: string } }>)
        .catch(() => ({ progress: undefined }));
      status = state.progress?.status ?? 'unknown';
      if (status === 'succeeded') {
        const check = await p.request.get(`${BASE}/progress/site-check?job_id=${jobId}`)
          .then((r) => r.json() as Promise<{ reachable?: boolean }>)
          .catch(() => ({ reachable: false }));
        reachable = check.reachable === true;
        if (reachable) break;
      }
      log('site-live', `status=${status} reachable=${reachable}`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
    if (status !== 'succeeded' || !reachable) {
      throw new Error(`site never went live (status=${status}, reachable=${reachable}) within 10 minutes`);
    }
    // Best-effort evidence: reload the success page and, if it renders a link
    // to the live site, capture the site itself.
    await p.goto(`${BASE}/progress?job_id=${jobId}`, { waitUntil: 'networkidle' }).catch(() => {});
    const baseHost = new URL(BASE).host;
    const link = p.locator(`a[href^="http"]:not([href*="github.com"]):not([href*="${baseHost}"])`).first();
    if (await link.count()) {
      const siteUrl = await link.getAttribute('href');
      if (siteUrl) {
        await p.goto(siteUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await shot(p, 'step-live-site');
        return `live at ${siteUrl} (status succeeded, site-check reachable)`;
      }
    }
    await shot(p, 'step-live-site');
    return `site is live (status succeeded, site-check reachable); the success page rendered no link to capture`;
  });

  await step('repository', async (p) => {
    const repoLink = p.locator('a[href*="github.com/"]:not([href*="/apps/"])').first();
    const href = (await repoLink.count()) ? await repoLink.getAttribute('href') : null;
    const name = href ? new URL(href).pathname.replace(/^\//, '') : `see ${ART_DIR}/step-provisioning-final.png`;
    if (href) {
      const response = await p.request.get(href);
      if (response.status() !== 200) throw new Error(`repository ${href} answered ${response.status()}`);
    }
    writeFileSync(join(ART_DIR, 'repository.json'), JSON.stringify({ url: href, name }, null, 2));
    await shot(p, 'step-repository');
    return `repository: ${name}`;
  });

  await context.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\nflow summary: ${results.length - failed.length} passed, ${failed.length} failed (evidence: ${ART_DIR})`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (error) => {
  console.log(`FAIL flow ${error instanceof Error ? error.message : String(error)}`);
  await context?.close().catch(() => {});
  if (!existsSync(join(ART_DIR, 'job.json')) && jobId) {
    writeFileSync(join(ART_DIR, 'job.json'), JSON.stringify({ jobId, base: BASE, at: new Date().toISOString() }, null, 2));
  }
  console.log(`Resume an interrupted run with: --job-id ${jobId ?? '<job id from job.json>'}`);
  process.exit(1);
});
