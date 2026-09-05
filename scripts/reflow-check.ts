/**
 * Real-browser accessibility checks for the rendered surfaces: no horizontal
 * overflow at 320 CSS px (WCAG reflow) and at 2x scale (200% zoom), and a
 * keyboard walk that reaches every visible interactive element with a
 * visible focus outline. The axe suite in test/a11y.test.ts covers structure
 * in jsdom; this script covers what only a layout engine can answer.
 *
 * Zero dependencies: serves the generated documents with Bun.serve and
 * drives headless Chrome over the DevTools protocol.
 *
 * Usage: bun run scripts/reflow-check.ts
 * Exits non-zero on any failure; --shots DIR also saves 320px screenshots.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { LANDING_PAGE } from '../src/landing-page';
import { progressPage } from '../src/progress-page';
import { projectProvisioning } from '../src/progress';
import { createProvisioningJob } from '../src/provisioning-job';
import { statusPage } from '../src/status-page';
import { errorPage } from '../src/error-page';

const shotsDir = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

const NOW = 1_000_000;

function snapshotFor(status: 'queued' | 'succeeded' | 'dead_letter'): ReturnType<typeof projectProvisioning> {
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
    now: NOW,
  });
  if (status !== 'queued') job.data.notionSecretsWrittenAt = NOW + 1;
  if (status === 'succeeded') {
    for (const step of Object.keys(job.steps) as (keyof typeof job.steps)[]) {
      job.steps[step] = { ...job.steps[step], status: 'succeeded', attempts: 1 };
    }
    job.data.notionLinks = {
      pagesUrl: 'https://www.notion.so/alice/Pages-11111111111141118111111111111111',
      postsUrl: 'https://www.notion.so/alice/Posts-22222222222242228222222222222222',
      templateRootUrl: 'https://www.notion.so/alice/My-Site-Home',
    };
  }
  job.status = status;
  return projectProvisioning(job, NOW + 10);
}

const session = {
  kind: 'session',
  viewer: { login: 'alice' },
  site: {
    repository: { name: 'alice.github.io', url: 'https://github.com/alice/alice.github.io' },
    site: { url: 'https://alice.github.io' },
    sync: { kind: 'succeeded', finishedAtMs: 2, runUrl: null },
    deploy: { kind: 'built', commitSha: 'abc' },
    runInFlight: false,
  },
} as const;

const routes: Record<string, string> = {
  '/': LANDING_PAGE,
  '/progress-active': progressPage('job-123', snapshotFor('queued')),
  '/progress-succeeded': progressPage('job-123', snapshotFor('succeeded')),
  '/progress-failed': progressPage('job-123', snapshotFor('dead_letter')),
  '/status': statusPage(session, { notice: null, rerunFormToken: 'token' }),
  '/error': errorPage({ code: 'github_state_replayed', status: 400, retryAfterSeconds: null, restartHref: '/connect/github' }),
};

const server = Bun.serve({
  port: 0,
  fetch: (request) => {
    const path = new URL(request.url).pathname;
    const document = routes[path];
    if (document === undefined) return new Response('not found', { status: 404 });
    return new Response(document, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
});

interface Cdp {
  send: (method: string, params?: Record<string, unknown>) => Promise<any>;
  close: () => void;
}

function connect(wsUrl: string): Promise<Cdp> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    ws.onopen = () => resolve({
      send: (method, params = {}) => {
        const id = nextId++;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
      },
      close: () => ws.close(),
    });
    ws.onerror = () => reject(new Error('CDP WebSocket failed'));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
    };
  });
}

const CHROME_PORT = 9223;
const CHROME_LOG = '/tmp/notiongit-reflow-chrome.log';

// Output lands in a file so a startup failure on a runner names its cause.
const chrome = Bun.spawn([
  'sh', '-c',
  `exec google-chrome-stable --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage` +
  ` --disable-extensions --no-first-run --remote-debugging-port=${CHROME_PORT}` +
  ` --user-data-dir=/tmp/notiongit-reflow-chrome --window-size=1024,800 about:blank` +
  ` >"${CHROME_LOG}" 2>&1`,
], { stdout: 'ignore', stderr: 'ignore' });

interface Failure {
  surface: string;
  check: string;
  detail: string;
}

const failures: Failure[] = [];

try {
  // CI runners cold-start Chrome slowly; 30 seconds with fail-fast on an
  // early process exit keeps the wait bounded and the failure readable.
  let pageTarget: { type: string; webSocketDebuggerUrl: string } | undefined;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (chrome.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
      pageTarget = targets.find((target) => target.type === 'page');
      if (pageTarget) break;
    } catch {
      // Chrome not accepting connections yet.
    }
  }
  if (!pageTarget) {
    const log = await Bun.file(CHROME_LOG).text().catch(() => '(no Chrome log)');
    throw new Error(
      `Chrome did not expose a debuggable page (exit code ${chrome.exitCode}). Chrome log:\n${log.slice(-2000)}`,
    );
  }

  for (const surface of Object.keys(routes)) {
    for (const zoom of [1, 2]) {
      const cdp = await connect(pageTarget.webSocketDebuggerUrl);
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 320, height: 700, deviceScaleFactor: zoom, mobile: true,
      });
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.port}${surface}` });
      await new Promise((resolve) => setTimeout(resolve, 500));

      const evaluate = async (expression: string): Promise<any> => {
        const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
        return result.result.value;
      };

      const scrollWidth = await evaluate('document.documentElement.scrollWidth');
      if (scrollWidth > 320) {
        failures.push({ surface, check: `reflow at ${zoom}x`, detail: `scrollWidth ${scrollWidth}px exceeds the 320px viewport` });
      }

      if (zoom === 1) {
        const interactives: string[] = await evaluate(
          `[...document.querySelectorAll('a[href], button, input:not([type=hidden])')]` +
          `.filter((el) => el.checkVisibility())` +
          `.map((el) => el.tagName + '#' + (el.id || ''))`,
        );
        const reached = new Set<string>();
        for (let tab = 0; tab < interactives.length + 5; tab++) {
          for (const type of ['keyDown', 'keyUp'] as const) {
            await cdp.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
          }
          const focus = await evaluate(
            `(() => { const el = document.activeElement;` +
            ` if (!el || el === document.body || el === document.documentElement) return null;` +
            ` return { name: el.tagName + '#' + (el.id || ''),` +
            ` outline: getComputedStyle(el).outlineWidth }; })()`,
          );
          if (focus === null) break;
          reached.add(focus.name);
          if (focus.outline === '0px') {
            failures.push({ surface, check: 'focus visible', detail: `${focus.name} has no focus outline` });
          }
        }
        for (const expected of interactives) {
          if (!reached.has(expected)) {
            failures.push({ surface, check: 'keyboard operable', detail: `Tab never reached ${expected}` });
          }
        }
      }

      if (shotsDir !== null && zoom === 1) {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const name = surface.replaceAll('/', '') || 'landing';
        await Bun.write(join(shotsDir, `${name}-320.png`), Buffer.from(shot.data, 'base64'));
      }
      cdp.close();
    }
    console.log(`checked ${surface}`);
  }
} finally {
  chrome.kill();
  server.stop(true);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} reflow/keyboard failure(s):`);
  for (const failure of failures) {
    console.error(`  [${failure.surface}] ${failure.check}: ${failure.detail}`);
  }
  process.exit(1);
}
console.log('\nreflow and keyboard checks passed on all surfaces');
