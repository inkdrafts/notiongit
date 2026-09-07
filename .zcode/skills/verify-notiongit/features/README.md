# notiongit (InkDrafts) verification map

This directory is the maintained source for verifying the user-facing behavior
of InkDrafts, the Notion + Git deployment service this repository powers. Read
this index before driving the app, then use the matching feature file as the
recipe.

## Baseline preconditions

- For the four rendered-surface features, launch the local verification
  instance per `../SKILL.md` (the helpers config, never `bun run dev`),
  default port `8799`, **with `--local-protocol https`** (the worker 301s
  plaintext http ahead of every route), and pass its doctor. Every local
  `$BASE` below is `https://127.0.0.1:$PORT` and curl runs with `-k`.
- [Site setup](./site-setup.md) is the exception: it runs against the real
  staging deployment (or production with the owner's authorization) with
  real provider consents, driven autonomously with `--user-session`. Its
  preconditions live in its own file.
- Every value below is grounded in the live service: routes and JSON field
  names come from `src/index.ts`, page titles from the rendered documents.
- The local instance holds **no jobs**: local KV is in-memory and starts
  empty.
- Local provider credentials are placeholders. Anything that completes
  against real GitHub or Notion locally is staging-scoped; drive the local
  leg, record the rest as a skip — or run `site-setup.md`, where the provider
  legs are real by design.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say
  otherwise; a fresh instance knows no jobs.
- Use `curl` with `-fsS` for happy paths and `-D` + `-o` whenever the status
  code, headers, or body are the thing under test.
- Browser user paths (loading pages, clicking links, watching navigations)
  go through `helpers/e2e.ts`, one invocation per run; its per-feature
  screenshots and PASS/FAIL lines are evidence.
- Assert on route paths, query names, JSON fields, `<title>`/`<h1>` text, and
  anchor targets — never on markup order or byte offsets.
- The provisioning admission burst limiter allows 10 `connect/github` requests
  per 60s window. A drive run that hammers the entry can trip it; an
  admission denial page mid-run is the limiter working, not a regression.
- Treat every command as literal. Keep quoted names and flags unchanged.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final body:
  command transcript, response headers, and response body per drive.
- Verify side effects through the app's own read models (e.g. the
  `/progress/status` JSON projection), not internal storage.
- Record provider-completing paths in `skips.md` with the attempted request
  and the unmet precondition. Do not report a skipped entry point as verified
  through a different path.
- Name artifacts with the feature ID and keep them under the run's artifacts
  directory; they survive cleanup.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the
user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with curl and the Playwright driver` starts with
   `Preconditions:` and uses labeled bullets that pair each user action with
   an exact command and an observable result. Bullets named **Browser
   drive** run `helpers/e2e.ts` (see `../SKILL.md`), which clicks through
   the real pages in Chrome with github.com DNS-isolated inside the browser.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable
handles, required state, commands, and observable proof.

## Features

- [Landing page](./landing-page.md) covers the self-contained marketing
  document, its single no-JS CTA, and its absence of external requests.
- [Policy pages](./policy-pages.md) covers the six static policy documents and
  their titles.
- [Onboarding entry](./onboarding-entry.md) covers `connect/github`: job id
  handling, the signed install redirect, and its admission and validation
  contracts.
- [Progress surface](./progress.md) covers the self-updating progress page
  and its JSON status and site-check endpoints, including the gone-job
  contracts and the full status lifecycle.
- [Status surface](./status-surface.md) covers the public "Check your site"
  page, its connect entry, and the rerun endpoint's unauthenticated contract.
- [Site setup](./site-setup.md) covers the full user journey end to end on a
  real deployment — GitHub install, repository generation or reuse, the
  Notion consent wizard, first sync and publish, edits via "Sync now" and on
  schedule, and the disconnect guidance — driven autonomously with the
  operator's browser session (`--user-session`, proven on production
  2026-09-06) or guided by a human.
