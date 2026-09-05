/**
 * Server-rendered progress page for `GET /progress`.
 *
 * The document embeds the projection snapshot as a JSON island and re-renders
 * by toggling attributes and text only, so a snapshot can never inject markup.
 * The poll constants are exported for tests; the inline script is the only
 * client JavaScript in this project and makes no request outside this origin.
 */

import {
  progressPageUrl,
  PROGRESS_STAGE_ORDER,
  PROGRESS_STAGE_REGISTRY,
  type ProgressSnapshot,
  type ProgressStageState,
  type ProgressStageView,
  type PublicProgress,
} from './progress';

export const PROGRESS_POLL_INTERVAL_MS = 5000;
export const PROGRESS_POLL_MAX_INTERVAL_MS = 60_000;

/** Result of the one-shot server-side probe behind `?check=1`; null when the
 * render never probed (the default — a plain render must add no latency). */
export interface SiteCheckOutcome {
  readonly reachable: boolean;
  readonly checkedAt: number;
}

const PAGE_HEADINGS: { [S in PublicProgress['status']]: string } = {
  awaiting_notion: 'Connect Notion to finish setup',
  active: 'Setting up your site',
  succeeded: 'Your site is live',
  failed: 'Setup stopped',
  missing: 'We could not find a site setup in progress for this link',
};

const STATE_WORDS: { [S in ProgressStageState]: string } = {
  done: 'Done',
  current: 'In progress',
  pending: 'Waiting',
  blocked: 'Stopped',
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** JSON safe for an inline script island: a literal `<` would let snapshot
 * data close the tag. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function stagesOf(progress: PublicProgress): readonly ProgressStageView[] {
  return 'stages' in progress ? progress.stages : [];
}

function isTerminal(progress: PublicProgress): boolean {
  return progress.status === 'succeeded' || progress.status === 'failed' || progress.status === 'missing';
}

function currentStageOf(progress: PublicProgress): ProgressStageView | undefined {
  return stagesOf(progress).find((stage) => stage.state === 'current' || stage.state === 'blocked');
}

function liveText(progress: PublicProgress): string {
  if (progress.status === 'failed') return progress.message;
  if (progress.status === 'missing') return progress.message;
  const current = currentStageOf(progress);
  return current ? PROGRESS_STAGE_REGISTRY[current.id].headline : PAGE_HEADINGS[progress.status];
}

// The design-token custom properties are duplicated from landing-page.ts on
// purpose: one self-contained document per route, no shared stylesheet asset.
const STYLES = `
  :root {
    --bg: #ffffff;
    --fg: #1f2328;
    --muted: #57606a;
    --accent: #0969da;
    --accent-fg: #ffffff;
    --border: #d0d7de;
    --surface: #f6f8fa;
    --ok: #1a7f37;
    --danger: #cf222e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117;
      --fg: #e6edf3;
      --muted: #8b949e;
      --accent: #58a6ff;
      --accent-fg: #0d1117;
      --border: #30363d;
      --surface: #161b22;
      --ok: #3fb950;
      --danger: #f85149;
    }
  }
  * { box-sizing: border-box; }
  html { color-scheme: light dark; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1.55;
  }
  .skip-link {
    position: absolute;
    left: -9999px;
    top: 0;
    background: var(--accent);
    color: var(--accent-fg);
    padding: 0.75rem 1.25rem;
    z-index: 10;
  }
  .skip-link:focus { left: 0.5rem; top: 0.5rem; }
  a { color: var(--accent); }
  :focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  main { max-width: 720px; margin: 0 auto; padding: 3rem 1.5rem 4rem; }
  h1 {
    font-size: clamp(1.6rem, 4vw, 2.25rem);
    margin: 0 0 1rem;
    letter-spacing: -0.02em;
  }
  #progress-live { color: var(--muted); margin: 0 0 2rem; }
  ol.checklist { list-style: none; margin: 0 0 2rem; padding: 0; display: grid; gap: 0.6rem; }
  ol.checklist li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem 1rem;
  }
  ol.checklist li[data-state="pending"] { color: var(--muted); }
  ol.checklist li[data-state="current"] { border-color: var(--accent); animation: pulse 2s ease-in-out infinite; }
  ol.checklist li[data-state="current"] .stage-state { color: var(--accent); }
  ol.checklist li[data-state="done"] { border-color: var(--ok); }
  ol.checklist li[data-state="done"] .stage-state { color: var(--ok); }
  ol.checklist li[data-state="blocked"] { border-color: var(--danger); }
  ol.checklist li[data-state="blocked"] .stage-state { color: var(--danger); }
  .stage-state { font-size: 0.9rem; font-weight: 600; white-space: nowrap; }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(9, 105, 218, 0.35); }
    50% { box-shadow: 0 0 0 4px rgba(9, 105, 218, 0); }
  }
  @media (prefers-reduced-motion: reduce) {
    ol.checklist li[data-state="current"] { animation: none; }
  }
  .panel p { margin: 0 0 0.75rem; }
  .notice {
    border: 1px solid var(--border);
    background: var(--surface);
    border-radius: 8px;
    padding: 0.9rem 1.1rem;
    margin: 0 0 1.25rem;
  }
  .notice p { margin: 0; }
  .notice p + p { margin-top: 0.35rem; color: var(--muted); }
  .cta {
    display: inline-block;
    background: var(--accent);
    color: var(--accent-fg);
    font-weight: 600;
    padding: 0.7rem 1.4rem;
    border-radius: 8px;
    text-decoration: none;
    margin: 0.5rem 0;
  }
  .cta:hover { text-decoration: none; filter: brightness(1.08); }
  .muted { color: var(--muted); }
  .panel h2 { font-size: 1.15rem; margin: 1.75rem 0 0.5rem; }
  ul.link-list { list-style: none; margin: 0 0 1rem; padding: 0; display: grid; gap: 0.5rem; }
  ul.link-list li {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.6rem 1rem;
  }
  .link-list .notion-missing { color: var(--muted); }
  [hidden] { display: none !important; }
`;

const HEADLINES_JSON = scriptJson(Object.fromEntries(
  PROGRESS_STAGE_ORDER.map((id) => [id, PROGRESS_STAGE_REGISTRY[id].headline]),
));

/** The one-shot re-check's outcome copy, shared by the server render (?check=1)
 * and the client-side writer so both transports phrase it identically. */
const CHECK_OK_COPY = 'Checked just now: your site is answering.';
const CHECK_NOT_YET_COPY = 'Checked just now: not answering yet. Try again in a minute.';

const SCRIPT = `
  const HEADINGS = ${scriptJson(PAGE_HEADINGS)};
  const HEADLINES = ${HEADLINES_JSON};
  const STATE_WORDS = ${scriptJson(STATE_WORDS)};
  const CHECK_OK = ${scriptJson(CHECK_OK_COPY)};
  const CHECK_NOT_YET = ${scriptJson(CHECK_NOT_YET_COPY)};
  const POLL_MS = ${PROGRESS_POLL_INTERVAL_MS};
  const POLL_MAX_MS = ${PROGRESS_POLL_MAX_INTERVAL_MS};

  let snapshot = JSON.parse(document.getElementById('progress-data').textContent);
  let delayMs = POLL_MS;
  let timer = 0;
  const mainElement = document.getElementById('main-content');
  const statusUrl = mainElement.getAttribute('data-status-url');
  const siteCheckUrl = mainElement.getAttribute('data-site-check-url');
  const headingElement = document.getElementById('progress-heading');
  const liveElement = document.getElementById('progress-live');
  const rows = new Map([...document.querySelectorAll('[data-stage-id]')].map((row) => [row.getAttribute('data-stage-id'), row]));
  const panels = new Map([...document.querySelectorAll('[data-panel]')].map((panel) => [panel.getAttribute('data-panel'), panel]));

  const isTerminal = (value) => ['succeeded', 'failed', 'missing'].includes(value.progress.status);

  const setText = (id, text) => {
    const element = document.getElementById(id);
    if (element) element.textContent = text;
  };

  const setLink = (id, url, text) => {
    const element = document.getElementById(id);
    if (!element) return;
    element.setAttribute('href', url);
    if (text !== undefined) element.textContent = text;
  };

  // A null URL hides the anchor entirely (never an empty href) and shows the
  // linkless fallback, matching what the server rendered for a null.
  const setNotionLink = (id, url) => {
    const link = document.getElementById(id);
    const missing = document.getElementById(id + '-missing');
    if (!link || !missing) return;
    if (url === null) {
      link.removeAttribute('href');
      link.hidden = true;
      missing.hidden = false;
    } else {
      link.setAttribute('href', url);
      link.hidden = false;
      missing.hidden = true;
    }
  };

  const writeSiteCheckResult = (reachable) => {
    setText('site-check-result', reachable ? CHECK_OK : CHECK_NOT_YET);
    const result = document.getElementById('site-check-result');
    if (result) result.hidden = false;
  };

  // Binds the re-check affordance at most once per document. The probe never
  // touches the poll timer: polling stays stopped at terminal.
  let siteCheckBound = false;
  function bindSiteCheck() {
    if (siteCheckBound) return;
    siteCheckBound = true;
    const element = document.getElementById('site-check-link');
    if (!element || !siteCheckUrl) return;
    element.addEventListener('click', async (event) => {
      event.preventDefault();
      let reachable = null;
      try {
        const response = await fetch(siteCheckUrl, { headers: { accept: 'application/json' } });
        if (!response.ok) return;
        reachable = (await response.json()).reachable;
      } catch {
        return;
      }
      if (typeof reachable === 'boolean') writeSiteCheckResult(reachable);
    });
  }

  function render(next) {
    const progress = next.progress;
    for (const [name, panel] of panels) panel.hidden = name !== progress.status;
    headingElement.textContent = HEADINGS[progress.status];
    for (const stage of progress.stages ?? []) {
      const row = rows.get(stage.id);
      if (!row) continue;
      row.setAttribute('data-state', stage.state);
      row.querySelector('.stage-state').textContent = STATE_WORDS[stage.state];
    }
    if (progress.status === 'active') {
      document.getElementById('active-notice').hidden = progress.notice === null;
      setText('notice-message', progress.notice ? progress.notice.message : '');
      setText('notice-action', progress.notice ? progress.notice.action : '');
    }
    if (progress.status === 'succeeded') {
      setLink('site-link', progress.site.url);
      setLink('repository-link', progress.repository.url, progress.repository.name);
      setNotionLink('notion-root-link', progress.notionLinks.templateRootUrl);
      setNotionLink('notion-pages-link', progress.notionLinks.pagesUrl);
      setNotionLink('notion-posts-link', progress.notionLinks.postsUrl);
      bindSiteCheck();
    }
    if (progress.status === 'failed') {
      setText('failed-message', progress.message);
      setText('failed-action', progress.action);
      document.getElementById('failed-restart').hidden = progress.restartUrl === null;
      if (progress.restartUrl !== null) setLink('failed-restart', progress.restartUrl);
    }
    if (progress.status === 'missing') {
      setText('missing-message', progress.message);
      setText('missing-action', progress.action);
    }
    const current = (progress.stages ?? []).find((stage) => stage.state === 'current' || stage.state === 'blocked');
    const headline = current ? HEADLINES[current.id] : HEADINGS[progress.status];
    // Writing identical text re-triggers some screen readers; announce only
    // real changes so a slow poll cadence never reads the same line twice.
    const announcement = progress.status === 'failed' ? progress.message : headline;
    if (liveElement.textContent !== announcement) liveElement.textContent = announcement;
    document.title = current && !isTerminal(next) ? headline : HEADINGS[progress.status];
  }

  function schedule() {
    if (document.hidden) return;
    const hint = snapshot.progress.status === 'active' ? snapshot.progress.pollAfterSeconds : null;
    timer = setTimeout(poll, Math.max(delayMs, (hint ?? 0) * 1000));
  }

  async function poll() {
    try {
      const response = await fetch(statusUrl, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('unusable status response');
      const next = await response.json();
      if (next.updatedAt > snapshot.updatedAt) {
        snapshot = next;
        delayMs = POLL_MS;
        render(snapshot);
      } else {
        delayMs = Math.min(delayMs * 2, POLL_MAX_MS);
      }
    } catch {
      delayMs = Math.min(delayMs * 2, POLL_MAX_MS);
    }
    if (isTerminal(snapshot)) return;
    schedule();
  }

  render(snapshot);
  if (isTerminal(snapshot)) return;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(timer);
    else poll();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) poll();
  });
  schedule();
`;

function checklistRow(stage: ProgressStageView): string {
  return `<li data-stage-id="${stage.id}" data-state="${stage.state}">` +
    `<span class="stage-label">${escapeHtml(stage.label)}</span>` +
    `<span class="stage-state">${STATE_WORDS[stage.state]}</span>` +
    `</li>`;
}

/** Shown where a captured link would have been; null never renders an anchor. */
const NOTION_LINK_FALLBACK = 'We could not capture a link here. You can find this page in your Notion workspace.';

function notionLinkRow(name: string, url: string | null, id: string): string {
  const link = url === null ? '' : `<a id="${id}" href="${escapeHtml(url)}">Open in Notion</a>`;
  const missing =
    `<span id="${id}-missing" class="notion-missing"${url === null ? '' : ' hidden'}>${escapeHtml(NOTION_LINK_FALLBACK)}</span>`;
  return `<li><span class="link-name">${escapeHtml(name)}</span>${link}${missing}</li>`;
}

function panelsHtml(progress: PublicProgress, jobId: string, siteCheck: SiteCheckOutcome | null): string {
  const open = (status: PublicProgress['status']): string =>
    `<section class="panel" data-panel="${status}"${progress.status === status ? '' : ' hidden'}>`;

  const activeNotice = progress.status === 'active' ? progress.notice : null;
  const restartUrl = progress.status === 'failed' ? progress.restartUrl : null;
  const connectNotionHref = `/connect/notion?job_id=${encodeURIComponent(jobId)}`;
  // Outside the succeeded snapshot every dynamic value resolves to its null
  // state, so a hidden panel never renders a live link.
  const rootUrl = progress.status === 'succeeded' ? progress.notionLinks.templateRootUrl : null;
  const pagesUrl = progress.status === 'succeeded' ? progress.notionLinks.pagesUrl : null;
  const postsUrl = progress.status === 'succeeded' ? progress.notionLinks.postsUrl : null;
  const checkOutcome = progress.status === 'succeeded' ? siteCheck : null;
  const checkResultLine = checkOutcome === null
    ? '<p id="site-check-result" class="muted" role="status" hidden></p>'
    : `<p id="site-check-result" class="muted" role="status">${escapeHtml(checkOutcome.reachable ? CHECK_OK_COPY : CHECK_NOT_YET_COPY)}</p>`;
  const checkHref = `/progress?job_id=${encodeURIComponent(jobId)}&check=1`;

  return [
    `${open('active')}`,
    '<p>You can leave this page open. It updates itself while the setup runs.</p>',
    `<div id="active-notice" class="notice"${activeNotice ? '' : ' hidden'}>`,
    `<p id="notice-message">${escapeHtml(activeNotice?.message ?? '')}</p>`,
    `<p id="notice-action">${escapeHtml(activeNotice?.action ?? '')}</p>`,
    '</div>',
    '</section>',

    `${open('awaiting_notion')}`,
    '<p>Your repository is ready and its setup secrets are stored.</p>',
    '<p>Connect Notion so InkDrafts can find your Pages and Posts databases. The first sync and publish then run on their own.</p>',
    `<a class="cta" href="${escapeHtml(connectNotionHref)}">Connect Notion</a>`,
    '<p class="muted">Notion grants read access only, and InkDrafts keeps no copy of the token. Read the <a href="/privacy">Privacy Policy</a> before you continue.</p>',
    '</section>',

    `${open('succeeded')}`,
    '<p>Your site is published. It stays in sync with your Notion pages.</p>',
    `<p><a id="site-link" class="cta" href="${escapeHtml(progress.status === 'succeeded' ? progress.site.url : '')}">View your site</a></p>`,
    '<p class="muted">We checked that your site was live right before publishing finished. If the link does not open yet, GitHub’s network may still be updating it. It is usually ready within a few minutes.</p>',
    checkResultLine,
    `<a id="site-check-link" href="${escapeHtml(checkHref)}">Check if it is up yet</a>`,
    '<h2>Everyday writing happens in Notion</h2>',
    '<ul class="link-list">',
    notionLinkRow('Start from your home page', rootUrl, 'notion-root-link'),
    notionLinkRow('Pages database', pagesUrl, 'notion-pages-link'),
    notionLinkRow('Posts database', postsUrl, 'notion-posts-link'),
    '</ul>',
    '<p>Changes you make in Notion appear on your site automatically. Syncing runs about every 10 minutes.</p>',
    '<p>To see sync and publish status, or to run a sync now, open <a href="/status">your dashboard</a>.</p>',
    '<h2>Your site is a repository you own</h2>',
    `<p><a id="repository-link" href="${escapeHtml(progress.status === 'succeeded' ? progress.repository.url : '')}">${escapeHtml(progress.status === 'succeeded' ? progress.repository.name : '')}</a></p>`,
    '<p>Writing happens in Notion, so you never need GitHub for your everyday work. The repository itself is yours to keep: advanced users can customize the Jekyll site, themes, and workflows directly, and your site keeps working even if InkDrafts disappears.</p>',
    '<p>Want to use your own domain name? GitHub’s <a href="https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site">custom domain guide</a> shows how.</p>',
    '</section>',

    `${open('failed')}`,
    `<p id="failed-message">${escapeHtml(progress.status === 'failed' ? progress.message : '')}</p>`,
    `<p id="failed-action">${escapeHtml(progress.status === 'failed' ? progress.action : '')}</p>`,
    `<a id="failed-restart" class="cta" href="/connect/github"${restartUrl === null ? ' hidden' : ''}>Connect GitHub to start again</a>`,
    '</section>',

    `${open('missing')}`,
    `<p id="missing-message">${escapeHtml(progress.status === 'missing' ? progress.message : '')}</p>`,
    `<p id="missing-action">${escapeHtml(progress.status === 'missing' ? progress.action : '')}</p>`,
    '<a class="cta" href="/connect/github">Connect GitHub to start again</a>',
    '</section>',
  ].join('\n');
}

/**
 * Renders the one progress document. `siteCheck` carries the outcome of the
 * optional `?check=1` propagation probe; only a succeeded snapshot renders
 * it, and a plain render (null) never probes and keeps the result line
 * hidden for the client writer to fill.
 */
export function progressPage(
  jobId: string,
  snapshot: ProgressSnapshot,
  siteCheck: SiteCheckOutcome | null = null,
): string {
  const progress = snapshot.progress;
  const heading = PAGE_HEADINGS[progress.status];
  const current = currentStageOf(progress);
  const title = isTerminal(progress) || !current
    ? heading
    : PROGRESS_STAGE_REGISTRY[current.id].headline;
  // The no-JS affordance is a manual reload, never a forced meta refresh:
  // auto-reload with no way to decline is a WCAG 2.2.1 failure (axe
  // meta-refresh, critical).
  const refresh = isTerminal(progress)
    ? ''
    : `<noscript><p class="muted">This page updates itself with JavaScript. Without it, <a href="${escapeHtml(progressPageUrl(jobId))}">refresh the page</a> to check on the setup.</p></noscript>`;
  const statusUrl = `/progress/status?job_id=${encodeURIComponent(jobId)}`;
  const siteCheckUrl = `/progress/site-check?job_id=${encodeURIComponent(jobId)}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to content</a>
<main id="main-content" data-status-url="${escapeHtml(statusUrl)}" data-site-check-url="${escapeHtml(siteCheckUrl)}">
<h1 id="progress-heading">${escapeHtml(heading)}</h1>
<p id="progress-live" role="status" aria-live="polite">${escapeHtml(liveText(progress))}</p>
${refresh}
${stagesOf(progress).length ? `<ol class="checklist" aria-label="Setup steps">
${stagesOf(progress).map(checklistRow).join('\n')}
</ol>` : ''}
${panelsHtml(progress, jobId, siteCheck)}
</main>
<script type="application/json" id="progress-data">${scriptJson(snapshot)}</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}
