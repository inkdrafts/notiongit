---
name: verify-notiongit
description: Drive the real notiongit (InkDrafts) Worker over HTTP to verify user-facing behavior — landing page, policy pages, the GitHub-first onboarding entry, the progress surface, and the public status surface, plus the full GitHub+Notion user journey end to end on a real deployment. Use whenever a change touches what a user sees or gets back from this service and a unit test is not proof enough. Local verification covers every route that renders or reads local state; the full provider journey (real GitHub/Notion OAuth, queue-driven provisioning, live site) runs autonomously against staging or production with the operator's browser session.
---

# Verify notiongit (InkDrafts)

InkDrafts is a Cloudflare Worker: a server-rendered web service with no client
JavaScript. Every user-facing surface is a plain HTTP request away, so the
harness is `curl`: the real user path IS the HTTP path. A real browser adds
only layout coverage, which the repo's own reflow script provides.

Read `features/README.md` first, then the matching feature file. This skill
runs a **local verification instance** it starts itself; it never drives the
staging or production Workers and never deploys anything.

## Launch

Run from the repository root. Prerequisite: `bun install --frozen-lockfile`
(node_modules present).

**Do not use `bun run dev`.** The repo's own dev script crashes at startup:
`src/index.ts` re-exports test-facing barrel names (e.g. the string constant
`ACCOUNT_LEASE_PREFIX`), and workerd requires every main-module export to be a
handler. `wrangler deploy --dry-run` does not catch this. The verification
config below works around it with a thin entry module; it never modifies the
repository.

```sh
RUN_ID="$(date +%Y%m%d-%H%M%S)"
ART_DIR=".zcode/skills/verify-notiongit/artifacts/$RUN_ID"
mkdir -p "$ART_DIR"
PORT="${VERIFY_PORT:-8799}"
spikes/libsodium-workers/node_modules/.bin/wrangler dev \
  --config .zcode/skills/verify-notiongit/helpers/wrangler-verify.toml \
  --port "$PORT" --local-protocol https 2>&1 | tee "$ART_DIR/wrangler-dev.log"
```

`--local-protocol https` is mandatory, not stylistic: the Worker 301s every
plaintext `http:` request to `https:` ahead of all routing (the custom
domain's Always-HTTPS rule is owned in code), so over plain http even
`/healthz` answers 301 and every rendered route is unreachable. The local
certificate is self-signed — use `curl -k` and a `BASE` of
`https://127.0.0.1:$PORT`; the Playwright driver already passes
`ignoreHTTPSErrors`.

- Record the wrangler process ID for teardown (from the background task or
  `$!`). Keep the log tee'd into the artifacts dir.
- **Ready signal:** the log line `Ready on https://localhost:$PORT`. The
  first bundle takes ~30s; poll until it answers rather than assuming a
  timeout means the server is dead:

  ```sh
  curl -sk "https://127.0.0.1:$PORT/healthz"   # expect {"ok":true,"service":"notiongit"}
  ```

- State is in-process and ephemeral: local KV and queues are simulated in
  memory and die with the process. A job created in one run is invisible in
  the next. Two verification instances on different `VERIFY_PORT`s are fully
  isolated from each other.
- The config inlines placeholder OAuth credentials. Never put real
  credentials in the verify config, and never `wrangler deploy` it — the
  repo's `wrangler.toml` is the only deployable configuration. One trap:
  wrangler loads a `.dev.vars` **from the launched config's directory**, and
  the OAuth replay rig keeps real credentials in
  `helpers/replay/.dev.vars` — that directory boundary is what keeps them
  out of plain verification runs. If a connect redirect ever shows a real
  client id or slug instead of `local-placeholder`, a `.dev.vars` is being
  loaded from the wrong place; stop and fix the layout.

## Doctor

Run first, whenever anything looks off. It answers "is this instance worth
driving?":

1. **It answers and is ours.**
   `curl -sk -m 5 "https://127.0.0.1:$PORT/healthz"` must return exactly
   `{"ok":true,"service":"notiongit"}` — **and** the port must be owned by the
   wrangler process this run started. If `/healthz` answers but your launch
   didn't, stop: you are looking at someone else's instance (the user's own
   dev server answers identically). Do not drive it. A `301` here means the
   instance is up but was launched without `--local-protocol https` —
   relaunch it.
2. **Right build.** The Worker exposes no version route; identity is
   `GET /` returning 200 with `<title>InkDrafts</title>` and
   `Content-Type: text/html`.
3. **Log is clean of startup errors.** `wrangler-dev.log` ends with
   `Ready on ...` and contains no `ERROR` lines.

## Drive

Three layers, ordered by what they prove. JSON and header contracts belong to
curl; real-browser user paths belong to Playwright; layout and keyboard
behavior belong to the repo's reflow script.

**Plain HTTP with `curl`.** Stable handles, in order of preference: exact
route paths and query names (`job_id`), JSON field names, document
`<title>`/`<h1>` text, anchor targets (`href="/connect/github"`,
`href="/status?connect=1"`), cookie names (`__Host-status-session`,
`__Host-status-state`). Never assert on byte offsets or regexes across the
whole document.

**Playwright end to end (`helpers/e2e.ts`).** Drives the instance in real
Chrome the way a user would: load the landing page and click its CTA, follow
the status surface's connect entry, read what renders. Provider isolation is
at the browser level — github.com cannot resolve inside the driven Chrome
(`--host-resolver-rules=MAP github.com ~NOTFOUND`), so a path that leaves for
GitHub performs
the real navigation, the harness observes the exact requested URL, and the
request stops at DNS. (Playwright route interception is not an option here:
a server-issued 302 chain bypasses routing entirely, which was proven live
during generation. Beware the inverse trap: mapping *additional* hosts can
blackhole DNS for unrelated hosts too — observed when mapping inkdrafts.com
also killed github.com resolution — so keep the map to github.com only, and
use `context.request.get(url, {maxRedirects: 0})` against an authorize URL
to capture a code off its `Location` header when a script must reach both
the deployment and GitHub.) One invocation covers the browser layer of every
mapped feature and exits non-zero on any failure:

```sh
bun run .zcode/skills/verify-notiongit/helpers/e2e.ts "https://127.0.0.1:$PORT" "$ART_DIR/e2e"
```

Screenshots land per feature under the given directory. The script doctor
checks `/healthz` itself before driving and refuses otherwise.

**Real-browser layout (`scripts/reflow-check.ts`).** For reflow, 200% zoom,
and keyboard-focus coverage: `bun run scripts/reflow-check.ts` (add
`--shots "$ART_DIR/shots"` for 320px screenshots). It serves the rendered
documents itself and drives `google-chrome-stable` headless over CDP; it
does not need the dev instance.

The signed `state` values the service mints ride in the redirect URL's
`state` query parameter as compact tokens: parse the Location with
`new URL(...)`, take `searchParams.get("state")`, split on `.`, and
base64url-decode the **first** segment to observe the payload
(`{"v":1,"jobId":...,"nonce":...,"exp":...}`). The trailing segment is an
HMAC signature — observe it, never modify or replay it. bun is the
padding-safe decoder (see the feature recipes).

## Evidence

Write proof to `$ART_DIR` (the run's artifacts dir created at launch). Proof
standards:

- Capture the **request and the response**: for every drive save the exact
  command in `commands.txt`, headers with `curl -D <file>`, and the body with
  `-o <file>`. A final screenshot/JSON alone is not proof.
- **Exercise the real user path**: the public route a browser would hit. Do
  not fabricate state by writing KV directly (local KV is in-memory anyway)
  and do not treat unit-test seams as proof.
- **Verify side effects through the app's own read models**: e.g. an
  onboarding entry drive's downstream observable is the
  `/progress/status?job_id=...` projection, not an internal row you never saw.
- **Provider-completing legs are skips, not passes — locally.** Routes that
  need real GitHub/Notion (both OAuth callbacks, the authenticated status
  session, queue-driven provisioning steps) cannot complete on the local
  instance. Record the attempted request and the unmet precondition in
  `skips.md`; never report a skipped path as verified through a different
  path. (The full journey itself is a real-deployment feature — see
  [Site setup](features/site-setup.md).)
- Name each artifact with the feature ID (e.g.
  `onboarding-entry/connect-302.txt`).

## Cleanup

- Kill **the wrangler process you started** by its recorded PID:
  `kill "$WRANGLER_PID"`, then wait until `$PORT` stops answering. Never kill
  by process name — `pkill wrangler` would take down the user's unrelated
  sessions. If a pattern kill is unavoidable, bracket the distinctive character
  (`pkill -f "wrangler-verify[.]toml"`) **and** keep the config path out of
  the same command: `pkill -f` matches the invoking shell's own command line,
  which otherwise contains the very pattern and path being killed.
- After a failed iteration, still run the cleanup: a broken attempt must not
  strand processes or hold the port.
- Cleanup removes the instance and its scratch state, never the evidence:
  `$ART_DIR` survives the teardown. Confirm your proof artifacts exist after
  the instance is gone.

## Helpers

Shipped in `helpers/`, both required for launch:

- `helpers/wrangler-verify.toml` — local-only Worker configuration
  (`name = "notiongit-verify"`). Identical behavior to `wrangler.toml` with
  two deliberate differences: `main` points at the thin entry below, and
  OAuth secrets are inline placeholders. Paths inside resolve relative to the
  file's own directory.
- `helpers/verify-entry.ts` — re-exports only the default handler from
  `src/index.ts` so workerd can start despite the barrel re-exports. No other
  behavioral change.
- `helpers/e2e.ts` — the Playwright end-to-end driver described under Drive.
  Its dependency lives in `helpers/package.json`; install once with
  `cd .zcode/skills/verify-notiongit/helpers && bun install`, then run the
  script with bun from the repository root. It launches the system Google
  Chrome via `channel: 'chrome'` (playwright-core ships no browsers), so no
  `playwright install` download is needed. Contexts set
  `ignoreHTTPSErrors` for the self-signed local instance.

**OAuth replay rig (`helpers/replay/`, diagnostic only).** When a provider
leg fails on a real deployment and the cause must be isolated locally,
`helpers/replay/` boots the real worker with real credentials:
`wrangler-replay.toml` (name `notiongit-replay`), `replay-entry.ts` (which
re-exports only the default handler and rewrites every request origin to
`https://inkdrafts.com` so minted redirect URIs match GitHub's callback
registration), and `.dev.vars` holding the operator-supplied credentials
(gitignored; they stay with the account owners and must never be committed,
deployed, or echoed). Its `.dev.vars` is safe only because wrangler loads a
`.dev.vars` from the launched config's own directory — keep the rig inside
`helpers/replay/`. Support scripts: `helpers/capture-code.ts` (mint a
product state and capture an unconsumed GitHub OAuth code off the authorize
redirect) and `helpers/capture-local.ts` (the same for an arbitrary signed
state and redirect URI; it clicks the consent button once if GitHub
re-prompts). OAuth codes are single-use: recapture per experiment, never
replay.

`features/` is the maintained verification map; update it when routes,
contracts, or copy change.

## Full-flow E2E (staging or production)

The local instance cannot complete the provider legs (no real credentials,
no public callbacks). `features/site-setup.md` defines the full user journey
— GitHub install, repository generation/reuse, the Notion consent wizard,
first sync and publish — run against the **staging deployment**
(`https://notiongit-staging.notiongit.workers.dev`) or production
(`https://inkdrafts.com`, with the owner's explicit authorization):

```sh
bun run .zcode/skills/verify-notiongit/helpers/flow.ts "$BASE" "$ART_DIR"
```

Modes (combinable):

- default — headed, persistent profile (`helpers/.flow-profile`, gitignored,
  real session cookies); humans perform every provider consent and press
  Enter at each checkpoint.
- `--probe` — the automated prefix only (landing + install-page navigation;
  no account needed).
- `--user-session` — fully autonomous: copies the operator's signed-in
  Chrome profile into a gitignored scratch dir and performs every consent
  itself (GitHub install chooser, Notion wizard Next → Allow access). Proven
  end to end on production on 2026-09-06: 10/10 steps, fresh job to live
  site, twice consecutively. Accounts themselves are still created by
  humans only.
- `--reauthorize` — recovers a flow whose GitHub App is already installed
  (GitHub's `installations/new` is a dead end then): mints a fresh signed
  state and drives the direct `login/oauth/authorize` URL. GitHub answers
  immediately while the grant is active; otherwise the driver clicks
  Authorize.
- `--client-id <id>` — supplies the OAuth client id for `--reauthorize`
  (fallback: scrape the org app-settings page, which needs an org-owner
  session). Resolve it from the deployment without any dashboard:
  `curl -sI "https://BASE/status?connect=1"` — read `client_id` from the
  `Location`.
- `--job-id <id>` — resume an interrupted run's job for the polling steps;
  the run report's last line prints the exact command.

Run it against production only with the owner's authorization, recorded in
the committed report per `docs/rehearsal-script.md`.
