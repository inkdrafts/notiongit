# Policy pages

Six static policy documents render as standalone pages: Privacy Policy,
Terms of Service, Security and Data Handling, Acceptable Use Policy,
Support, and Leaving InkDrafts. They are what the landing page's claims link
to, and they must render for a user before and without connecting anything.

## Sub-features

- `policy-render` serves each of the six paths with HTTP 200 and `text/html`.
- `policy-titles` titles each document with its subject followed by the site
  suffix (e.g. `<title>Privacy Policy — InkDrafts</title>`).
- `policy-not-found` keeps unknown paths on the JSON 404 contract instead of
  rendering a policy page.

## How to get to it (user POV)

- Follow a policy link from the landing page footer/body.
- Open any policy path directly, e.g. `/privacy`.

## Driving it with curl and the Playwright driver

Preconditions:

- The verification instance passes the doctor (`../SKILL.md`).
- `$BASE` is `https://127.0.0.1:$PORT` (launched with `--local-protocol
  https`; curl needs `-k`).

- **All six render.** For each pair below run
  `curl -sk -o "$ART_DIR/policy-pages<slug>.html" -w "<path> %{http_code} %{content_type}\n" "$BASE<path>"`
  and expect `200 text/html; charset=utf-8`:
  `/privacy`, `/terms`, `/security`, `/acceptable-use`, `/support`,
  `/leaving`.
- **Exact titles.** For each saved body run
  `grep -o "<title>[^<]*</title>" <file>`. Expect each to open with the
  page's subject — `Privacy Policy`, `Terms of Service`,
  `Security and Data Handling`, `Acceptable Use Policy`, `Support`,
  `Leaving InkDrafts` — and close with the site suffix ` — InkDrafts`.
- **Unknown path stays JSON.** Run
  `curl -sk -w "\n%{http_code}\n" "$BASE/nope"`. Expect
  `{"error":"not_found","message":"The requested route does not exist."}`
  with HTTP `404`.
- **Browser drive.** The driver's `policy-<path>` checks load all six pages
  in real Chrome, assert each exact title, and save a full-page screenshot
  per page under `e2e/policy-pages/`.
- **Proof.** The six saved bodies plus the command transcript under
  `policy-pages/` show every path, status, and title.

## Gotchas

- The pages are served by the same worker, not a static host: a deploy that
  breaks routing shows up here as a JSON 404, not a CDN error page.
- Do not assert on document length or section headings; the copy is
  maintained independently and the contract is path, status, and title
  subject. The ` — InkDrafts` suffix is part of the shared layout; assert
  the subject prefix, not the whole decorated string, in the Playwright
  driver.
- `/leaving` is part of the policy set even though it reads as instructions,
  not legalese — do not "fix" it out of the matrix.
