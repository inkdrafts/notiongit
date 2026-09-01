# Notion OAuth template duplication

This experiment validates the *logic* the onboarding backend needs once a
user has authorized Notion: walking from a duplicated template page down to
its two child databases, and telling the "Pages" database apart from the
"Posts" database by schema instead of by title (titles are the first thing a
non-technical user renames).

It does **not** call the live Notion API and contains no real tokens,
workspace IDs, or user data — every fixture is synthetic and prefixed
`SYNTHETIC-`. See [`docs/decisions/0002-notion-onboarding.md`](../../docs/decisions/0002-notion-onboarding.md)
for what was verified against Notion's current API documentation, what could
not be verified in this session (a live consent-screen click-through requires
a human with a browser and a disposable Notion workspace), and the resulting
go/no-go decision.

## What's here

- `src/identify-databases.mjs` — schema-fingerprint matching: given a
  database's `properties` map (name → Notion property type), decide whether
  it's the Pages database, the Posts database, neither, or ambiguous. Never
  guesses between two plausible matches; callers must treat `ambiguous` /
  `unrecognized` as a hard provisioning failure.
- `src/walk-template.mjs` — paginated walk from a page's block children to
  the `child_database` blocks underneath it (a `child_database` block's `id`
  *is* the database id per Notion's block reference — no extra lookup step).
- `src/validate-oauth-response.mjs` — structural validation of a
  `POST /v1/oauth/token` response against the documented field shape.
- `fixtures/` — synthetic, redacted example payloads: an OAuth token
  response, a block-children listing, and three database schemas (Pages,
  Posts, and an unrelated database to prove the matcher doesn't false-positive
  on a workspace that already has other content).
- `test/` — `node:test` unit tests exercising all of the above, including the
  full pipeline (block children → child database ids → resolved Pages/Posts
  roles) and negative cases (missing database, duplicate database, decoy
  schema overlap).

## Running

From the repository root:

```sh
npm ci
npm test
```

Or directly in this workspace:

```sh
cd spikes/notion-oauth-template
node --test test/
```

## What this does NOT prove

Running these tests proves the *matching and traversal logic* is correct
against schemas shaped the way Notion's API documents them. It does **not**
prove that:

- Notion's consent screen actually offers to duplicate a configured template
  for a public OAuth integration, or that the token response actually
  contains `duplicated_template_id`, in practice, today.
- Notion access tokens behave as assumed with respect to expiry/revocation.

Those two questions are the load-bearing, previously-flagged-as-unverified
claims this issue exists to resolve. They are addressed in the ADR through
current official documentation research (with adversarial re-verification),
not through a live click-through — this automated session has no browser and
no Notion account to register a public integration or authorize a consent
screen with. See the ADR's "Not verified in this session" section for the
explicit follow-up this leaves for a human.
