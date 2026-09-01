# GitHub App runbook

This runbook is the source of truth for the InkDrafts GitHub App registration,
the Cloudflare secret names, and the operator checks around the registration.
It intentionally contains no App ID, client secret, private key, or token.

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

Actual registration (submitting the manifest, generating the private key and
client secret, and populating the Cloudflare secrets below) still requires a
human `inkdrafts` organization owner with a browser; it has not been
performed as of this decision being recorded. Do not mark issue #4's
development-install acceptance criterion complete until that smoke test
actually happens and its result is recorded in the closing PR.

## Registering the App

Use [`docs/github-app-manifest.html`](github-app-manifest.html) — it encodes
every setting below so nothing has to be retyped by hand:

1. Open `docs/github-app-manifest.html` locally in a browser, signed in as an
   `inkdrafts` organization owner (`admin` role).
2. Enter the real Cloudflare Workers staging hostname in the form field; the
   development callback URL in the manifest preview updates as you type.
3. Review the rendered manifest JSON on the page, then submit. GitHub creates
   the App and redirects to `https://inkdrafts.com/` with a one-time `?code=`
   query parameter — this can be ignored; the App is managed afterward
   through its normal GitHub settings page, not the manifest conversion API.
4. On the new App's settings page, generate a private key and a client
   secret (see "Values and approved secret storage" below for where they
   go), and record the App ID and slug.
5. Confirm the App was **not** submitted to GitHub Marketplace. Manifest
   creation never does this on its own, but verify the setting explicitly.

If the manifest flow cannot be used, register manually at
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
| Callback URL | `https://notiongit-staging.<account>.workers.dev/auth/github/callback` | `https://inkdrafts.com/auth/github/callback` |
| Setup URL | blank when OAuth during installation is enabled | blank when OAuth during installation is enabled |

Replace `<account>` with the actual Cloudflare Workers staging hostname.
Keep callback URLs exact; do not enable wildcard matching.

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
| `GITHUB_APP_ID` | App ID shown in the App settings | Stable for the App |
| `GITHUB_APP_SLUG` | Public slug from the App URL/settings | Stable unless the App is renamed |

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

1. Deploy the current Worker to staging and confirm the exact staging callback
   URL is reachable.
2. Start the `/connect/github` flow from staging.
3. Complete installation and OAuth in a disposable personal GitHub account
   used only for this test.
4. Confirm the callback identifies the authenticated login and installation
   without exposing or persisting tokens.
5. Confirm the installation can access only the permission set above.
6. Verify the generated repository, Actions secret names, and Pages settings
   using metadata-only checks. Never attempt to read secret values.
7. Record the date, environment, App settings reviewer, and result in the PR;
   do not record account names, repository contents, tokens, or unnecessary IDs.

## References

- [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app)
- [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
- [Private versus public GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private)
- [User authorization during installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Managing private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)
