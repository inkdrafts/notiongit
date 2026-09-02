# InkDrafts Notion integration runbook

This runbook is the operator record for the production Notion public
connection. It deliberately stores configuration instructions, not OAuth
credentials or user/workspace identifiers.

## Current status

The repository-side contract is ready. The live public connection and the
public template page must be created or verified by an authenticated Notion
maintainer before launch. Record the live template URL only in the Notion
connection configuration; do not commit it here. A connection client ID and
secret belong only in Cloudflare secret storage.

## Target connection settings

Create a **public connection** named `InkDrafts` in the Notion Creator
dashboard. Select **Any workspace** as the installation scope so users can
authorize it without a manual workspace allowlist. Marketplace listing is a
separate decision and is not part of this issue.

| Setting | Development/staging | Production |
| --- | --- | --- |
| Connection name | `InkDrafts` | `InkDrafts` |
| Redirect URI | `https://notiongit-staging.notiongit.workers.dev/auth/notion/callback` | `https://inkdrafts.com/auth/notion/callback` |
| Installation scope | Any workspace | Any workspace |
| Optional template | Same public template page | Same public template page |

Register both redirect URIs on the same connection. Keep them exact; do not
add wildcard or localhost URIs to the production connection. The callback
selects the environment from the registered URI and exchanges the temporary
authorization code server-side.

### Capabilities

Request only:

- **Read content** — required to walk the duplicated root, retrieve child
  database schemas, and query the database contract.
- **Insert content** — required only for the ADR-documented fallback that
  creates Pages and Posts databases when the user chooses existing pages
  instead of duplicating the template.

Do not request Update content, Read comments, Insert comments, or user
information. The sync engine reads Notion content and does not write back to
Notion. If the fallback is removed in a future release, remove Insert content
after the corresponding code and documentation change.

## Template registration

Build the sanitized page exactly as specified in
[`notion-template.md`](notion-template.md): one public root page, two direct
child database blocks, required property types/options, synthetic guidance
rows, and in-workspace field guidance.

Before configuring it:

1. Inspect the root page in a disposable workspace and confirm it contains no
   personal content, workspace IDs, credentials, or private links.
2. Make the root page publicly accessible and copy its canonical Notion page
   URL. Do not paste the URL into git, chat, logs, or issue comments.
3. In the connection's Configuration tab, set **Notion URL for optional
   template** to that URL.
4. Open the connection's authorization prompt and verify that the user can
   choose **Duplicate template** as well as manual page selection.
5. Keep the template URL and resulting duplicated page IDs out of telemetry.
   The callback may use `duplicated_template_id` during the short-lived
   provisioning operation, then discard the user access and refresh tokens.

Template duplication is the primary path. If the OAuth response has
`duplicated_template_id: null` because the user selected existing pages, the
future provisioning flow must use a user-selected parent and the documented
database-creation fallback. It must not guess database roles by title or
silently use an unrelated workspace database.

## API version and schema contract

Until the resolver is migrated to the database/data-source API split, every
Notion API request made by the Worker must send:

```http
Notion-Version: 2022-06-28
```

This keeps the database schema in the `properties` map expected by the current
resolver and matches the engine's single-data-source template. Notion's
`2025-09-03` API version moves schema reads to data sources; upgrading requires
an explicit code migration to resolve `data_sources[0].id`, read that data
source, and update query/create calls. Do not change the header in the
dashboard or code as an incidental maintenance edit.

The template schema version is **1**. The required properties are documented
in [`notion-template.md`](notion-template.md) and the synthetic fixtures in
`spikes/notion-oauth-template/fixtures/`. A template update is not complete
until the schema contract, resolver tests, and this runbook agree.

## Secret storage

After creating the connection, copy its client ID and client secret directly
into Cloudflare's server-only secret store. Never put either value in
`wrangler.toml`, `.dev.vars.example`, browser code, git, or command-line
arguments.

```sh
wrangler secret put NOTION_CLIENT_ID --env staging
wrangler secret put NOTION_CLIENT_SECRET --env staging
wrangler secret put NOTION_CLIENT_ID --env production
wrangler secret put NOTION_CLIENT_SECRET --env production
```

Use the interactive prompts so values do not appear in shell history or
output. Verify names without reading values:

```sh
wrangler secret list --env staging
wrangler secret list --env production
```

The expected Notion names are `NOTION_CLIENT_ID` and
`NOTION_CLIENT_SECRET`. User `access_token` and `refresh_token` values are
write-through only: exchange and use them for provisioning, write the
resulting database IDs to the intended GitHub secrets through the later
provisioning flow, then discard both tokens. Do not put them in KV, logs,
analytics, error reports, or generated files.

## Rotation and revocation

1. Create a replacement client secret in Notion.
2. Put it into staging and complete a disposable-workspace consent and
   callback smoke test.
3. Put the replacement into production and verify the same metadata-only
   checks.
4. Revoke the old client secret only after both environments pass.

If a client secret is exposed, revoke it immediately, replace both Cloudflare
environment secrets, and record only the incident date and result. Never copy
the secret into a ticket or log.

Notion does not document a guaranteed public-connection access-token lifetime
in the API response contract. Because InkDrafts intentionally retains no
refresh token, a revoked or invalid token requires the user to reconnect
Notion; it is not an automatic refresh case.

## Verification checklist

Run these checks after registration and after any template or credential
change:

- In a disposable workspace, complete consent using **Duplicate template**.
- Confirm the token exchange response is handled server-side and that the
  duplicated root resolves to exactly one Pages and one Posts database.
- Rename both database titles and repeat schema resolution; role detection
  must still succeed.
- Compare both database schemas with `docs/notion-template.md` and the sync
  engine contract, including select options `Published`, `Draft`, and Pages
  `Type` values.
- Verify `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET` exist in both
  environments with `wrangler secret list`, without reading values.
- Run `bun run typecheck`, `bun run test`, `bun run build`, and `git diff --check`.
- Review logs and the final diff for OAuth codes, tokens, workspace IDs,
  personal content, and private links.

Record only pass/fail, date, environment, and the reviewer in the pull
request. Do not record the template URL, page/database IDs, user identity, or
consent response.

## Update policy

The public connection points to one static template page. Editing that page
changes the source used for future duplications; it does not repair already
provisioned sites. Treat schema changes as migrations:

1. Draft and test a new sanitized template version in a disposable workspace.
2. Update `docs/notion-template.md`, the sync engine contract, fixtures/tests,
   and this runbook together.
3. Run the verification checklist against a fresh duplicate.
4. Change the configured public template URL only after the new version is
   verified. Keep the prior version available for rollback until the new
   connection flow is confirmed.
5. Create a separate follow-up for migration of existing user sites; do not
   mutate users' Notion databases automatically.

## References

- [Notion public connections](https://developers.notion.com/guides/get-started/public-connections)
- [Notion authorization and template duplication](https://developers.notion.com/guides/get-started/authorization)
- [Notion connection capabilities](https://developers.notion.com/reference/capabilities)
- [Notion create a token](https://developers.notion.com/reference/create-a-token)
- [Notion API version upgrade guide](https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03)
