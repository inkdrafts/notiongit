# Site setup (full user flow)

The product's entire promise in one journey: a new user opens the site,
connects GitHub, installs the InkDrafts App, connects Notion, and InkDrafts
reuses or generates their repository, syncs it, and publishes a live GitHub
Pages site — then keeps it fresh on "Sync now" and on a schedule. This is
the operational version of the launch-gate rehearsal in
`docs/rehearsal-script.md` (run A) and the only feature whose provider legs
are real: it runs against the staging deployment
(`https://notiongit-staging.notiongit.workers.dev`) or, with the owner's
authorization, production (`https://inkdrafts.com`) — never against a local
instance, which has no provider credentials or public callbacks.

The whole journey is drivable autonomously with `--user-session`: the driver
copies the operator's signed-in Chrome profile and performs every provider
consent itself. It was proven end to end on production on 2026-09-06 —
10/10 steps green, fresh job through live site, twice in a row.

## Sub-features

- `setup-apex` takes a fresh account with no repositories to a live site at
  `https://USER.github.io` in the repository `USER.github.io`.
- `setup-project` (run B) takes an account whose apex name is occupied to
  `https://USER.github.io/USER-inkdrafts` in the repository `USER-inkdrafts`,
  with styles, links, and images resolving under the subpath (proven live:
  the github.io URL serves the site and a custom domain pointed at the repo
  answers 200 too).
- `setup-deny-recovery` rehearses denying the Notion consent: the error screen
  explains what happened and reconnecting GitHub is quick because the grant
  is remembered.
- `setup-double-starter` — restarting while a job is active does not fail and
  does not fork work: the GitHub callback answers the second OAuth with a
  `303` straight to the **active job's** `/progress` page, and the driver
  adopts that job id and continues its Notion leg.
- `publish-edit` publishes a Notion edit through the dashboard's "Sync now".
- `publish-schedule` publishes a Notion edit on the scheduled
  `sync-notion.yml` run (may take hours; trigger by hand after 30 minutes and
  record that it was late).
- `disconnect-guidance` revokes Notion and uninstalls the App and confirms the
  failures and the surviving site (run last; it ends the account's sync).

## How to get to it (user POV)

- Open the deployment root and choose "Connect GitHub to get started".
- Approve the GitHub authorization and install the App when GitHub asks.
  The GitHub leg finishes fast: the callback creates (or reuses) the
  repository **inline**, and the browser lands directly on Notion's
  authorization page, or on `/progress?job_id=...` when Notion is already
  connected.
- Advance Notion's consent wizard: workspace is preselected — **Next**, then
  the page-permissions screen — **Allow access** (a "Duplicate template"
  button appears only when the integration offers one).
- Watch the wizard on `/progress?job_id=...` run itself to "Publish your
  site: Done"; open the live site from the success panel.

## Driving it with the flow driver

Preconditions:

- The deployment doctor passes (`/healthz` answers exactly, landing and
  `/status` render — `helpers/flow.ts` checks before every run).
- One GitHub personal account and one Notion workspace, created by a human
  (GitHub's terms forbid bot-created accounts), each owned and signed-in-able
  by someone present. Fresh accounts with no prior InkDrafts state define the
  real non-developer experience; record who owns each account.
- No password, token, OAuth code, or workspace content ever reaches the
  driver, the terminal, or the evidence. Credentials stay with their owner.
- The OAuth **client id** for the direct-authorize leg: resolve it from the
  deployment's own redirect —
  `curl -sI "https://BASE/status?connect=1"` and read `client_id` from the
  `Location` — then pass `--client-id <id>` (the fallback, scraping the org
  app-settings page, needs an inkdrafts org-owner browser session).

- **Automated prefix (no account needed).** Run
  `bun run .zcode/skills/verify-notiongit/helpers/flow.ts "$BASE" "$ART_DIR" --probe`.
  Expect PASS for `doctor`, `landing`, and `connect-github` (the browser is
  navigated to `github.com/apps/inkdrafts/installations/new`), each with a
  screenshot.
- **Autonomous full flow (proven 2026-09-06).** Run

  ```sh
  bun run .zcode/skills/verify-notiongit/helpers/flow.ts "$BASE" "$ART_DIR" \
    --user-session --reauthorize --client-id <CLIENT_ID>
  ```

  Headless; it copies the operator's signed-in Chrome profile (gitignored
  scratch), mints a fresh signed state, drives the direct
  `login/oauth/authorize` URL (GitHub answers immediately while the grant is
  active), performs the App install consent (personal account, **All
  repositories**), reads where the callback settled, drives Notion's consent
  wizard (Next → Allow access; clicks "Duplicate template" only if offered
  within 3s), and polls provisioning. Ten steps must PASS: `client-id`,
  `mint-state`, `direct-authorize`, `github-callback`, `connect-notion`,
  `notion-consent`, `notion-callback`, `provisioning`, `site-live`,
  `repository`, with a `flow summary: 10 passed, 0 failed` and exit 0.
- **Guided mode (no `--user-session`).** A headed Chrome with the persistent
  `helpers/.flow-profile` opens; the driver clicks the CTA itself and the
  human performs the GitHub install and the Notion wizard, pressing Enter at
  each checkpoint. Use this to rehearse the consent experience itself.
- **Where the GitHub callback settles** — all three are success:
  `/connect/notion?job_id=...` (fresh start; it 302-chains to Notion in the
  same navigation), Notion's authorization page directly (the settled URL of
  that chain), or `/progress?job_id=...` of the account's **active** job
  (the `account_busy` funnel). Failure is an HTML error page rendered **at**
  `/auth/github/callback` with a distinct error code — the driver treats any
  settled `/auth/*` URL as failure and saves `callback-error.txt`.
- **Provisioning is watched, not touched.** The driver polls
  `/progress/status?job_id=...` every 10s into `progress-poll.log` through
  `awaiting_notion` (secrets being written) and `active` (queue running) to
  `succeeded` (15-minute cap; a 5-minute stall fails the run with the log to
  inspect). `site-live` then requires the product's own probe:
  `/progress/site-check?job_id=...` must answer `{"reachable":true}` within
  10 minutes; the success page's site link is captured best-effort.
- **Publish an edit.** In Notion, change the home page text and set one Posts
  entry to Published. Open the dashboard from the success screen (sign in
  with GitHub when asked), choose "Sync now", wait for the run, reload the
  site: both edits must appear. Screenshot before and after.
- **Scheduled sync.** Make one more edit, do not press "Sync now", and watch
  the repository's Actions tab; trigger the workflow by hand if nothing has
  started in 30 minutes, and record that the scheduled run was late.
- **Recoverable failure.** Deny the Notion consent on a fresh run: the error
  screen must explain what happened and offer the way back; reconnecting
  GitHub should be quick because the grant is remembered.
- **Resume an interrupted run** with `--job-id <id from job.json>`; the run
  report's last line prints the exact resume command.
- **Proof.** Every step leaves a numbered screenshot, `run.log` has a UTC
  timestamp per step, `progress-poll.log` has every projection read, and
  `repository.json` names what was created. `job.json` (job id + base) is
  written as soon as the job id is known. `console.log` and
  `network-errors.log` capture every page console error and every HTTP ≥400
  response with a truncated body. Error screens get their own screenshots:
  what they said and what the tester did next.

## Gotchas

- **Account creation is a human act.** Never automate GitHub or Notion
  signup; never let the driver hold credentials. The browser profiles
  (`helpers/.flow-profile`, the `--user-session` scratch copy) hold real
  session cookies — gitignored, never committed or copied.
- **Environment choice is deliberate.** Staging for repeatable verification;
  production with the owner's explicit authorization (a production deploy
  itself is also owner-gated). The same GitHub App and Notion connection
  serve both; their callback/redirect URL lists carry both hostnames.
- **The signed `state` now lives one hour** (both the GitHub install state
  and the Notion state; `exp` is `now+3600`, verified live 2026-09-06). Long
  pauses no longer kill a leg — but a state is single-use: replaying a
  consumed code/state still fails, so recapture rather than replay.
- **Notion's consent UI hydrates late.** Right after navigation it can be
  blank skeletons with zero buttons; wait for the controls to become visible
  (the driver waits up to 20s) instead of counting them once, or the run
  reports "no advance button" on a page that was about to render.
- **`duplicated_template_id` rides Notion's token response**, and the
  continuation refuses to proceed without it
  (`notion_template_not_duplicated`). It appears when the InkDrafts Notion
  integration has a template attached on the Notion side; if the callback
  fails with that code after a clean consent, the integration's portal-side
  template setting is the suspect, not the driver.
- **Restarting mid-flow is safe and funneled.** A second start for an
  account holding an active job 303s to that job's progress page (adopt it
  and continue the Notion leg). Only when no lease is held does a new start
  reuse the previously generated repository (`generateOrReuseRepository`) —
  the repository is never duplicated either way.
- **Deleting anything needs the owner's permission** — the test repository,
  the duplicated workspace content, the Notion connection, the App install.
  Cleanup is part of the run's teardown, not an afterthought.
- **Redaction before anything leaves the machine.** The `artifacts/` directory
  is gitignored wholesale; a committed report uses the
  `docs/rehearsal-report-template.md` shape with logins replaced by `USER`
  and workspace names and page content left out. (Driver evidence may show
  the real avatar/workspace name in Notion screenshots — keep it out of
  committed documents.)
- **Scheduled syncs are genuinely slow.** GitHub delays scheduled workflow
  runs under load; measured delivery was 3.5–4.6 hours apart on 2026-09-05.
  Budget for it or trigger the workflow by hand and record that.
- **Errors in the authenticated legs are diagnosed, not guessed.** Capture
  the exact error screen and URL first: every coded failure renders an HTML
  error page **at the callback URL** with a distinct error code and its own
  recovery path (`docs/github-app-runbook.md`).
- **`github_authorization_unavailable` / `github_actions_public_key_*` mean
  "a GitHub API call failed", and the classic root cause on workerd is a
  missing `User-Agent`** — workerd's `fetch` sends none and GitHub answers a
  bare 403. This bit the onboarding leg (fixed by PR #96) and then the
  provisioning leg's five modules (fixed by PR #97: `actions-secrets`,
  `github-pages`, `notion-sync`, `repository-config`, `site-deployment`);
  both were proven live on production on 2026-09-06. If it recurs on a new
  GitHub-calling code path, check for a `fetch` to `api.github.com` without
  a `User-Agent` header first. A second diagnostic: an empty `wrangler tail`
  during a failure means a **coded** error path rendered the page; a logged
  `[notiongit] ...` line means an uncoded throw.
- **The install dead end.** Once the App is installed, GitHub's
  `installations/new` never re-prompts OAuth — it leads to the
  installation's Configure page. Recover a half-finished flow with the
  driver's `--reauthorize` mode: it mints a fresh signed state from
  `/connect/github` and drives the direct `login/oauth/authorize` URL
  (pass the client id with `--client-id`; a revocation may be needed first:
  Settings → Applications → Authorized GitHub Apps).
- **DNS isolation inside the driven browser is fragile.** Chrome's
  `--host-resolver-rules=MAP <host> ~NOTFOUND` can break name resolution for
  *unrelated* hosts in the same browser (observed: mapping inkdrafts.com
  also blackholed github.com). `helpers/e2e.ts` (local) relies on the
  github.com-only map and it holds; capture scripts that must reach both
  the deployment and GitHub use `context.request.get(url,
  {maxRedirects: 0})` against the authorize URL to take a code off the
  `Location` header instead of any DNS trickery.
