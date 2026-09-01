# ADR 0003: GitHub App visibility and ownership model

- Status: Accepted
- Date: 2026-09-01
- Decision: Register the InkDrafts GitHub App as a public, direct-install App
  owned by the `inkdrafts` organization, kept unlisted from GitHub
  Marketplace. This supersedes the "private until M5" constraint in issue
  #4's original scope.

## Context

Issue #4 originally required all of: App owned by `inkdrafts`, visibility
private, and installable into arbitrary users' personal accounts, verified by
a development personal-account install. These requirements conflict: GitHub
only allows a private App to be installed on the account that owns it
("Making a GitHub App public or private", docs.github.com). For an
organization-owned App that means the `inkdrafts` organization itself — never
an arbitrary personal account. Because InkDrafts' entire product is
provisioning into non-developers' personal GitHub accounts, this is not a
corner case; it is the primary flow. The conflict was flagged as a blocker on
issue #4 before any implementation
([comment](https://github.com/inkdrafts/notiongit/issues/4#issuecomment-5499187354)),
which recorded three possible operating models without choosing one, and a
prior implementation attempt (PR #32) documented the blocker but stopped
there rather than guessing.

A separate, out-of-repo planning document (the original InkDrafts handoff
briefing) already carries a settled decision on this exact question — "App
visibility: Public App, direct install link, no Marketplace listing, avoids
Marketplace review entirely" — that the PR #32 session did not have access
to, which is why it stopped at documenting the blocker instead of resolving
it.

## Decision

1. **Visibility: Public.** The App is created with `public: true`. This is
   the only setting that lets it be installed by an arbitrary personal
   GitHub account, which is required for the product's actual flow
   (a non-developer connects their own account) to be tested or used at all,
   in development or production.
2. **Ownership: the `inkdrafts` organization**, unchanged from the original
   scope — App identity, secrets management, and audit trail stay under
   organizational control rather than a maintainer's personal account.
3. **Not listed in GitHub Marketplace, in either environment.** Visibility
   (public/private) and Marketplace listing are independent GitHub settings;
   a public App gets a direct-install link
   (`https://github.com/apps/<slug>/installations/new`) without ever being
   listed or reviewed. This preserves the spirit of "not advertised" from the
   original private-until-M5 intent, without the impossible
   private-plus-personal-account combination.
4. **The "private until M5" constraint is revised to "unlisted until M5."**
   M5 ("Hardening & launch") already includes "App flipped public" in the
   handoff's milestone table — that step is now moot, since the App is public
   from registration. M5's actual remaining job for this App is: link the
   direct-install URL from `inkdrafts.com` and treat that as the real launch
   moment, not a visibility change.
5. Everything else already decided for issue #4 is unaffected: the
   least-privilege permission matrix (Metadata read; Administration,
   Contents, Secrets, Actions, Pages write), OAuth-during-installation, and
   Cloudflare-secret-only credential storage all carry over unchanged — see
   `docs/github-app-runbook.md`.

Registration is performed via the
[GitHub App manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
using `docs/github-app-manifest.html`, which encodes every setting above so
an org owner registers by reviewing and clicking once rather than retyping
roughly fifteen form fields by hand — a likely source of drift or error in a
manual registration.

## Rejected approaches

- **Private organization App (development model).** Preserves literal
  "private," but installation is then restricted to the `inkdrafts`
  organization itself. The product's defining flow — a non-developer's
  *personal* account — could not be exercised at all until a later
  visibility change, which only postpones this same decision to M5 while
  blocking meaningful testing (including issue #4's own acceptance
  criterion, "a development install completes the combined Install &
  Authorize flow") until then.
- **Separate private App on a maintainer's personal account.** Only
  validates a single-account smoke test; does not register the App this
  project actually ships, so it does not resolve issue #4 and would need to
  be thrown away and re-registered correctly later.

## Consequences and required follow-up

- The App becomes installable by anyone with its direct-install link as soon
  as it is registered — before the onboarding UX (issues #9, #20) or abuse
  controls (issue #27) exist. Exposure is low (the App is unlisted, and
  `inkdrafts.com` will not link to `/connect/github` until issue #9 ships),
  but not zero, since a public App's install page is not access-controlled.
  Treat any pre-#9 install as a manual, closely-watched smoke test only; do
  not rely on obscurity as a control once real traffic is expected — issue
  #27 remains required before public launch.
- `docs/github-app-runbook.md`'s target settings now record Visibility =
  Public in both environments, and use **one** App with both the staging and
  production callback URLs registered together (`callback_urls` accepts a
  list), rather than the previously ambiguous two-column table that could be
  read as implying two separate Apps.
- Actual registration (the manifest submission, private key generation, and
  Cloudflare secret population) still requires a human `inkdrafts` org owner
  with a browser; this session confirmed via `gh api` that the currently
  authenticated account (`leandro-llosa`) holds `admin` (owner-equivalent)
  role in the `inkdrafts` organization and can perform it. This session did
  not perform it — no browser is available here — so issue #4's development
  install criterion remains open until a human completes it.
- The development-environment callback URL depends on the Cloudflare Workers
  staging hostname, which is not knowable until staging is actually deployed;
  `docs/github-app-manifest.html` keeps this as an explicit field to fill in
  rather than guessing a value.

## References

- [Making a GitHub App public or private](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private)
- [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
- [User authorization during installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [issue #4 blocker comment](https://github.com/inkdrafts/notiongit/issues/4#issuecomment-5499187354)
- [PR #32 — prior attempt](https://github.com/inkdrafts/notiongit/pull/32)
