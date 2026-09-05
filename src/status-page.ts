/**
 * Server-rendered status page for the post-install surface.
 *
 * Mirrors `progress-page.ts`'s one self-contained document per route: the
 * design-token custom properties are duplicated on purpose, there is no
 * shared stylesheet asset, and there is no client JavaScript — the only
 * refresh mechanism is a meta tag rendered while a sync run is in flight.
 * Rendering is total over `StatusPageModel`: the headings table and the
 * body switch are both keyed by the model's kind, so a new union arm fails
 * compilation here first. Every string that came from a provider or the
 * session is escaped on its way into the document.
 */

import type { DeployOutcome, StatusPageModel, SummaryCounts, SummaryFallbackReason, SyncOutcome } from './status';

/** Request-scoped extras the handlers own: the post-redirect-get notice and
 * the signed CSRF token embedded in the Sync-now form. Neither is domain
 * state — a model without them is still fully renderable. */
export interface StatusPageChrome {
  readonly notice: 'signin_required' | 'sync_triggered' | 'already_running' | null;
  readonly rerunFormToken: string | null;
}

const PAGE_HEADINGS: { [K in StatusPageModel['kind']]: string } = {
  entry: 'Check your site',
  session: 'Your site',
  no_site: 'We could not find an InkDrafts site on this account',
  installation_gone: 'InkDrafts no longer has access to your GitHub account',
  installation_suspended: 'Your InkDrafts access is suspended',
  github_unavailable: 'GitHub is not answering right now',
  auth_failed: 'Sign-in did not complete',
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Deterministic UTC rendering for run timestamps; null stays empty. */
function utcText(ms: number | null): string {
  if (ms === null) return '';
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function durationText(seconds: number): string {
  if (seconds >= 2 * 60 * 60) return `about ${Math.round(seconds / 3600)} hours`;
  if (seconds >= 2 * 60) return `about ${Math.round(seconds / 60)} minutes`;
  return `in ${seconds} seconds`;
}

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
  .notice {
    border: 1px solid var(--border);
    background: var(--surface);
    border-radius: 8px;
    padding: 0.9rem 1.1rem;
    margin: 0 0 1.25rem;
  }
  .notice p { margin: 0; color: var(--muted); }
  section.card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem 1.25rem;
    margin: 0 0 1.25rem;
  }
  section.card h2 { font-size: 1.05rem; margin: 0 0 0.5rem; }
  section.card p { margin: 0 0 0.5rem; }
  .muted { color: var(--muted); }
  .ok { color: var(--ok); }
  .danger { color: var(--danger); }
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
  button.cta { border: none; cursor: pointer; font: inherit; }
  ul.revocations { margin: 0; padding-left: 1.25rem; }
  ul.revocations li { margin: 0 0 0.75rem; }
  ul.revocations li:last-child { margin-bottom: 0; }
  ul.sync-counts { margin: 0.5rem 0 0; padding-left: 1.25rem; }
`;

const CONNECT_URL = '/status?connect=1';

const NOTICES: { [N in NonNullable<StatusPageChrome['notice']>]: string } = {
  signin_required: 'Please sign in with GitHub to see your site status.',
  sync_triggered: 'A sync was triggered. Reload in a moment to watch it run.',
  already_running: 'A sync is already running. Refresh to pick up the result when it finishes.',
};

/** The document never reloads itself: forced refresh with no way to decline
 * is a WCAG 2.2.1 failure (axe meta-refresh, critical), so a run in flight
 * offers a manual reload instead. */
const REFRESH_HTML = `
<p><a href="/status">Refresh</a> to pick up the result when the run finishes.</p>`;

const DISCONNECT_HTML = `
<section class="card">
<h2>Leaving InkDrafts</h2>
<ul class="revocations">
<li>To stop future syncs, revoke the InkDrafts connection in Notion
(Settings &#8594; Connections). The scheduled Action&#39;s next run then fails on
invalid credentials, and syncing stays stopped until you reconnect InkDrafts.
You can also switch the sync off yourself in the repository&#39;s Actions tab.</li>
<li>To end InkDrafts&#39; management access, uninstall the InkDrafts App on GitHub
(Settings &#8594; Applications &#8594; Installed GitHub Apps). This page will show the
access as gone, and the site itself keeps working: scheduled syncs run in your
own repository, not through InkDrafts.</li>
<li>To require approval again before signing in, revoke the InkDrafts OAuth
authorization on GitHub (Settings &#8594; Applications &#8594; Authorized OAuth Apps).
A status page signed in during the last 8 hours keeps working until its
session expires.</li>
</ul>
<p class="muted">In every case your repository and your published site stay yours.
The full walkthrough, including deleting your site, is on the
<a href="/leaving">Leaving InkDrafts</a> page.</p>
</section>`;

function countsText(counts: SummaryCounts): string {
  return `${counts.created} created, ${counts.updated} updated, ${counts.renamed} renamed, ${counts.deleted} deleted, ${counts.unchanged} unchanged, ${counts.errors} errors`;
}

function summaryStatement(sync: Extract<SyncOutcome, { source: 'summary_v1' }>): string {
  switch (sync.code) {
    case 'synced':
      return sync.kind === 'succeeded' ? 'The sync completed.' : 'The sync reported a success result.';
    case 'missing_credentials':
      return 'No sync ran because Notion credentials are missing.';
    case 'bulk_delete_guard':
      return 'The sync stopped because a bulk delete looked unsafe.';
    case 'sync_error':
      return 'The sync failed before it could finish.';
    case 'row_errors':
      return 'The sync finished with some rows that could not sync.';
  }
  if (sync.kind === 'succeeded') return 'The sync completed.';
  if (sync.kind === 'no_op') return 'The sync did not change the site.';
  return 'The sync reported a failure.';
}

function summaryLabel(sync: Extract<SyncOutcome, { source: 'summary_v1' }>): string {
  if (sync.kind === 'succeeded') return 'Last hand-triggered sync succeeded.';
  if (sync.kind === 'no_op') return 'Last hand-triggered sync made no changes.';
  return 'Last hand-triggered sync failed.';
}

function summaryDetails(sync: Extract<SyncOutcome, { source: 'summary_v1' }>): string {
  const counts = [
    sync.pages === null ? '' : `<li>Pages: ${countsText(sync.pages)}</li>`,
    sync.posts === null ? '' : `<li>Posts: ${countsText(sync.posts)}</li>`,
  ].join('');
  const detail = sync.detail === null ? '' : `<p class="muted">${escapeHtml(sync.detail)}</p>`;
  return `${detail}${counts === '' ? '' : `<ul class="sync-counts">${counts}</ul>`}`;
}

function syncHtml(sync: SyncOutcome, summaryFallback?: SummaryFallbackReason): string {
  if (sync.kind === 'never_ran') return '<p>No hand-triggered sync has run yet. Your site also syncs on its schedule.</p>';
  const runLink = sync.runUrl === null ? '' : ` <a href="${escapeHtml(sync.runUrl)}">View the run on GitHub</a>.`;
  const when = (ms: number | null) => (ms === null ? '' : ` ${utcText(ms)}`);
  const fallbackReason = summaryFallback === 'unsupported_version'
    ? ' The saved summary uses an unsupported version.'
    : summaryFallback === 'malformed'
      ? ' The saved summary could not be read.'
      : '';
  const fallback = `<p class="muted">Derived from the workflow run result; per-file counts and scheduled runs are on GitHub.${fallbackReason}</p>`;
  if ('source' in sync) {
    const statusClass = sync.kind === 'failed' ? 'danger' : 'ok';
    return `<p class="${statusClass}">${summaryLabel(sync)}${when(sync.finishedAtMs)}</p>${runLink}<p>${summaryStatement(sync)}</p>${summaryDetails(sync)}`;
  }
  switch (sync.kind) {
    case 'running':
      return `<p class="ok">A sync is running right now.${when(sync.startedAtMs)}</p>${runLink}${fallback}`;
    case 'succeeded':
      return `<p class="ok">Last hand-triggered sync succeeded.${when(sync.finishedAtMs)}</p>${runLink}${fallback}`;
    case 'failed':
      return `<p class="danger">Last hand-triggered sync did not succeed (reported as &ldquo;${escapeHtml(sync.conclusion)}&rdquo;).${when(sync.finishedAtMs)}</p>${runLink}${fallback}`;
    default: {
      const never: never = sync;
      return never;
    }
  }
}

function deployHtml(deploy: DeployOutcome): string {
  switch (deploy.kind) {
    case 'never_built':
      return '<p>No publish has run yet.</p>';
    case 'building':
      return '<p class="ok">A publish is running right now.</p>';
    case 'built':
      return '<p class="ok">Your site was published.</p>';
    case 'errored':
      return '<p class="danger">The last publish failed. Publishing runs again after the next sync that changes your content.</p>';
  }
}

function rerunFormHtml(token: string): string {
  return `
<form method="post" action="/status/rerun">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<button class="cta" type="submit">Sync now</button>
</form>
<p class="muted">Runs the same sync your site runs on schedule. Limited to a few runs per day.</p>`;
}

function bodyOf(model: StatusPageModel, chrome: StatusPageChrome): string {
  const notice = (key: NonNullable<StatusPageChrome['notice']>) => `<div class="notice"><p>${NOTICES[key]}</p></div>`;

  switch (model.kind) {
    case 'entry':
      return `
${chrome.notice === 'signin_required' ? notice('signin_required') : ''}
<p>This page shows your InkDrafts site&#39;s last sync and publish, and lets you run
a sync by hand. Bookmark it: the link never expires.</p>
<p>Because InkDrafts never stores your account binding, you sign in with GitHub
once per browser session. GitHub remembers your grant, so the check is usually
a quick redirect you barely notice.</p>
<a class="cta" href="${CONNECT_URL}">Sign in with GitHub</a>`;

    case 'session':
      return `
<p class="muted">Signed in as ${escapeHtml(model.viewer.login)}.</p>
${chrome.notice === null ? '' : notice(chrome.notice)}
<section class="card">
<h2>Content sync</h2>
${syncHtml(model.site.sync, model.site.summaryFallback)}
</section>
<section class="card">
<h2>Publishing</h2>
${deployHtml(model.site.deploy)}
<p>Site: <a href="${escapeHtml(model.site.site.url)}">${escapeHtml(model.site.site.url)}</a><br>
Repository: <a href="${escapeHtml(model.site.repository.url)}">${escapeHtml(model.site.repository.name)}</a></p>
</section>
${model.site.runInFlight ? REFRESH_HTML : ''}
${chrome.rerunFormToken === null ? '' : rerunFormHtml(chrome.rerunFormToken)}
${DISCONNECT_HTML}`;

    case 'no_site':
      return `
<p class="muted">Signed in as ${escapeHtml(model.viewer.login)}.</p>
<p>No repository with the InkDrafts marker was found on this account. If you
expected a site here, check that you signed in with the same GitHub account
that set it up.</p>
<p>If the repository was deleted, or its description was edited, InkDrafts can
no longer recognize it. Set a site up again from the <a href="/">InkDrafts
homepage</a>, or <a href="${CONNECT_URL}">sign in with a different GitHub
account</a>.</p>
${DISCONNECT_HTML}`;

    case 'installation_gone':
      return `
<p class="muted">Signed in as ${escapeHtml(model.viewer.login)}.</p>
<p>The InkDrafts GitHub App is not installed for this account any more, so
InkDrafts cannot see your site. Your repository and published site keep
working on their own.</p>
<p>To use InkDrafts again, set a site up again from the <a href="/">InkDrafts
homepage</a>.</p>
${DISCONNECT_HTML}`;

    case 'installation_suspended':
      return `
<p class="muted">Signed in as ${escapeHtml(model.viewer.login)}.</p>
<p>The InkDrafts GitHub App installation is suspended, so InkDrafts cannot see
your site right now. Your repository and published site keep working on their
own.</p>
<p>To resume it, open GitHub&#39;s settings (Settings &#8594; Applications &#8594;
Installed GitHub Apps &#8594; InkDrafts &#8594; Configure) and remove the suspension.</p>
${DISCONNECT_HTML}`;

    case 'github_unavailable':
      return `
<p>GitHub did not answer, so your site status could not be read. Nothing is
wrong with your site as far as anyone can tell from here.</p>
<p class="muted">${model.retryAfterSeconds === null ? 'Try again in a moment.' : `Try again ${durationText(model.retryAfterSeconds)}.`}</p>
<a class="cta" href="/status">Try again</a>`;

    case 'auth_failed':
      return `
<p>${model.reason === 'denied'
        ? 'The GitHub sign-in was cancelled, so your site status could not be shown.'
        : model.reason === 'no_installation'
          ? 'You signed in, but the InkDrafts GitHub App is not installed on your personal GitHub account, so there is no site to show. Set a site up from the <a href="/">InkDrafts homepage</a> first.'
          : 'The sign-in link was invalid, expired, or already used, so your site status could not be shown.'}</p>
${model.reason === 'no_installation' ? '' : `<a class="cta" href="${CONNECT_URL}">Sign in again</a>`}`;

    default: {
      const never: never = model;
      return never;
    }
  }
}

export function statusPage(model: StatusPageModel, chrome: StatusPageChrome): string {
  const heading = PAGE_HEADINGS[model.kind];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)}</title>
<style>${STYLES}</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to content</a>
<main id="main-content">
<h1>${escapeHtml(heading)}</h1>
${bodyOf(model, chrome)}
</main>
</body>
</html>`;
}

/** A transient throttle or outage response: real copy and the retry hint,
 * outside the page-state union because it is not a state of the site. */
export function statusRefusalPage(options: {
  readonly title: string;
  readonly body: string;
  readonly retryAfterSeconds: number | null;
}): string {
  const retry = options.retryAfterSeconds === null ? '' : `<p class="muted">Try again ${durationText(options.retryAfterSeconds)}.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
<h1>${escapeHtml(options.title)}</h1>
<p>${escapeHtml(options.body)}</p>
${retry}
</main>
</body>
</html>`;
}
