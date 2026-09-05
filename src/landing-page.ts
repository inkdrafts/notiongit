/**
 * The public marketing/onboarding page at `GET /`.
 *
 * Server-rendered, no client JavaScript, and no external requests (fonts,
 * scripts, images): the whole response is one self-contained document, which
 * keeps the accessibility/no-JS and performance-budget requirements trivially
 * true rather than something to verify separately. The only interactive
 * element is a plain link into `/connect/github` — GitHub-first onboarding is
 * intentional: the Notion callback needs a repository to write the sync
 * workflow's secrets into (issue #46).
 *
 * Deliberately does not link the App install page directly: the GitHub App is
 * public but stays unadvertised from inkdrafts.com until the M5 launch issue
 * (`docs/github-app-runbook.md` "Registration status"), so the CTA goes
 * through `/connect/github`, which mints signed state first.
 */

const SITE_URL = 'https://inkdrafts.com/';

const DESCRIPTION =
  'InkDrafts publishes a Notion workspace to a Jekyll site hosted free on your own GitHub Pages — you keep the repository and the Action that syncs it.';

// A tiny inline favicon avoids an extra request for /favicon.ico without
// needing an asset pipeline this Worker doesn't have.
const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230969da'/%3E%3Ctext x='16' y='22' font-family='system-ui,sans-serif' font-size='15' font-weight='700' fill='%23ffffff' text-anchor='middle'%3EId%3C/text%3E%3C/svg%3E";

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
  header {
    border-bottom: 1px solid var(--border);
  }
  .nav-inner {
    max-width: 960px;
    margin: 0 auto;
    padding: 1rem 1.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .wordmark { font-weight: 700; font-size: 1.1rem; color: var(--fg); text-decoration: none; }
  nav[aria-label="Primary"] { display: flex; gap: 1.25rem; flex-wrap: wrap; }
  nav[aria-label="Primary"] a { text-decoration: none; font-size: 0.95rem; }
  nav[aria-label="Primary"] a:hover { text-decoration: underline; }
  section { padding: 3.5rem 1.5rem; }
  .wrap { max-width: 960px; margin: 0 auto; }
  .hero { text-align: center; }
  h1 {
    font-size: clamp(2rem, 4.5vw, 2.75rem);
    margin: 0 0 1rem;
    letter-spacing: -0.02em;
  }
  .lede {
    font-size: clamp(1.05rem, 2vw, 1.25rem);
    color: var(--muted);
    max-width: 42rem;
    margin: 0 auto 2rem;
  }
  .cta {
    display: inline-block;
    background: var(--accent);
    color: var(--accent-fg);
    font-weight: 600;
    font-size: 1.05rem;
    padding: 0.9rem 1.75rem;
    border-radius: 8px;
    text-decoration: none;
  }
  .cta:hover { text-decoration: none; filter: brightness(1.08); }
  .cta-note { margin-top: 0.9rem; color: var(--muted); font-size: 0.9rem; }
  h2 {
    font-size: clamp(1.4rem, 3vw, 1.75rem);
    margin: 0 0 1.75rem;
    text-align: center;
  }
  .grid-3 {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1.5rem;
  }
  @media (max-width: 720px) {
    .grid-3 { grid-template-columns: 1fr; }
  }
  .card {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.5rem;
    background: var(--surface);
  }
  .card h3 { margin: 0 0 0.5rem; font-size: 1.05rem; }
  .card p { margin: 0; color: var(--muted); }
  ol.steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1.5rem;
    counter-reset: step;
  }
  @media (max-width: 720px) {
    ol.steps { grid-template-columns: 1fr; }
  }
  ol.steps > li {
    counter-increment: step;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.5rem;
    position: relative;
  }
  ol.steps > li::before {
    content: counter(step);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-fg);
    font-weight: 700;
    font-size: 0.9rem;
    margin-bottom: 0.75rem;
  }
  ol.steps h3 { margin: 0 0 0.5rem; font-size: 1.05rem; }
  ol.steps p { margin: 0; color: var(--muted); }
  .panel {
    max-width: 720px;
    margin: 0 auto;
  }
  .panel ul { color: var(--muted); padding-left: 1.25rem; }
  .panel ul li { margin-bottom: 0.6rem; }
  .repo-list {
    list-style: none;
    margin: 1.25rem 0 0;
    padding: 0;
    display: grid;
    gap: 0.75rem;
  }
  .repo-list a {
    display: block;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.9rem 1.1rem;
    text-decoration: none;
    font-weight: 600;
  }
  .repo-list a:hover { border-color: var(--accent); }
  .repo-list span {
    display: block;
    font-weight: 400;
    color: var(--muted);
    font-size: 0.9rem;
    margin-top: 0.2rem;
  }
  footer {
    border-top: 1px solid var(--border);
    padding: 2rem 1.5rem;
  }
  footer .wrap {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem 1.5rem;
    align-items: center;
    justify-content: space-between;
    color: var(--muted);
    font-size: 0.9rem;
  }
  footer nav { display: flex; gap: 1.25rem; flex-wrap: wrap; }
  section#privacy-security, section#open-source { background: var(--surface); }
`;

export const LANDING_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>InkDrafts</title>
<meta name="description" content="${DESCRIPTION}">
<link rel="canonical" href="${SITE_URL}">
<link rel="icon" href="${FAVICON}">
<meta name="theme-color" content="#0969da">
<meta property="og:type" content="website">
<meta property="og:title" content="InkDrafts — Notion-powered publishing for GitHub Pages">
<meta property="og:description" content="${DESCRIPTION}">
<meta property="og:url" content="${SITE_URL}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="InkDrafts — Notion-powered publishing for GitHub Pages">
<meta name="twitter:description" content="${DESCRIPTION}">
<style>${STYLES}</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to content</a>
<header>
  <div class="nav-inner">
    <a class="wordmark" href="/">InkDrafts</a>
    <nav aria-label="Primary">
      <a href="#how-it-works">How it works</a>
      <a href="#privacy-security">Privacy &amp; security</a>
      <a href="#open-source">Open source</a>
    </nav>
  </div>
</header>

<main id="main-content">
  <section class="hero">
    <div class="wrap">
      <h1>Write in Notion. Publish a site you own.</h1>
      <p class="lede">
        InkDrafts turns a Notion workspace into a Jekyll site hosted free on
        your own GitHub Pages. The repository and the GitHub Action that keeps
        it in sync belong to your GitHub account from the moment they're
        created — your site keeps working even if InkDrafts disappears.
      </p>
      <a class="cta" href="/connect/github">Connect GitHub to get started</a>
      <p class="cta-note">Free GitHub Pages hosting. You'll connect Notion in the next step.</p>
      <p class="cta-note">Before you connect, read the <a href="/privacy">Privacy Policy</a> and <a href="/terms">Terms of Service</a>.</p>
    </div>
  </section>

  <section aria-labelledby="what-heading">
    <div class="wrap">
      <h2 id="what-heading">What InkDrafts creates, owns, and costs</h2>
      <div class="grid-3">
        <div class="card">
          <h3>Creates</h3>
          <p>
            A GitHub repository in your account, generated from the InkDrafts
            template and wired to sync from the Notion pages you write in.
          </p>
        </div>
        <div class="card">
          <h3>Owns</h3>
          <p>
            You do. The repository, its GitHub Action, and the published site
            are yours from the moment they're created — not InkDrafts'.
          </p>
        </div>
        <div class="card">
          <h3>Costs</h3>
          <p>
            Nothing to run. GitHub provides Pages hosting for free; InkDrafts
            only sets it up for you.
          </p>
        </div>
      </div>
    </div>
  </section>

  <section id="how-it-works" aria-labelledby="how-heading">
    <div class="wrap">
      <h2 id="how-heading">How it works</h2>
      <ol class="steps">
        <li>
          <h3>Connect GitHub</h3>
          <p>
            Install the InkDrafts GitHub App to create a repository in your
            account and enable free GitHub Pages hosting. The repository is
            yours from the moment it is created.
          </p>
        </li>
        <li>
          <h3>Connect Notion</h3>
          <p>
            Authorize InkDrafts to read the Notion template you duplicated, so
            it can find your Pages and Posts databases and store the encrypted
            secrets your repository's own sync Action needs. It only requests
            read access and never edits your Notion content.
          </p>
        </li>
        <li>
          <h3>Your site goes live</h3>
          <p>
            InkDrafts triggers the first sync and waits for GitHub Pages to
            publish it. After that, a scheduled Action inside your own
            repository keeps the site in sync — InkDrafts is no longer part
            of the loop.
          </p>
        </li>
      </ol>
    </div>
  </section>

  <section id="privacy-security" aria-labelledby="privacy-heading">
    <div class="wrap panel">
      <h2 id="privacy-heading">Privacy &amp; security</h2>
      <ul>
        <li>
          Notion and GitHub access tokens are used once, in memory, to
          complete each step, then discarded — never stored, logged, or
          included in error reports.
        </li>
        <li>
          The secrets your repository's Action does need are sealed with
          libsodium encryption before GitHub ever stores them.
        </li>
        <li>
          Every setup step is safe to retry: nothing is duplicated if a step
          is interrupted partway through.
        </li>
      </ul>
      <p>
        The full details are in the <a href="/privacy">Privacy Policy</a> and
        the <a href="/security">Security and Data Handling</a> page.
      </p>
    </div>
  </section>

  <section id="open-source" aria-labelledby="open-source-heading">
    <div class="wrap panel">
      <h2 id="open-source-heading">Built in the open</h2>
      <p>
        InkDrafts is three public repositories. Inspect exactly what runs in
        your account before you connect anything.
      </p>
      <ul class="repo-list">
        <li>
          <a href="https://github.com/inkdrafts/notiongit">notiongit
            <span>This onboarding service — connects Notion and GitHub and provisions your site.</span>
          </a>
        </li>
        <li>
          <a href="https://github.com/inkdrafts/notiongit-template">notiongit-template
            <span>The Jekyll site template your repository is generated from.</span>
          </a>
        </li>
        <li>
          <a href="https://github.com/inkdrafts/notiongit-sync">notiongit-sync
            <span>The sync engine your repository's own GitHub Action runs.</span>
          </a>
        </li>
      </ul>
    </div>
  </section>
</main>

<footer>
  <div class="wrap">
    <p>InkDrafts turns a Notion workspace into a GitHub Pages site you own.</p>
    <nav aria-label="Footer">
      <a href="#how-it-works">How it works</a>
      <a href="#privacy-security">Privacy &amp; security</a>
      <a href="#open-source">Open source</a>
      <a href="/privacy">Privacy Policy</a>
      <a href="/terms">Terms of Service</a>
      <a href="/security">Security</a>
      <a href="/acceptable-use">Acceptable use</a>
      <a href="/support">Support</a>
      <a href="/leaving">Leaving InkDrafts</a>
    </nav>
  </div>
</footer>
</body>
</html>`;
