# Provisioning admission runbook

Use this runbook to pause or reject new site provisioning during an abuse or provider incident. The control is stored in the `JOBS` KV namespace and the Worker reads it before every provisioning stage.

## Authenticate as an operator

Use a Cloudflare identity that can read and write the Worker environment and its `JOBS` namespace.

```sh
wrangler login
```

Use the repository's pinned Wrangler binary when the shell is not already using the project toolchain:

```sh
spikes/libsodium-workers/node_modules/.bin/wrangler kv key list --binding JOBS --remote --env staging
```

Do not add an HTTP admin endpoint. The control record contains no application credential, but changing it still requires Cloudflare operator access.

## Activate the global kill switch

Write `kill` to stop every new provisioning stage and pause queued work before it mints a provider token or makes a provider mutation.

```sh
wrangler kv key put "provisioning:admission:control" '{"version":1,"mode":"kill","pausedStages":[],"rejectedStages":[],"updatedAt":1725408000000,"expiresAt":null}' --binding JOBS --remote --env staging
```

Replace `1725408000000` with the current epoch time in milliseconds. Repeat the command with `--env production` when production also needs to stop.

New requests return a fixed provisioning error code and a retry hint when one is available. Existing queue messages are saved as `paused`, unlocked, and delayed. They do not mint an installation token, consume the global mutation budget, or call GitHub while the switch is active.

## Pause work without rejecting the flow

Use `pause` when the incident is temporary and you want queued jobs to resume from their current step after rollback.

```sh
wrangler kv key put "provisioning:admission:control" '{"version":1,"mode":"pause","pausedStages":[],"rejectedStages":[],"updatedAt":1725408000000,"expiresAt":null}' --binding JOBS --remote --env staging
```

Use `active` with stage lists to pause one part of the pipeline. Stage names are `github_connect`, `github_callback`, `github_repository`, `notion_callback`, `notion_secrets`, `queue_verify_repository`, `queue_patch_config`, `queue_configure_pages`, `queue_dispatch_sync`, `queue_await_sync`, `queue_await_deploy_build`, and `queue_verify_deploy`.

```sh
wrangler kv key put "provisioning:admission:control" '{"version":1,"mode":"active","pausedStages":["queue_dispatch_sync"],"rejectedStages":[],"updatedAt":1725408000000,"expiresAt":null}' --binding JOBS --remote --env staging
```

Use `rejectedStages` when new work at a stage must receive a refusal. Queued work at that stage still pauses so an operator can clear the control and resume it.

## Resume provisioning

Clear the KV control record after the incident is resolved. Paused jobs remain in KV and their delayed queue messages re-evaluate the control before the next provider call.

```sh
wrangler kv key put "provisioning:admission:control" '{"version":1,"mode":"active","pausedStages":[],"rejectedStages":[],"updatedAt":1725408000000,"expiresAt":null}' --binding JOBS --remote --env staging
```

The configured environment variables also support a persistent default. Change them in `wrangler.toml` and deploy the Worker when the control must survive a KV record rollback.

## Inspect the audit records

List recent admission audit keys, then read an exact record.

```sh
wrangler kv key list --binding JOBS --remote --prefix "provisioning:admission:audit:" --env staging
wrangler kv key get "provisioning:admission:audit:<jobId>:<stage>:<reason>" --binding JOBS --remote --text --env staging
```

Audit values contain only the job id, optional numeric account id or HMAC request digest, stage, decision, reason, and timestamps. The Worker deduplicates repeated pauses for the same job, stage, and reason. Records expire after seven days by default. The request digest is not reversible to the network address by this service.

## Roll back safely

Use this order during an incident:

1. Write `kill` if provider traffic is still growing.
2. Read the admission audit records and the existing provisioning events.
3. Check GitHub and Notion provider status before changing limits.
4. Write `active` with empty stage lists when the provider is healthy.
5. Confirm that a paused job advances from its recorded step and that no completed step runs again.

Do not delete repositories, revoke tokens, disable GitHub Actions, or change deployed repositories as part of this runbook. The Worker controls only new provisioning traffic. Deployed sites continue to run their own Actions workflows independently.

## Change the automated limits

Set these variables in `wrangler.toml` or the deployment environment:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `PROVISIONING_ACCOUNT_ATTEMPT_WINDOW_SECONDS` | `86400` | Per-account attempt window |
| `PROVISIONING_ACCOUNT_ATTEMPT_LIMIT` | `3` | Identified attempts allowed in the window |
| `PROVISIONING_REQUEST_BURST_WINDOW_SECONDS` | `60` | Privacy-preserving request window |
| `PROVISIONING_REQUEST_BURST_LIMIT` | `10` | Requests allowed in one network-prefix bucket |
| `PROVISIONING_DENIED_IDENTITY_COOLDOWN_SECONDS` | `3600` | Hold time for suspended or provider-denied identities |
| `PROVISIONING_ADMISSION_AUDIT_TTL_SECONDS` | `604800` | Audit record retention |

The Worker rejects invalid values during configuration parsing. It bounds every accepted value so a configuration error cannot widen the documented limits.
