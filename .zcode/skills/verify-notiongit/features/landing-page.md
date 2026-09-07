# Landing page

The landing page at `/` is the entire marketing surface: a single
server-rendered document that explains what InkDrafts creates, owns, and
costs, why each provider's permissions are requested, and how to leave — with
no client JavaScript and no external requests, so it works with JavaScript
disabled.

## Sub-features

- `landing-render` serves the document with HTTP 200 and `text/html` under
  the title `InkDrafts`.
- `landing-cta` offers exactly one call to action, the `/connect/github`
  anchor, reachable without JavaScript.
- `landing-self-contained` loads no scripts and references no external
  resources (fonts, scripts, images).
- `landing-policy-links` links the policy documents so the claims are
  readable before a user connects anything.

## How to get to it (user POV)

- Open the site root `/` in a browser (this is what `workers_dev` serves and
  what inkdrafts.com fronts).
- Follow the connect call to action, which begins GitHub-first onboarding.

## Driving it with curl and the Playwright driver

Preconditions:

- The verification instance passes the doctor (`../SKILL.md`).
- `$BASE` is `https://127.0.0.1:$PORT` (the launched with
  `--local-protocol https` instance; plain `http://` answers `301` to the
  https URL ahead of every route, so curl needs `-k`).

- **Plaintext is upgraded.** Run
  `curl -sS -o /dev/null -D "$ART_DIR/landing-page/http-headers.txt" -w "%{http_code}\n" "http://127.0.0.1:$PORT/"`.
  Expect `301` with a `Location` on the https origin — the worker owns the
  plaintext redirect ahead of every route.
- **Render.** Request the page. Run
  `curl -sk -D "$ART_DIR/landing-page/headers.txt" -o "$ART_DIR/landing-page/body.html" -w "%{http_code} %{content_type}\n" "$BASE/"`.
  Expect `200 text/html; charset=utf-8`, `<title>InkDrafts</title>` in the
  body, and no `ERROR` line in the wrangler log.
- **Single no-JS CTA.** Count the connect anchors. Run
  `grep -c 'href="/connect/github"' "$ART_DIR/landing-page/body.html"`.
  Expect at least `1`; the primary call to action must be a plain anchor, not
  a JavaScript handler.
- **Self-contained.** Search for scripts and external resources. Run
  `grep -c "<script" "$ART_DIR/landing-page/body.html"` (expect `0`) and
  `grep -Eo 'src="https?://|href="https?://' "$ART_DIR/landing-page/body.html" | grep -vc 'github.com\|notion.so\|docs.github.com\|creativecommons.org\|inkdrafts'`
  (expect `0` external asset loads; outbound informational links to GitHub,
  Notion, and the public repositories are allowed and expected).
- **Policy links.** Run
  `grep -o 'href="/privacy"\|href="/terms"\|href="/security"\|href="/acceptable-use"\|href="/support"' "$ART_DIR/landing-page/body.html" | sort -u`.
  Expect all five policy paths to appear.
- **Browser drive.** Run the driver
  (`bun run .zcode/skills/verify-notiongit/helpers/e2e.ts "$BASE" "$ART_DIR/e2e"`).
  Its `landing-render` check loads `/` in real Chrome and asserts the title,
  the `/connect/github` anchor, zero script tags, and zero external asset
  loads, saving `landing-page/landing.png`.
- **Proof.** `commands.txt`, `headers.txt`, and `body.html` under
  `landing-page/` together show the request, the 200, and the document.

## Gotchas

- The page is long; assert on the handles above, not on visual position.
- Outbound informational links (GitHub, Notion, the public repos) are part of
  the design. Only asset loads (`src=` fetches) would break the
  self-contained contract.
- The page carries no version marker. Identity proof is the title plus a
  healthy `/healthz`.
