# InkDrafts Notion template

This is the sanitized build sheet for the single public Notion template used
by the InkDrafts connection. It contains no workspace IDs, private content, or
credentials. Build the page in a disposable workspace first, then make that
page public so it can be configured as the connection's optional template.

The root page must contain the two database blocks as direct children. The
provisioning walk starts at the duplicated root page and recognizes those
blocks by their schemas, not by their titles. Users may rename either database
after duplication without breaking identification.

## Root page

Use the title **InkDrafts starter site**. Add these blocks in this order:

1. A callout: **Welcome to your InkDrafts site** — “Publish a page by setting
   its Status to Published. Publish a post by setting its Status to Published
   and adding a Publish Date. The connected GitHub Action syncs published
   content to your site.”
2. A heading: **Getting started**.
3. Bullets:
   - Edit the example Pages and Posts rows or create your own.
   - Keep `Slug` unique and URL-safe; it becomes part of the generated URL.
   - Use external image URLs. Notion-hosted file URLs expire.
   - Leave `Status` as Draft while editing, then change it to Published.
4. A heading: **Pages** followed by the Pages database block.
5. A heading: **Posts** followed by the Posts database block.
6. A heading: **Field guide** followed by:
   - Pages `Type` values: `home`, `blog-list`, `blog`, or `markdown`.
   - `Show in Nav` controls whether a page appears in the site navigation.
   - `Nav Order` sorts navigation items; lower numbers appear first.
   - Posts `Tags` is a multi-select field and `Featured` enables the featured
     flag in generated front matter.

The two database blocks must be children of the root page, not merely links to
databases elsewhere in the workspace. Keep exactly one Pages database and one
Posts database in this root template. Extra databases are allowed in the
workspace, but not as additional matching databases under this root.

## Pages database

The database title may be **Pages**. The title is only a friendly default and
is not part of the runtime identity. Create these properties with these exact
names and types:

| Property | Notion type | Required options/defaults |
| --- | --- | --- |
| `Title` | Title | — |
| `Slug` | Rich text | — |
| `Type` | Select | `home`, `blog-list`, `blog`, `markdown` |
| `Nav Order` | Number | Number format |
| `Show in Nav` | Checkbox | — |
| `Status` | Select | `Draft`, `Published` |
| `Description` | Rich text | Optional |
| `Name` | Rich text | Optional |
| `Profile Picture` | Rich text | Optional; external URL |
| `Tagline` | Rich text | Optional |
| `Social Links` | Rich text | Optional; one `Name: URL` per line |

Create these synthetic guidance rows. They are intentionally generic and may
be edited or deleted by the user:

| Title | Slug | Type | Nav Order | Show in Nav | Status | Guidance |
| --- | --- | ---: | ---: | --- | --- | --- |
| Welcome | `home` | `home` | 0 | No | Published | Replace this row's content and profile fields with your own. |
| About this site | `about` | `markdown` | 10 | Yes | Draft | Add an about page, then publish it when ready. |
| Blog | `blog` | `blog-list` | 20 | Yes | Published | This page lists published Posts. |

The `Welcome` row may use `example.com` for any sample external URL. Do not
put a maintainer's real profile, social account, or email address in the
template.

## Posts database

The database title may be **Posts**. As with Pages, the title is not used for
runtime identity. Create these properties with these exact names and types:

| Property | Notion type | Required options/defaults |
| --- | --- | --- |
| `Title` | Title | — |
| `Slug` | Rich text | — |
| `Status` | Select | `Draft`, `Published` |
| `Publish Date` | Date | — |
| `Tags` | Multi-select | — |
| `Description` | Rich text | Optional |
| `Cover Image` | Files & media | Prefer an external URL |
| `Canonical URL` | URL | Optional |
| `Featured` | Checkbox | Optional |

Create these synthetic guidance rows:

| Title | Slug | Status | Publish Date | Tags | Guidance |
| --- | --- | --- | --- | --- | --- |
| Welcome to InkDrafts | `welcome-to-inkdrafts` | Published | A current date | `guide` | Replace this sample with your first post. |
| Draft your first post | `first-post` | Draft | A current date | `draft` | Use Draft while writing; publish when ready. |

The sample body of `Welcome to InkDrafts` should explain that the user can
replace the row, edit its properties, and publish it by changing `Status`.
It must not contain personal or workspace-specific content.

## Schema version

This template is version **1**. Its required runtime fingerprint is the
intersection of the required properties below:

- Pages: `Slug` rich text, `Type` select, `Nav Order` number, `Show in Nav`
  checkbox, and `Status` select.
- Posts: `Slug` rich text, `Publish Date` date, `Tags` multi-select, and
  `Status` select.

The full field lists above are the engine contract source for future template
updates. If a required property is renamed or its type changes, increment the
template schema version and update the sync engine contract and resolver in a
separate change before changing the public template.

## Onboarding validation

The Notion callback validates the database schema before the GitHub connection
can begin. The runtime-required fields are the fingerprint fields listed
above. `Title`, `Description`, and the Pages home-profile fields are optional;
the sync engine has documented name aliases and defaults for them. Optional
fields are still rejected when present with the wrong Notion type.

The Pages `Type` select must contain `home`, `blog-list`, `blog`, and
`markdown`. Both `Status` selects must contain `Published` (the template also
ships `Draft`). Additional select values are rejected when the engine cannot
interpret them. Validation failures identify the affected database and list
missing properties, wrong types, or unsupported options with instructions to
fix that database in Notion. No rows, page body content, tokens, or private
workspace metadata are read for this check.
