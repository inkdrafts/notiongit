# ADR 0002: Notion onboarding via OAuth template duplication

- Status: Accepted, with one required follow-up before launch
- Date: 2026-09-01
- Decision: Use public-connection OAuth with a configured template as the
  primary path; fall back to programmatic database creation when
  `duplicated_template_id` is absent; identify the two databases by schema
  fingerprint, never by title.

## Context

The onboarding flow needs the user's Notion authorization to hand back not
just an access token but the IDs of two specific databases (Pages, Posts)
with a known schema, with no copy-paste step. The originating design
(handoff §3) flagged two assumptions as **load-bearing and explicitly
unverified**: that OAuth template duplication actually populates a
`duplicated_template_id` field, and whether Notion access tokens expire —
the write-through, discard-immediately token posture depends on the second
one not being a nasty surprise.

## What this session could and could not verify

This was an automated coding session with no browser and no Notion account —
it could not register a real public connection, configure a real template
page, or click through a real consent screen in a disposable workspace. That
specific empirical step (issue scope bullet 1 and the first Verification
line, "repeat the consent flow in a fresh disposable workspace") **was not
performed** and is called out as an explicit blocker below, not silently
skipped.

What this session *could* do, and did: fetch Notion's current official
developer documentation directly (`developers.notion.com`, including the raw
`openapi.json`) for every claim below, then independently re-fetch and
adversarially attempt to refute the two load-bearing claims a second time
with fresh sources before accepting them. Every quote below was reproduced
verbatim across at least two independent fetches. Confidence is high that
the *documented* behavior is as described; residual risk is specifically
about whether a live run matches documentation exactly (see "Not verified in
this session").

## Decision

### 1. Template duplication is real, current, and documented — use it as the primary path

`duplicated_template_id` is not an assumption. It is a documented field
in the `POST /v1/oauth/token` response: `string` or `null`, UUID format —
*"The ID of the new page created in the user's workspace. The new page is a
duplicate of the template that the developer provided with the connection.
If the developer didn't provide a template for the connection, then the
value is null."* (developers.notion.com/reference/create-a-token).

A developer configures this by pasting a public page's URL into the "Notion
URL for optional template" field under the connection's Configuration tab.
When a user authorizes and chooses "Duplicate template" (as opposed to
manually selecting existing pages), Notion automatically: adds the
connection to the workspace, duplicates the template page, and shares the
new page with the connection — no extra API call required
(developers.notion.com/docs/authorization,
developers.notion.com/guides/get-started/authorization).

Constraints confirmed in the docs:
- One static template page per connection — every user gets the same
  template. This matches InkDrafts's design (a fixed Pages+Posts schema);
  it would not fit a product needing per-user dynamic content, for which
  Notion's newer "programmatic setup" (create content via the API right
  after authorization) is the documented alternative.
- Only public connections use OAuth token exchange at all; internal
  integrations have no template option.
- The template page must itself be a page the developer can make public
  before its URL can be configured.

**Decision:** configure exactly one template page (containing the Pages and
Posts databases with the schemas in the repo's `CLAUDE.md`) on the
production connection in issue #5, and treat `duplicated_template_id` as the
primary, expected path through provisioning.

### 2. Fallback: if `duplicated_template_id` is null, create the databases directly

The docs are explicit that `duplicated_template_id` is `null` whenever no
template was configured *or* the user chose manual page selection instead of
duplicating. Provisioning must treat a null value as "fall through to manual
creation," not as an error:

1. Use the page(s) the user manually selected during the OAuth "Select
   pages" step as the parent.
2. `POST /v1/databases` with `parent: {type: "page_id", page_id: <selected
   page>}`, a `title`, and an inline schema (`initial_data_source.properties`
   on the create call, or a following `POST /v1/data_sources` — see the
   version note in §3). Requires the connection to have the "Insert content"
   capability (403 otherwise).
3. Repeat for the second database.
4. If the user's manual selection yields no usable parent page at all, this
   is a genuine "we cannot proceed" state and must fail loudly to the user
   with a clear next step, not retry silently or guess. `discovering: whether
   manual creation can succeed without a human-selected parent at all` (a
   documented but unconfirmed `{type: "workspace", workspace: true}` parent
   for page creation — confirmed for `POST /v1/pages`, not confirmed for
   `POST /v1/databases`, whose docs currently restrict the parent to "a
   Notion page or a wiki database") should be verified with a live test call
   before being relied on; do not build on it without that check.

Confidence on this fallback is **medium**, not high — see the research
agent's own caveat about catching one prompt-echo artifact in an early pass
(corrected via neutral re-fetch) and the still-open workspace-parent
question above.

### 3. Identify Pages vs. Posts by schema fingerprint, never by title — and pin an explicit `Notion-Version`

Titles are the first thing a non-technical user renames; the sync engine
must not depend on them. `spikes/notion-oauth-template/src/identify-databases.mjs`
implements and tests a fingerprint matcher: a database counts as "Pages" or
"Posts" only if enough of its properties match both name **and** Notion
property type (`title`, `rich_text`, `select`, `number`, `checkbox`, `date`,
`multi_select`, …) for that role; two-way ties or sub-threshold matches are
never guessed at — they surface as `ambiguous`/`unrecognized` and must fail
provisioning (feeds issue #8).

**Version-split complication, and the decision on it:** as of Notion API
version `2025-09-03`, "databases" and "data sources" were split — property
schemas no longer live on `GET /v1/databases/{id}` (which now returns a
`data_sources: [{id, name}]` array instead) and must instead be fetched from
the corresponding `GET /v1/data_sources/{data_source_id}`. However, Notion's
own upgrade guide states that a connection which stays on an older
`Notion-Version` continues to work — it only breaks if a user manually adds
a *second* data source to a database, which cannot happen to a database
InkDrafts itself creates and never exposes that Notion UI action for.
Notion's general versioning policy also states: *"We don't currently have
any plans to stop supporting older API versions."*

**Decision:** the provisioning backend pins `Notion-Version: 2022-06-28` on
every Notion API call until the database/data-source migration is implemented.
This is the version used by the current `notiongit-sync` contract, so
`GET /v1/databases/{id}` keeps returning
`properties` directly and `identify-databases.mjs`'s single-hop shape stays
correct. If the backend is ever deliberately migrated to a newer
`Notion-Version`, this module must first resolve `data_sources[0].id` and
read `properties` from that object instead — noted in the module's own
top-of-file comment so this doesn't get silently missed.

`spikes/notion-oauth-template/src/walk-template.mjs` implements the
paginated walk from a page's block children to its `child_database` blocks
— a `child_database` block's own `id` *is* the database id
(developers.notion.com/reference/get-block-children), so no extra lookup is
needed at that step.

### 4. Token lifetime: docs are silent, not reassuring — this revises the write-through posture's risk

This is the more consequential finding. **Notion's docs neither state that
public-connection access tokens expire, nor that they don't.** Verified
directly against the raw OpenAPI spec: the `create-a-token`,
`refresh-a-token`, and `introspect-token` schemas contain no
`expires_in`/`expires_at`/`exp` field at all (unlike a standard RFC 7662
introspection response). The six-step authorization guide ends at "Step 6 -
Refreshing an access token" with no section on revocation, uninstall, or
workspace-deletion consequences. A `revoke` endpoint exists
(`POST /v1/oauth/revoke`) but its response is just `{request_id}` — no prose
on what happens to already-granted access afterward.

By contrast, Notion is *not* generally silent about token lifetime where it
applies: Personal Access Tokens have an explicit, documented expiry (up to 1
year) and revocation model. A separate product, the Notion MCP OAuth server,
has explicitly documented short-lived tokens (currently ~8 hours) — this is
almost certainly the source of third-party reports of Notion tokens
"expiring in an hour," and does **not** describe the public-integration REST
API flow this product uses. (`developers.notion.com/workers/*`, a
Workers-authenticate-to-third-party-APIs product, is a second, unrelated
"expires_in" red herring worth knowing about so it isn't cited by mistake.)
The one place the word "expired" appears in connection with OAuth credentials
at all is the generic `invalid_grant` (400) error description — standard
OAuth2 error-taxonomy boilerplate about authorization codes/refresh tokens,
never naming `access_token`, with no stated timeframe.

A `refresh_token` **is** returned and documented as a real, working
mechanism (`grant_type: "refresh_token"` against the same
`/v1/oauth/token` endpoint) — but the project's write-through, discard-
immediately posture (handoff §3–4, reaffirmed in this issue's constraints:
"write-through only... discard... No user tokens at rest, GitHub or Notion")
means **the refresh token is never retained**. Nothing in this codebase will
ever call `refresh-a-token`.

**Consequence, and what changes because of it:** the write-through/no-
token-at-rest security posture itself is unaffected and remains correct —
that decision was about blast radius, not about token longevity, and it
still turns a backend compromise into "nothing." What this finding *does*
change is the failure-recovery story: because no refresh token is kept,
**if a Notion access token is ever revoked, invalidated, or (undocumented,
but not ruled out) expires, there is no automated recovery** — the user's
scheduled GitHub Action will start failing sync, and the only fix is the
user re-running InkDrafts's Notion connect flow to mint and write a fresh
token. This must be a *named, expected* failure mode, not a gap discovered
in production:
- Issue #18 (Failure taxonomy and recovery paths) must include "Notion sync
  authorization invalid" as a first-class case with a defined recovery UX
  (a "reconnect Notion" entry point that re-runs OAuth and overwrites the
  stored GitHub secret), distinct from a transient network failure.
- `notiongit-sync` should treat a 401 from Notion as this case specifically
  (not the missing-secret green-no-op case from handoff §10, and not a
  silent retry) so the distinction reaches the user.

## Not verified in this session (explicit follow-up required)

- **The actual live click-through.** Registering a temporary development
  public connection, configuring a real template page containing both
  databases, and going through the real "Select pages" consent screen in a
  disposable workspace requires a human with a browser and a Notion
  account — this session had neither. Everything above is grounded in
  primary, current, official documentation (independently re-fetched and
  adversarially cross-checked), not in an empirical run. Recommend folding
  this specific rehearsal into issue #6 (`/connect/notion` — authorize and
  callback) or the M4 end-to-end rehearsal (#25), whichever lands first,
  since those are the first points in the roadmap where a human is expected
  to actually run the flow.
- Whether template duplication preserves property IDs and select/status
  option IDs verbatim (vs. regenerating them) — would sharpen the schema
  fingerprint (matching on stable option IDs instead of option names) if
  confirmed, but is not required for the fingerprint to work correctly today.
- Whether `POST /v1/databases` genuinely accepts a `{type: "workspace",
  workspace: true}` parent (documented for page creation, not for database
  creation) — needed only if the manual-selection fallback ever needs to
  create its own parent page instead of using a user-selected one.

## Rejected approaches

- **Matching databases by title.** Rejected outright — titles are the first
  thing a non-technical user edits; the whole point of duplicating a fixed
  template is that the schema, not the title, is authoritative.
- **Assuming tokens never expire and doing nothing further.** Rejected —
  the documentation does not support that certainty (see §4). Accepting the
  write-through posture as-is is still correct, but pretending token
  invalidation can't happen is not; a recovery path must exist.
- **Requiring manual database creation as the primary path.** Rejected as
  the default — it requires the user to locate or create a parent page
  themselves, which reintroduces exactly the "click through and it just
  works" friction the product is designed to avoid. Kept only as the
  documented fallback for when duplication doesn't apply.

## References

- <https://developers.notion.com/reference/create-a-token>
- <https://developers.notion.com/reference/refresh-a-token>
- <https://developers.notion.com/reference/introspect-token>
- <https://developers.notion.com/reference/revoke-token>
- <https://developers.notion.com/docs/authorization>
- <https://developers.notion.com/guides/get-started/authorization>
- <https://developers.notion.com/guides/get-started/preparing-for-users>
- <https://developers.notion.com/guides/get-started/personal-access-tokens>
- <https://developers.notion.com/guides/get-started/handling-api-keys>
- <https://developers.notion.com/guides/mcp/build-mcp-client>
- <https://developers.notion.com/reference/get-block-children>
- <https://developers.notion.com/reference/retrieve-a-database>
- <https://developers.notion.com/reference/retrieve-a-data-source>
- <https://developers.notion.com/reference/property-object>
- <https://developers.notion.com/reference/create-a-database>
- <https://developers.notion.com/reference/create-a-data-source>
- <https://developers.notion.com/reference/capabilities>
- <https://developers.notion.com/reference/post-page>
- <https://developers.notion.com/reference/request-limits>
- <https://developers.notion.com/reference/status-codes>
- <https://developers.notion.com/reference/versioning>
- <https://developers.notion.com/docs/upgrade-guide-2025-09-03>
- <https://developers.notion.com/docs/working-with-databases>
- <https://developers.notion.com/page/changelog>
- <https://developers.notion.com/openapi.json>
