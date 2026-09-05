/**
 * The single browser-facing error document for consent-handoff failures.
 *
 * A consent handoff is a browser navigation — a provider redirect or a
 * /connect entry link can only end in a document — so these paths render
 * this page rather than the JSON bodies a programmatic client would need.
 * Copy is canonical: the failure registry owns the message and action, and
 * the machine code stays visible because the layout must not hide error
 * detail. Mirrors the other routes: one self-contained document, design
 * tokens duplicated on purpose, no client JavaScript.
 */

import { failureDescriptor, userCopy, type ProvisioningFailureCode } from './failures';

export interface ErrorPageFailure {
  readonly code: ProvisioningFailureCode;
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  /** Where the start-again action sends the browser; null renders no button. */
  readonly restartHref: string | null;
  /** Non-secret remediation metadata (already redacted by the caller); the
   * page must not hide error detail just to simplify the layout. */
  readonly details?: Record<string, unknown> | null;
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
  a { color: var(--accent); }
  :focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  main { max-width: 720px; margin: 0 auto; padding: 3rem 1.5rem 4rem; }
  h1 {
    font-size: clamp(1.6rem, 4vw, 2.25rem);
    margin: 0 0 1rem;
    letter-spacing: -0.02em;
  }
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
  code {
    font-family: ui-monospace, monospace;
    font-size: 0.9em;
    overflow-wrap: anywhere;
  }
  ul.details {
    margin: 0 0 1rem;
    padding-left: 1.25rem;
    color: var(--muted);
    font-size: 0.9rem;
  }
  ul.details li { margin-bottom: 0.25rem; overflow-wrap: anywhere; }
`;

function retryText(seconds: number): string {
  if (seconds >= 2 * 60 * 60) return `about ${Math.round(seconds / 3600)} hours`;
  if (seconds >= 2 * 60) return `about ${Math.round(seconds / 60)} minutes`;
  return `in ${seconds} seconds`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function detailsHtml(details: Record<string, unknown> | null | undefined): string {
  if (!details) return '';
  const rows = Object.entries(details)
    .map(([key, value]) => `<li><code>${escapeHtml(key)}</code>: ${escapeHtml(JSON.stringify(value) ?? '')}</li>`)
    .join('');
  return rows === '' ? '' : `<ul class="details">${rows}</ul>`;
}

export function errorPage(failure: ErrorPageFailure): string {
  const copy = userCopy(failure.code);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>We could not complete this step</title>
<style>${STYLES}</style>
</head>
<body>
<main>
<h1>We could not complete this step</h1>
<p>${copy.message}</p>
<p>${copy.action}</p>
${detailsHtml(failure.details)}
${failure.restartHref === null ? '' : `<a class="cta" href="${failure.restartHref}">Start again</a>`}
${failure.retryAfterSeconds === null ? '' : `<p class="muted">You can try again ${retryText(failure.retryAfterSeconds)}.</p>`}
<p class="muted">Error code: <code>${failure.code}</code></p>
<p class="muted">Questions? See <a href="/support">Support</a> or the <a href="/privacy">Privacy Policy</a>.</p>
</main>
</body>
</html>`;
}

/** Renders the failure as the wire response for a browser navigation,
 * carrying the registry's HTTP status, any provider retry hint, and whatever
 * extra headers the route owns (Notion clears its redirect cookie here). */
export function errorPageResponse(failure: ErrorPageFailure, headers: Record<string, string> = {}): Response {
  const allHeaders: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    ...headers,
  };
  if (failure.retryAfterSeconds !== null) allHeaders['retry-after'] = String(failure.retryAfterSeconds);
  return new Response(errorPage(failure), { status: failure.status, headers: allHeaders });
}

/** The start-again target rule shared by callers: a flow restart only makes
 * sense when the registry says so. */
export function restartHrefFor(code: ProvisioningFailureCode, href: string): string | null {
  return failureDescriptor(code).recovery === 'restart_flow' ? href : null;
}
