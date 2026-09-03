# GitHub App runbook

This runbook is the source of truth for the InkDrafts GitHub App registration,
the Cloudflare secret names, and the operator checks around the registration.
The App ID and slug are non-secret configuration values. This file contains no
client secret, private key, webhook secret, OAuth code, or token.

## Registration status

**Decision recorded 2026-09-01 — see
[ADR 0003](decisions/0003-github-app-visibility.md).** GitHub's rules do not
allow all of the originally requested constraints to be true at once: a
private App can be installed only on the account that owns it, so an
`inkdrafts`-owned private App could never be installed into an arbitrary
user's personal account — which is the product's entire onboarding flow.

**Chosen model: public, direct-install App, owned by the `inkdrafts`
organization, not listed in GitHub Marketplace.** This supersedes the
original "private until M5" constraint with "unlisted until M5" — the App is
public (and therefore installable) from registration, but stays unadvertised
(no link from `inkdrafts.com`, no Marketplace listing) until the M5 launch
issue. ADR 0003 also records the two rejected alternatives and why.

**Registered 2026-09-01.** The organization-owned App is
[`inkdrafts`](https://github.com/apps/inkdrafts), App ID `4798518`. The
manifest conversion completed successfully, and its generated private key,
client ID, and client secret were written directly to the approved Cloudflare
secret stores for both `staging` and `production`. No secret value was written
to this repository or printed during verification. No GitHub Marketplace draft
or listing was created or submitted.

**Install & Authorize smoke test completed 2026-09-02.** A direct installation
on a personal GitHub account completed with repository access set to all current
and future repositories and exactly the permissions documented below. GitHub
returned to the staging callback with an OAuth code, installation ID, and
`setup_action=install`; no authorization code or token was retained, exchanged,
or copied into the repository, issue, or PR. The App was then verified in both
the account's **Installed GitHub Apps** and **Authorized GitHub Apps** settings.
The callback returned `501 not_implemented`, as expected: processing the
callback belongs to issue #9 and is outside issue #4's scope.

## Registering the App

The App is already registered; do not repeat this flow unless the existing App
is intentionally being replaced. [`docs/github-app-manifest.html`](github-app-manifest.html)
encodes every setting below so nothing has to be retyped by hand:

1. Open `docs/github-app-manifest.html` locally in a browser, signed in as an
   `inkdrafts` organization owner (`admin` role).
2. If staging is already deployed, enter its real Cloudflare Workers hostname
   in the form field; the development callback URL in the manifest preview
   updates as you type. **If staging hasn't been deployed yet, leave it
   blank** — the App registers with only the production callback URL, and
   the staging callback can be added later (step 6) once the hostname is
   known. Registering the App does not require Cloudflare Workers to exist
   yet; the two are independent.
3. Review the rendered manifest JSON on the page, then submit. GitHub redirects
   to `https://inkdrafts.com/` with a one-time `?code=` query parameter. The
   code is sensitive and expires after one hour. Do not print it, put it in a
   command-line argument, or paste it into chat, an issue, or a commit.
4. Complete the manifest handshake by sending that code server-side to
   `POST /app-manifests/{code}/conversions` within one hour. Registration is
   not complete until this succeeds. The response contains the generated
   private key, client secret, webhook secret, App ID, slug, and other App
   metadata. Write the private key, client ID, and client secret directly to
   the approved stores below without logging them. Discard the unused webhook
   secret because webhook delivery is disabled.
5. Confirm the App was **not** submitted to GitHub Marketplace. Manifest
   creation never does this on its own, but verify the setting explicitly.
6. Once staging is deployed and its real hostname is known, add
   `https://<staging hostname>/auth/github/callback` to the App's Callback
   URLs in its settings page. This does not require re-registering the App.

If the manifest conversion cannot be completed securely, register manually at
[`inkdrafts` organization App settings](https://github.com/organizations/inkdrafts/settings/apps/new)
using the target settings below — they are identical to what the manifest
encodes.

## Target settings

Both callback URLs below are registered on the **same** App
(`callback_urls` accepts a list); there is no separate development App.

| GitHub setting | Development | Production |
| --- | --- | --- |
| App name | `InkDrafts` | `InkDrafts` |
| Visibility | Public | Public |
| Listed in GitHub Marketplace | No | No |
| Homepage URL | `https://inkdrafts.com/` | `https://inkdrafts.com/` |
| Callback URL | `https://notiongit-staging.notiongit.workers.dev/auth/github/callback` | `https://inkdrafts.com/auth/github/callback` |
| Setup URL | blank when OAuth during installation is enabled | blank when OAuth during installation is enabled |

Staging is deployed (`notiongit-staging.notiongit.workers.dev`, workers.dev
subdomain `notiongit` — see `docs/architecture.md`), so both callback URLs
above are real and current. Keep callback URLs exact; do not enable wildcard
matching.

Enable or select:

- Request user authorization (OAuth) during installation.
- Expire user authorization tokens.
- Repository access to all repositories, because the generated repository is
  not known when the installation is created and must become available to the
  installation after generation.

Disable or leave unset:

- Device Flow.
- Webhook delivery (`Active`). No webhook consumer exists in this Worker.
- Redirect on update. There is no Setup URL in the OAuth-during-install flow.
- GitHub Marketplace listing.

When OAuth during installation is enabled, GitHub does not allow a separate
Setup URL. The Callback URL receives the OAuth code and is also the post-install
return path. The callback implementation belongs to issue #9.

## Least-privilege permission matrix

Select only these **repository permissions**. The level is the highest level
required by the planned endpoint set; read access is implicit in write access.

| GitHub permission | Level | Planned use | Endpoint evidence |
| --- | --- | --- | --- |
| Metadata | Read | Read repository identity, default branch, and visibility while polling generation. | `GET /repos/{owner}/{repo}` |
| Administration | Write | Generate a repository from the template and satisfy the Pages administrator check. | `POST /repos/{template_owner}/{template_repo}/generate`; `POST /repos/{owner}/{repo}/pages` |
| Contents | Write | Read the template/repository and patch deployment-owned `_config.yml`. | Template generation requires Contents read; issue #12 requires Contents write. |
| Secrets | Write | Read the Actions public key and create/update the three repository secrets. | `GET /repos/{owner}/{repo}/actions/secrets/public-key`; `PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}` |
| Actions | Write | Dispatch the first sync and poll its workflow run. | `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` |
| Pages | Write | Create and inspect the legacy Pages site and deployment. | `POST /repos/{owner}/{repo}/pages`; Pages status/deployment endpoints |

Request no organization, enterprise, account, issues, pull request, package,
workflow, webhook, or other repository permissions. The `Workflows` permission
is not needed because InkDrafts dispatches the template's existing workflow;
it does not edit workflow files.

The permission names and endpoint requirements were checked against GitHub's
current documentation:

- [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [Create a repository using a template](https://docs.github.com/en/rest/repos/repos#create-a-repository-using-a-template)
- [Actions secrets API](https://docs.github.com/en/rest/actions/secrets)
- [GitHub Pages API](https://docs.github.com/en/rest/pages/pages)
- [Workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)

## Values and approved secret storage

Record these non-secret values in the Cloudflare Worker environment as
configuration variables. Do not put them in browser code or use them as
credentials:

| Variable | Value | Rotation |
| --- | --- | --- |
| `GITHUB_APP_ID` | `4798518` | Stable for the App |
| `GITHUB_APP_SLUG` | `inkdrafts` | Stable unless the App is renamed |

Store these server-only values as Cloudflare secrets in **both** staging and
production. `wrangler secret put` prompts interactively; paste the value into
the prompt so it is not placed in shell history or command output:

```sh
wrangler secret put GITHUB_APP_PRIVATE_KEY --env staging
wrangler secret put GITHUB_CLIENT_ID --env staging
wrangler secret put GITHUB_CLIENT_SECRET --env staging

wrangler secret put GITHUB_APP_PRIVATE_KEY --env production
wrangler secret put GITHUB_CLIENT_ID --env production
wrangler secret put GITHUB_CLIENT_SECRET --env production
```

The existing Notion secrets use the same server-only storage pattern. Never
commit `.dev.vars`, a downloaded PEM file, a client secret, an OAuth code, or a
user/installation access token. User access tokens are write-through only and
must be discarded after provisioning.

## Rotation and revocation

### Private key

1. Generate a second App private key in the App settings.
2. Immediately put the new PEM into `GITHUB_APP_PRIVATE_KEY` in staging and
   run the staging install smoke test.
3. Put the same new PEM into production and verify App authentication and an
   installation-token request.
4. Delete the old key in GitHub only after both environments use the new key.
5. If compromise is suspected, delete the old key first, replace the Cloudflare
   secret, inspect audit logs, and treat all tokens minted with the old key as
   compromised.

GitHub App private keys do not expire automatically; they must be manually
revoked. Keeping two keys during rotation avoids downtime.

### OAuth client secret

1. Generate a replacement client secret in the App settings.
2. Put it into the staging `GITHUB_CLIENT_SECRET` and complete the staging
   OAuth-during-install flow.
3. Put it into production and complete the same verification.
4. Revoke/delete the old client secret after both environments pass.

If a client secret or token is exposed, revoke it immediately, replace the
Cloudflare secret, and record the incident without copying the secret into the
issue, logs, or PR.

### Verification without reading secret values

An operator can verify that the names exist without printing their values:

```sh
wrangler secret list --env staging
wrangler secret list --env production
```

The expected names are `GITHUB_APP_PRIVATE_KEY`, `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`, `NOTION_CLIENT_ID`, and `NOTION_CLIENT_SECRET`.

## Install smoke test

Run this only after the App is registered per "Registering the App" above and
the Cloudflare secrets are populated.

Before issue #9 implements `/connect/github` and the callback exchange, verify
the registration with this manual flow:

1. Open `https://github.com/apps/inkdrafts/installations/new` and select a
   personal GitHub account.
2. Confirm repository access is **All repositories** and the consent page lists
   only the permission set above.
3. Complete **Install & Authorize** and confirm GitHub returns to the exact
   staging callback with `code`, `installation_id`, and
   `setup_action=install`. Do not record or exchange the code during this
   registration-only test.
4. Confirm InkDrafts appears in both **Installed GitHub Apps** and **Authorized
   GitHub Apps** for that account.
5. Record the date, environment, App settings reviewer, and result in the PR;
   do not record account names, repository contents, tokens, or unnecessary IDs.

The end-to-end onboarding tests must
also confirm that the callback identifies the authenticated login and
installation without persisting tokens, and that generated repositories,
Actions secret names, and Pages settings pass metadata-only checks.

## Implemented callback contract

The Worker starts the flow at `GET /connect/github`. Callers may supply the
onboarding job as `job_id` (or `jobId`); if omitted, the Worker creates one.
The response is a redirect to
`https://github.com/apps/inkdrafts/installations/new` with a ten-minute,
HMAC-signed `state` value. The state is bound to that job and its nonce is
stored in `JOBS` only to enforce expiry and replay protection.

GitHub returns to `GET /auth/github/callback`. The Worker exchanges `code`
server-side, calls `/user` to identify the authenticated account, and calls
`/user/installations/{installation_id}` to prove that the installation belongs
to that account. Suspended installations, organization installations, missing
installations, mismatched accounts, denied authorization, invalid state, and
replayed state fail with a generic JSON error.

The naming policy first tries the exact lowercase `<login>.github.io` name for
the apex site. If it is occupied, the project-site sequence is
`<login>-inkdrafts`, `<login>-inkdrafts-2`, and so on. The selection is not a
reservation, so generation retries with the next candidate when GitHub returns
a `422` name collision.

Generation runs in the same callback request, while the short-lived user access
token is still in memory, because `POST
/repos/inkdrafts/notiongit-template/generate` requires user-to-server
authentication. The request creates a **public** repository carrying the
description `Notion-powered site published with InkDrafts` (the product
description and the idempotency marker). Before creating anything, the Worker
scans the account's owned repositories for a non-fork repository that already
carries the marker and adopts it — retries never mint duplicates. When GitHub
refuses a name with `422`, the Worker reads the occupier with the user token:
an InkDrafts repository is adopted, a foreign repository advances the selection
to the next deterministic name, and an *unreadable* occupier fails with
`github_generate_unavailable` rather than guessing.

After generation the Worker mints an installation token and polls
`GET /repos/{owner}/{repo}` plus `GET /repos/{owner}/{repo}/commits/main` with
bounded exponential backoff (250 ms doubling to an 8 s cap, at most 8 attempts,
≈24 s worst case) until the repository reports `main` with a readable initial
commit. Polling is mandatory, not defensive: generation is asynchronous, and
the first repository response can report a placeholder default branch (an
observed `master` on a `main`-default template) with no readable commit until
the copy settles. Verification deliberately uses the installation token: the
installation's repository access is set to all repositories, so success also
proves the App can act on the new repository for every later provisioning
step. A poll that never converges is a distinct `github_generate_timeout`.

Failure taxonomy, each with a different recovery path and each resumable by
restarting the flow (which adopts the already-generated repository):

| JSON error | HTTP | Meaning |
| --- | --- | --- |
| `github_generate_rate_limited` | 429 | GitHub's content-generation secondary limit; `retry_after_seconds` echoes GitHub's `Retry-After`. |
| `github_generate_timeout` | 504 | The repository exists but never reported a readable `main` commit in time. |
| `github_generate_name_exhausted` | 409 | Every deterministic candidate name belonged to a foreign repository. |
| `github_generate_unavailable` | 502 | GitHub failed before or during generation, or the response was unusable. |
| `github_generate_branch_mismatch` | 502 | The repository reported itself as a fork. |

A successful callback writes the job record with status `repository_generated`
and a non-secret `generatedRepository` identity: repository id, full name,
HTML URL, default branch, template full name, the template `main` HEAD SHA and
tree SHA at generation time, the verified `main` HEAD SHA and tree SHA, and
whether the repository was adopted from an earlier attempt. GitHub rewrites
the template history into a fresh initial commit, so commit SHAs never match
the template; equality of the two recorded **tree** SHAs is the check that the
generated repository contains the expected template revision. The response
adds `id`, `html_url`, and `default_branch` to the `repository` destination
object.

The OAuth access token and the installation token are held only for the
callback request and are never logged, returned, or written to KV.

## References

- [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app)
- [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
- [Private versus public GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private)
- [User authorization during installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Managing private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)
