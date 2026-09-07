# Onboarding entry

`GET /connect/github` is how a user starts: the service mints (or accepts) a
job id, records a short-lived signed state, and redirects the browser to the
GitHub App installation page. Locally the redirect can be observed but not
followed — completing it requires the real GitHub App — so this feature
proves the entry contract up to the provider boundary.

## Sub-features

- `onboard-entry-redirect` answers a bare `connect/github` with `302` to the
  GitHub App installation URL carrying a signed `state`.
- `onboard-entry-mints-job` generates a fresh job id when none is given and
  puts it inside the signed state.
- `onboard-entry-keeps-job` reuses an explicitly provided `job_id`.
- `onboard-entry-state-shape` signs a state whose payload decodes to
  `{"v":1,"jobId":...,"nonce":<uuid>,"exp":<now+3600>}`.
- `onboard-entry-rejects-id` refuses a `job_id` outside
  `[A-Za-z0-9_-]{1,128}` with HTTP 400.
- `onboard-entry-notion-leg` (the second half's local contract) answers
  `connect/notion` for an unknown job with the `409` failure page.

## How to get to it (user POV)

- Choose the connect call to action on the landing page (lands on
  `/connect/github`).
- Open `/connect/github` directly with or without a `job_id`.
- Return to `/connect/notion?job_id=...` for the Notion half after the GitHub
  leg.

## Driving it with curl and the Playwright driver

Preconditions:

- The verification instance passes the doctor (`../SKILL.md`).
- `$BASE` is `https://127.0.0.1:$PORT` (launched with `--local-protocol
  https`; plain http answers `301` ahead of every route — see
  [Landing page](./landing-page.md)).
- Fewer than ~8 `connect/github` requests have been made in this minute
  (burst limiter: 10 per 60s).

- **Bare entry redirects.** Run
  `curl -sk -o /dev/null -D "$ART_DIR/onboarding-entry/bare-headers.txt" -w "%{http_code}\n" "$BASE/connect/github"`.
  Expect HTTP `302` and a `Location` beginning
  `https://github.com/apps/local-placeholder/installations/new?state=`.
  Save the full redirect URL for the next step: run
  `grep "^Location:" "$ART_DIR/onboarding-entry/bare-headers.txt" | tr -d '\r' | sed 's/^Location: //' > "$ART_DIR/onboarding-entry/bare-state-url.txt"`.
- **Decode the minted job.** The state query parameter is
  `<payload-base64url>.<hmac>`; extract it from the saved URL and decode the
  first segment with bun (padding-safe). Run
  `bun -e 'const u=new URL(require("fs").readFileSync(process.argv[1],"utf8").trim());console.log(JSON.parse(Buffer.from(u.searchParams.get("state").split(".")[0],"base64url").toString()))' "$ART_DIR/onboarding-entry/bare-state-url.txt" > "$ART_DIR/onboarding-entry/bare-state-payload.json"`.
  Expect JSON with `"v":1`, a fresh `"jobId"` UUID, a `"nonce"` UUID, and
  `"exp"` about 3600 seconds ahead of now (the install state lives one hour;
  verified live 2026-09-06).
- **Provided id is kept.** Run
  `MINE="verify-job-$(date +%s)"; curl -sk -o /dev/null -D "$ART_DIR/onboarding-entry/passthrough-headers.txt" -w "%{http_code}\n" "$BASE/connect/github?job_id=$MINE"`,
  save the redirect URL the same way into
  `passthrough-state-url.txt`, and decode it with the same bun one-liner.
  Expect HTTP `302` and `"jobId"` in the payload to equal `$MINE` (the id
  pattern allows `[A-Za-z0-9_-]{1,128}`, not only UUIDs).
- **Invalid id is refused.** Run
  `curl -sk -o /dev/null -w "%{http_code}\n" "$BASE/connect/github?job_id=bad/id"`.
  Expect `400` (the slash breaks the id pattern).
- **Notion leg for an unknown job.** Run
  `curl -sk -o "$ART_DIR/onboarding-entry/notion-409.html" -w "%{http_code}\n" "$BASE/connect/notion?job_id=00000000-0000-4000-8000-000000000000"`.
  Expect `409` and an HTML failure page.
- **Browser drive.** The driver's `landing-cta-navigates` check clicks the
  landing page's CTA in real Chrome and observes the browser's navigation
  request to the GitHub install URL — the user's actual click path, stopped
  at DNS so nothing leaves the machine, with
  `e2e/onboarding-entry/cta-navigation.png` as evidence. The state payload
  contract itself stays with the curl bullets above.
- **Proof.** Save the `Location` headers (they contain the signed states),
  the decoded payloads, and the status codes under
  `onboarding-entry/`. The redirect plus its decoded state is the action;
  the 409 page is the resulting state of the second leg's gate.

## Gotchas

- `local-placeholder` in the install URL is the placeholder app slug from the
  verification config, not a regression. Assert the URL shape
  (`https://github.com/apps/<slug>/installations/new?state=...`), not the
  slug's value. (A gitignored `helpers/replay/.dev.vars` with real
  credentials belongs only to the replay rig in its own directory; the plain
  verification instance must never load it — if a real slug or client id
  shows up here, a `.dev.vars` is being loaded from the wrong directory.)
- **Do not follow the redirect** (no `curl -L`): it points at real GitHub.
  The local proof ends at the Location header.
- The burst limiter can answer an admission denial page if the run drives
  `connect/github` more than 10 times in 60 seconds. Space the drives or
  re-launch the instance.
- A bare `connect/github` records a nonce-keyed state entry, **not** a
  ProvisioningJob: `/progress/status?job_id=<minted>` still reads `missing`
  until the real GitHub callback completes (staging-scoped). Do not treat
  `missing` here as a failure of this feature.
- `state` is HMAC-signed. Decode it; never alter and replay it — the
  callback leg rejects tampered states and a replay can burn the burst
  budget.
