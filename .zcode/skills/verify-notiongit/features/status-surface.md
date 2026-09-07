# Status surface

`/status` is how a returning user checks their deployed site: it proves
ownership with a fresh GitHub authorization, re-derives site truth from
GitHub on every render, and offers a manual sync re-run. Unauthenticated it
is a plain "Check your site" page whose only action begins that
authorization. Locally the authorization cannot complete (placeholder
credentials, no real GitHub), so this feature proves the public render and
the connect redirect contract, and records the authenticated session as a
staging-scoped skip.

## Sub-features

- `status-render` serves the unauthenticated page with HTTP 200, title and
  heading `Check your site`, and a connect entry.
- `status-connect-redirect` answers `/status?connect=1` with `302` to the
  GitHub OAuth authorize URL, a status-kind signed `state`, and a
  `__Host-status-state` cookie binding the nonce.
- `status-rerun-unauthenticated` answers `POST /status/rerun` without a
  session with a `303` redirect to `/status?notice=signin_required` (the
  entry page with a sign-in notice), never an error page.
- `status-authenticated-view` renders site truth and offers the rerun —
  staging-scoped: record a skip locally.

## How to get to it (user POV)

- Open `/status` directly (it is linked for returning users).
- Choose the connect entry (`/status?connect=1`) to begin the ownership
  check.
- Use the re-run action on the authenticated page when a sync looks stale.

## Driving it with curl and the Playwright driver

Preconditions:

- The verification instance passes the doctor (`../SKILL.md`).
- `$BASE` is `https://127.0.0.1:$PORT` (launched with `--local-protocol
  https`; curl needs `-k`).

- **Public render.** Run
  `curl -sk -D "$ART_DIR/status-surface/headers.txt" -o "$ART_DIR/status-surface/status.html" -w "%{http_code}\n" "$BASE/status"`.
  Expect HTTP `200`, `<title>Check your site</title>`, an `<h1>` reading
  `Check your site`, and a `href="/status?connect=1"` anchor in the body.
- **Connect redirect.** Run
  `curl -sk -o /dev/null -D "$ART_DIR/status-surface/connect-headers.txt" -w "%{http_code}\n" "$BASE/status?connect=1"`.
  Expect HTTP `302` with `Location: https://github.com/login/oauth/authorize?client_id=local-placeholder&redirect_uri=...%2Fauth%2Fgithub%2Fcallback&state=...`
  and a `Set-Cookie: __Host-status-state=<uuid>; Max-Age=600; Path=/;
  HttpOnly; Secure; SameSite=Lax` header.
- **Status-kind state.** Decode the `state` payload as in
  `onboarding-entry.md`. Expect `"k":"status-state"` — the status leg's state
  verifies only against its own kind, distinct from the install leg's
  `{"v":1,"jobId":...}` shape.
- **Rerun without a session.** Run
  `curl -sk -o /dev/null -D "$ART_DIR/status-surface/rerun-headers.txt" -w "%{http_code}\n" -X POST "$BASE/status/rerun"`.
  Expect HTTP `303` with `Location: .../status?notice=signin_required` —
  not a 500 and not the JSON error envelope.
- **Browser drive.** The driver's `status-render-and-connect` check loads
  `/status` in real Chrome, asserts the title and heading, clicks the
  connect entry, and asserts the browser's navigation to the GitHub
  authorize URL (stopped at DNS) plus the `__Host-status-state` Set-Cookie
  header on the 302 (screenshots under `e2e/status-surface/`).
- **Proof.** `status.html`, the three header captures, and the decoded state
  under `status-surface/` show the public contract end to end.

## Gotchas

- The `redirect_uri` in the connect redirect echoes the request's own host
  and port. Drive via `https://127.0.0.1:$PORT` and expect exactly that
  echoed back; a proxy or hostname change silently rewrites it.
- **Do not follow the connect redirect** (no `curl -L`): it targets real
  GitHub with the placeholder client id.
- `__Host-` cookies require a secure origin in real browsers; curl observes
  the `Set-Cookie` regardless. The cookie is proof the nonce was bound, not
  something to replay into later requests.
- The authenticated view (site truth, rerun button, `__Host-status-session`
  cookie) needs a real GitHub authorization. Locally a `303` from the rerun
  POST is the correct full contract; do not invent a session cookie to fake
  the authenticated page.
- Every authenticated render mints a fresh GitHub installation token; the
  surface is rate-budgeted by the same provisioning admission controls, so
  authenticated drives belong in staging runs, not local loops.
