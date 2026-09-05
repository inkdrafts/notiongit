/**
 * The static policy documents behind the footer links: privacy, terms,
 * security, acceptable use, support, and leaving (deletion and disconnect).
 *
 * They exist because the launch gate requires policies to be reachable before
 * consent and to match the real implementation, so every retention or token
 * claim here is either computed from the source constant that enforces it
 * (`PROVISIONING_JOB_TTL_SECONDS`, `STATUS_SESSION_TTL_SECONDS`) or pinned by
 * test/policy-pages.test.ts to the platform figures documented in
 * `docs/observability.md`. The copy deliberately makes no security
 * certification claim and promises no perfect security.
 *
 * Mirrors the other routes: one self-contained document per policy, design
 * tokens duplicated on purpose, no client JavaScript, no external requests.
 */

import { PROVISIONING_JOB_TTL_SECONDS } from './provisioning-job';
import { STATUS_SESSION_TTL_SECONDS } from './status';

export interface PolicyPage {
  readonly path: string;
  readonly title: string;
  readonly document: string;
}

const JOB_RETENTION_HOURS = PROVISIONING_JOB_TTL_SECONDS / 3600;
const SESSION_HOURS = STATUS_SESSION_TTL_SECONDS / 3600;

const SUPPORT = '<a href="/support">Support</a>';

const REPO = 'https://github.com/inkdrafts/notiongit';

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
  header { border-bottom: 1px solid var(--border); }
  .nav-inner {
    max-width: 720px;
    margin: 0 auto;
    padding: 1rem 1.5rem;
  }
  .wordmark { font-weight: 700; font-size: 1.1rem; color: var(--fg); text-decoration: none; }
  main { max-width: 720px; margin: 0 auto; padding: 2.5rem 1.5rem 3rem; }
  h1 {
    font-size: clamp(1.6rem, 4vw, 2.25rem);
    margin: 0 0 1rem;
    letter-spacing: -0.02em;
  }
  h2 { font-size: 1.25rem; margin: 2rem 0 0.5rem; }
  .updated { color: var(--muted); margin: 0 0 1.5rem; }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 0.75rem 0 1.5rem;
    font-size: 0.95rem;
  }
  th, td {
    border: 1px solid var(--border);
    padding: 0.5rem 0.75rem;
    text-align: left;
    vertical-align: top;
  }
  th { background: var(--surface); }
  code {
    font-family: ui-monospace, monospace;
    font-size: 0.9em;
    overflow-wrap: anywhere;
  }
  footer {
    border-top: 1px solid var(--border);
    padding: 1.5rem;
  }
  footer nav {
    max-width: 720px;
    margin: 0 auto;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.25rem;
    font-size: 0.9rem;
  }
`;

interface PolicyBody {
  readonly path: string;
  readonly title: string;
  readonly heading: string;
  readonly body: string;
}

const UPDATED = 'Updated September 2026';

const BODIES: readonly PolicyBody[] = [
  {
    path: '/privacy',
    title: 'Privacy Policy',
    heading: 'Privacy Policy',
    body: `
<p class="updated">${UPDATED}</p>
<p>InkDrafts connects Notion and GitHub. It creates a website repository in
your GitHub account and keeps it in sync with your Notion pages. This policy
describes what the service keeps and for how long. It matches the public
code in <a href="${REPO}">inkdrafts/notiongit</a>.</p>

<h2>Summary</h2>
<ul>
<li>InkDrafts keeps no copy of your Notion or GitHub access tokens.</li>
<li>Setup records delete themselves within ${JOB_RETENTION_HOURS} hours.</li>
<li>No advertising, no trackers, no data selling, no third-party analytics.</li>
<li>Your repository, content, and published site are yours and stay with you.</li>
</ul>

<h2>What InkDrafts keeps, and for how long</h2>
<table>
<tr><th>Record</th><th>Contents</th><th>Kept for</th></tr>
<tr>
<td>Setup record</td>
<td>Your GitHub account id, login, account type, the App installation id, your
repository's name and URL, and the outcome of each setup step. It is tied to a
random job id, not to any InkDrafts account.</td>
<td>${JOB_RETENTION_HOURS} hours after the last update, then deleted
automatically. This includes finished and failed setups.</td>
</tr>
<tr>
<td>Template validation record</td>
<td>Property names, property types, and select options of the Pages and Posts
databases in the Notion template you duplicated. InkDrafts reads this to verify
the template was duplicated correctly. No page content is in it.</td>
<td>${JOB_RETENTION_HOURS} hours. Reconnecting Notion replaces it.</td>
</tr>
<tr>
<td>Operational metrics</td>
<td>Step names, outcomes, error codes, and durations for each setup, correlated
only by the random job id. No account name, no repository name, no content.</td>
<td>Aggregates are kept for three months. Structured logs, where enabled, are
kept for at most seven days.</td>
</tr>
<tr>
<td>Abuse controls</td>
<td>Short-lived counters that keep someone from starting many setups at once.
A counter contains a GitHub account id or a keyed hash of your network address,
never the address itself.</td>
<td>Between one minute and seven days depending on the counter.</td>
</tr>
<tr>
<td>Dashboard session</td>
<td>If you sign in to your dashboard, a cookie carries your GitHub login and
account id. The dashboard re-derives your site's state from GitHub on every
visit. InkDrafts stores no account-to-site binding.</td>
<td>${SESSION_HOURS} hours, or until you sign out of the dashboard.</td>
</tr>
</table>

<h2>Access tokens</h2>
<p>Your GitHub authorization is used inside a single request to create your
repository, then discarded. InkDrafts never stores a GitHub access token.</p>
<p>Your Notion token is written once into your own repository's Actions
secrets, for the sync workflow inside your repository to use. The value is
sealed with libsodium encryption against your repository's public key before
GitHub stores it. InkDrafts keeps no copy. Revoking the InkDrafts connection
in Notion makes the stored token invalid. See
<a href="/leaving">Leaving InkDrafts</a> for the steps.</p>

<h2>Cookies</h2>
<p>InkDrafts sets three cookies in total. None of them tracks you across other
sites, and there are no advertising or analytics cookies.</p>
<ul>
<li>Two short-lived state cookies protect the Notion connection and the
dashboard sign-in against tampering and replay. They are cleared when the
authorization completes and expire within minutes regardless.</li>
<li>The dashboard session cookie described above, which lasts
${SESSION_HOURS} hours.</li>
</ul>

<h2>What InkDrafts never does</h2>
<ul>
<li>It never shows you advertising and never sells data.</li>
<li>It never reads your Notion page content. Your page content is read by the
sync workflow inside your own repository, not by InkDrafts.</li>
<li>It never posts to Notion or GitHub on your behalf after setup. Setup only
creates and configures your repository.</li>
<li>It never asks you for a password, token, or secret. No one from InkDrafts
will ever need one.</li>
</ul>

<h2>Removing your data</h2>
<p>Setup records delete themselves after ${JOB_RETENTION_HOURS} hours. To
disconnect InkDrafts from your accounts, or to delete your site entirely,
follow <a href="/leaving">Leaving InkDrafts</a>. Questions and data requests
go through ${SUPPORT}.</p>

<h2>Changes to this policy</h2>
<p>This policy describes what the service's public code actually does. If the
behavior changes, this page changes with it, and the full history of this page
is public in the repository. Material changes are announced on the
<a href="/">landing page</a>.</p>
`,
  },
  {
    path: '/terms',
    title: 'Terms of Service',
    heading: 'Terms of Service',
    body: `
<p class="updated">${UPDATED}</p>
<p>InkDrafts is a free service that sets up a Notion-powered website in your
own GitHub account. By connecting your accounts you agree to these terms. If
you do not agree, do not connect your accounts.</p>

<h2>What the service does</h2>
<p>InkDrafts creates a repository in your GitHub account from a public
template, writes encrypted secrets for your repository's own sync workflow,
enables GitHub Pages, runs the first sync, and reports progress to you. After
setup, all syncing is performed by the GitHub Action inside your repository.
InkDrafts is not part of that loop.</p>

<h2>Your accounts, your content, your site</h2>
<p>You keep full ownership of your GitHub repository, your Notion content, and
your published site. You are responsible for what you publish and for
following GitHub's and Notion's own terms and acceptable-use policies. InkDrafts
is not a party to your agreements with those providers.</p>

<h2>Availability</h2>
<p>The service is free, experimental, and provided as is, with no uptime
guarantee. We may change, suspend, or discontinue it at any time, and we may
pause or refuse provisioning at any time to protect users, the providers, or
the service, for example during an abuse or provider incident. Because your
site runs from your own repository, it keeps working without InkDrafts.</p>

<h2>Limitation of liability</h2>
<p>Nothing in these terms limits liability that cannot be limited under
applicable law. To the extent the law allows, neither party is liable to the
other for indirect or consequential damages.</p>

<h2>Stopping</h2>
<p>You can stop using InkDrafts at any time. See
<a href="/leaving">Leaving InkDrafts</a> for the steps and what happens to
your data. We can block use that violates these terms or the
<a href="/acceptable-use">Acceptable Use Policy</a>.</p>

<h2>Changes to these terms</h2>
<p>Changes are published on this page. The full history of this page is public
in the <a href="${REPO}">service's repository</a>.</p>

<p>Questions about these terms go through ${SUPPORT}.</p>
`,
  },
  {
    path: '/security',
    title: 'Security and Data Handling',
    heading: 'Security and Data Handling',
    body: `
<p class="updated">${UPDATED}</p>
<p>This page describes how InkDrafts handles credentials and data. It matches
the public implementation and its <a href="${REPO}/blob/main/docs/security-data-flow.md">documented
data-flow audit</a>.</p>

<h2>Where credentials live</h2>
<p>The InkDrafts server holds three provider credentials: the GitHub App
private key and the GitHub and Notion OAuth client secrets. They are stored as
server-side Cloudflare secrets. They never reach browser code, your repository,
or logs.</p>

<h2>Token lifecycle</h2>
<ul>
<li>Your GitHub authorization token lives for one request. It creates your
repository and is then discarded. It is never written to storage, queues, or
logs.</li>
<li>Your Notion token is written once, encrypted, into your own repository's
Actions secrets, and InkDrafts keeps no copy.</li>
<li>After setup, each provisioning step mints its own short-lived token and
discards it when the step ends.</li>
</ul>
<p>The enforcement is test-enforced. The repository's canary suite plants fake
credentials, drives the real provisioning journeys, and fails if any canary
reaches storage, queue messages, logs, or responses. See
<code>test/token-hygiene.test.ts</code> in the repository.</p>

<h2>Encryption</h2>
<p>All traffic runs over HTTPS. Actions secret values are sealed with a
libsodium sealed box against your repository's public key before they are sent
to GitHub. Only your repository can decrypt them.</p>

<h2>Least privilege</h2>
<p>The InkDrafts GitHub App requests exactly these permissions: Metadata
(read), Administration (write), Contents (write), Secrets (write), Actions
(write), and Pages (write). Administration covers Pages setup on your
repository. The App is installed on your account only, sees only the
repositories you grant, and can be uninstalled by you at any time.</p>

<h2>Retention</h2>
<p>Setup records and the Notion template validation record are deleted after
${JOB_RETENTION_HOURS} hours. Operational aggregates are kept for three
months. Structured logs are kept for at most seven days. Details are in the
<a href="/privacy">Privacy Policy</a>.</p>

<h2>What this page does not claim</h2>
<p>No security control is perfect. InkDrafts runs on GitHub, Notion, and
Cloudflare and depends on their guarantees, their availability, and their
incident response. InkDrafts holds no third-party security certification, and
no free service should be your only backup. Your repository is yours, so your
site's durability is GitHub's, not InkDrafts'.</p>

<h2>Reporting a security problem</h2>
<p>Please report suspected vulnerabilities privately through GitHub's
&ldquo;Report a vulnerability&rdquo; on the InkDrafts repositories, or through
${SUPPORT} if you cannot. Do not open a public issue with details.</p>
`,
  },
  {
    path: '/acceptable-use',
    title: 'Acceptable Use Policy',
    heading: 'Acceptable Use Policy',
    body: `
<p class="updated">${UPDATED}</p>
<p>InkDrafts publishes your Notion pages to your own GitHub Pages site. What
you publish is yours to choose, within the rules below and the terms you
already have with GitHub and Notion.</p>

<h2>Your content</h2>
<ul>
<li>Only publish content you have the rights to publish.</li>
<li>Do not use InkDrafts sites for unlawful, infringing, deceptive, harassing,
or malicious content, including phishing, malware, or spam.</li>
<li>Follow GitHub's Terms of Service and Acceptable Use Policies, and Notion's
terms, for anything you publish or sync. Those agreements govern your
accounts; InkDrafts relies on them.</li>
</ul>

<h2>Fair use of the service</h2>
<ul>
<li>Set up sites for accounts you control.</li>
<li>Do not automate setup at scale, circumvent rate limits, or interfere with
the service's operation or other users.</li>
<li>Do not use the service to attack, probe, or overload any system.</li>
</ul>

<h2>Enforcement</h2>
<p>InkDrafts enforces these rules with rate limits, temporary denials, and, in
an incident, a full provisioning pause. Content that breaks a provider's terms
is a matter between you and that provider, and the provider will act on your
account or repository directly.</p>

<p>Report a violation through ${SUPPORT}.</p>
`,
  },
  {
    path: '/support',
    title: 'Support',
    heading: 'Support',
    body: `
<p class="updated">${UPDATED}</p>
<p>InkDrafts is built and run in the open, and support goes through public
channels.</p>

<h2>Questions or problems with setup</h2>
<p><a href="${REPO}/issues">Open an issue on inkdrafts/notiongit</a>. Include
the <code>job_id</code> value from your setup page's address if you have it.
It is a random identifier with no personal information, and it is the one
thing that lets maintainers find what happened.</p>
<p>Never post a token, password, or secret in an issue. InkDrafts will never
ask you for one.</p>

<h2>Problems with your site after setup</h2>
<p>Your dashboard at <a href="/status">InkDrafts status</a> shows your site's
last sync and publish and can run a sync now. For everything else, your
repository's Actions tab shows every sync run with its logs.</p>
<p>If syncing or publishing is failing everywhere, check the providers
directly: <a href="https://www.githubstatus.com">GitHub status</a>,
<a href="https://status.notion.so">Notion status</a>, and
<a href="https://www.cloudflarestatus.com">Cloudflare status</a>.</p>

<h2>Security reports</h2>
<p>Use GitHub's &ldquo;Report a vulnerability&rdquo; on the InkDrafts
repositories, or open an issue asking for a private contact channel. Please do
not post exploit details publicly.</p>

<h2>Data requests</h2>
<p>The <a href="/privacy">Privacy Policy</a> lists everything InkDrafts keeps
and how long it lives. Most of it deletes itself. For anything else, open an
issue through ${SUPPORT}.</p>

<h2>What to expect</h2>
<p>InkDrafts is a free service. There is no response-time guarantee, but
public issues are the fastest way to reach the maintainers.</p>
`,
  },
  {
    path: '/leaving',
    title: 'Leaving InkDrafts',
    heading: 'Leaving InkDrafts',
    body: `
<p class="updated">${UPDATED}</p>
<p>You can disconnect InkDrafts at any time, and every step is reversible by
connecting again. In every case your repository and your published site stay
yours and keep working without InkDrafts.</p>

<h2>Stop syncing from Notion</h2>
<p>In Notion, open Settings, then Connections, and revoke the InkDrafts
connection. The scheduled sync in your repository's Actions tab then fails on
invalid credentials and stops. Your published site stays up with the content
it already has. You can also switch the sync off yourself in the repository's
Actions tab.</p>

<h2>End InkDrafts' access on GitHub</h2>
<p>On GitHub, open Settings, then Applications, then Installed GitHub Apps,
and uninstall InkDrafts. That ends all of the App's access to your account.
Your dashboard will show the access as gone.</p>

<h2>Remove the stored Notion token</h2>
<p>The encrypted copy of your Notion token lives in your repository's Actions
secrets. Revoking the Notion connection makes it useless. To remove it from
GitHub entirely, delete the <code>NOTION_TOKEN</code>,
<code>NOTION_PAGES_DATABASE_ID</code>, and <code>NOTION_POSTS_DATABASE_ID</code>
secrets in the repository's Settings, under Secrets and variables, then
Actions.</p>

<h2>Delete your site</h2>
<p>Delete the repository on GitHub. GitHub keeps a restore window, after which
the repository and the published site are gone. InkDrafts cannot restore them
for you.</p>

<h2>Revoke the dashboard sign-in</h2>
<p>If you signed in to the <a href="/status">dashboard</a>, you can revoke the
InkDrafts authorization on GitHub under Settings, then Applications, then
Authorized OAuth Apps. Any open dashboard session ends within
${SESSION_HOURS} hours.</p>

<h2>What remains on InkDrafts' side</h2>
<p>InkDrafts keeps no copy of any of your tokens, so there is nothing to
revoke there. Setup records delete themselves within
${JOB_RETENTION_HOURS} hours. The anonymous operational aggregates described
in the <a href="/privacy">Privacy Policy</a> age out within three months.</p>

<p>Questions about leaving go through ${SUPPORT}.</p>
`,
  },
];

function footerNav(current: string): string {
  return `<nav aria-label="Policies">${BODIES
    .filter((page) => page.path !== current)
    .map((page) => `<a href="${page.path}">${page.title}</a>`)
    .join('\n')}
<a href="/">InkDrafts home</a></nav>`;
}

function policyDocument(page: PolicyBody): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title} — InkDrafts</title>
<meta name="description" content="InkDrafts ${page.title.toLowerCase()}: what the service keeps, how it handles credentials, and how to reach support.">
<style>${STYLES}</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to content</a>
<header>
  <div class="nav-inner"><a class="wordmark" href="/">InkDrafts</a></div>
</header>
<main id="main-content">
<h1>${page.heading}</h1>
${page.body}
</main>
<footer>
${footerNav(page.path)}
</footer>
</body>
</html>`;
}

export const POLICY_PAGES: Readonly<Record<string, PolicyPage>> = Object.fromEntries(
  BODIES.map((page) => [page.path, { path: page.path, title: page.title, document: policyDocument(page) }]),
);

export const POLICY_PATHS: readonly string[] = BODIES.map((page) => page.path);
