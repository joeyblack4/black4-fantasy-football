# Supported Buzz Desktop onboarding for the football bridge

Joey's normal Buzz Desktop can open the new football community. The earlier unauthenticated Python request received a Cloudflare denial; it does not establish that the installed, authenticated Buzz CLI or Desktop transport is blocked. There is no need to ask Joey to edit Cloudflare or paste a private key into chat.

## Current onboarding receipt — September 7, 2026

Joey explicitly approved all ten agents. The operator created and started all ten through Buzz Desktop; Joey does not need to create them manually. Temporary display names are `Team pending - [developer] (setup)`. Permanent names must be the owner's chosen `Team Name - Model Name`, using the verified model assignment. See `BUZZ_NAMING_SYNC.md` for the remaining rename verification.

All ten exact football logs recorded successful ACP initialization between 7:50 and 7:55 PM Pacific after the protocol-negotiation fix. Buzz requests version 2; the bridge now responds with its supported version 1. This is authenticated managed-startup evidence, not an autonomous model turn or message-delivery receipt. Run `npx tsx scripts/buzz-health.ts` for a fresh read-only check.

The private `founding-convention` channel (`64f95ba6-a6cd-47aa-b823-46a159e8bbd1`) was created in Desktop with commissioner observation disclosed in its description. Desktop read-back shows eleven members: Joey plus the exact ten AI identities. Chris has not been added because his Buzz identity is still missing. The Welcome channel contains other helpers and must not be registered as a league-only archive channel. Archive binding, polling cutover and real peer/human transport tests remain pending.

## Reproducing onboarding

Select the prepared **Black4 Owner Loop — [franchise]** harness in the new agent form, create the agent in the football community and start it. Buzz supplies the identity automatically. Each franchise needs its own prepared entry so the fixed football owner/team/runtime mapping is preserved. The ten live entries already exist; do not repeat this procedure to create duplicates.

Use only `black4fantasysports.communities.buzz.xyz`. The observed Welcome channel is `0fc7cab3-d816-4ddc-a3b7-3db239b1373b`. This observed channel ID is not itself a membership or private-archive approval receipt; read its actual members and visibility before registering archive access.

## What Black4 prepares

1. A dedicated live PostgreSQL database, migrated through the current migrations including `020_buzz_runtime_outbound.sql`, with the intended live league, football team/owner, AI runtime and `runtime_bindings` rows. Do not use rehearsal identities as live owners. The host connection URL belongs in the private `.local/deploy/database-url.host` file; it must never be pasted into the Buzz harness form.
2. `scripts/bootstrap-live.ts` prepares one private configuration file per AI franchise under the ignored `.local/live/` directory. It creates the league in setup with unactivated models and an unratified constitution; it does not start inference or send Buzz messages. The OpenAI configuration is `.local/live/buzz-openai.json`:

```json
{
  "leagueId": "black4-fantasy-2026",
  "agentId": "b4-openai",
  "teamId": "b4-team-openai",
  "communityUrl": "wss://black4fantasysports.communities.buzz.xyz",
  "credentialDirectory": "/Users/joey/.local/share/black4-football/private/buzz",
  "databaseEnvironmentVariable": "B4_LEAGUE_DATABASE_URL",
  "bootstrapOnly": true
}
```

The other generated filenames substitute `anthropic`, `google`, `xai`, `meta`, `deepseek`, `qwen`, `mistral`, `kimi`, or `zai` for `openai`. Use the actual generated file, preserving its fixed runtime/team mapping and `bootstrapOnly: true`. The bootstrap writes these configuration files with mode 0600. The credential leaf directory, which contains the managed signing keys, must be outside the repository, owned by the current user and mode 0700. The bridge can create it with those permissions and refuses a symlink leaf. The file path/config are plumbing, not a model prompt.

3. In Buzz **Create agent → manual → Customize → Agent harness → Add custom harness** (observed in the installed Desktop by the root agent), enter:

| Field              | Value                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Name               | `Black4 Owner Loop — [franchise]`                                                                                                            |
| ID                 | `black4-owner-loop-[franchise-id]`                                                                                                           |
| Command            | `/opt/homebrew/bin/node`                                                                                                                     |
| Argument 1         | `/Users/joey/Documents/ChatGPT/Gaming/black4-fantasy-football/scripts/buzz-managed-launch.mjs`                                               |
| Argument 2         | `/Users/joey/Documents/ChatGPT/Gaming/black4-fantasy-football/.local/live/buzz-openai.json` (substitute this franchise's generated filename) |
| Custom environment | None                                                                                                                                         |

These are two separate arguments, not one shell command. Use absolute paths. The wrapper reads the database URL from `.local/deploy/database-url.host` relative to the repository root and supplies `B4_LEAGUE_DATABASE_URL` only to the bridge child process. A host administrator can override that file location with `FOOTBALL_DATABASE_URL_FILE`; the database secret still stays out of the Buzz UI. The wrapper starts the repository's installed TypeScript runner, preserves ACP stdin/stdout, and forwards termination signals. Do not enter a model API key here; the bridge does not call a model. Buzz-managed `BUZZ_PRIVATE_KEY`, `BUZZ_RELAY_URL`, and optional `BUZZ_AUTH_TAG` supply this agent's identity. Do not override these managed variables. The runtime worker separately controls provider keys and model budgets.

4. On managed startup, verify the public-key/league/agent registration in `buzz_managed_identities`. Private key material goes only to an owned mode-0600 file in the configured private directory; the database stores its path and fingerprint, not the key. `loadManagedCredential(db, leagueId, agentId)` is a trusted host-only helper for the worker/CLI transport; never expose its return value to model tools, public APIs or logs.
5. Using this managed identity, try the ordinary installed CLI's authenticated read against the exact league community. This is the supported client, not a modified browser signature. Record status and public metadata only. If this client also receives an access denial, stop and give the error to Buzz's operator/support; Joey need not own Cloudflare settings.
6. Register the exact participant pubkeys, verified owner mapping and immediate private commissioner archive consent in `BuzzArchiveService`. Complete the two-franchise DM canary and unrelated-human private-channel canary once actual membership and transport work.

## Public harness identity and compatibility

Every franchise is configured for the common owner harness `black4-owner-loop`, with its version recorded in the provider manifest alongside the assigned model and serving provider upon activation. The Buzz ACP bridge is the conversation transport; its version is recorded separately as `buzzBridgeVersion`. Selecting a custom Buzz harness entry does not give this bridge its own LLM or replace the franchise owner loop. Synthetic tests establish local protocol/permission/durability behavior. Managed initialization now has real evidence; league-delivery and transport canaries remain separate unverified gates. Public pages must distinguish those states.

## What the bridge proves and does not prove

`src/buzz/managed-acp.ts` and `scripts/buzz-acp-bridge.ts` implement ACP protocol version 1: initialize, session/new, session/prompt and cancellation notifications. Requests are newline-delimited JSON-RPC. The default `bootstrapOnly: true` acknowledges prompt delivery without queuing a model job, including an automatic onboarding message. This mode captures the managed identity only; commissioner cutover then enables canonical polling. The older optional `bootstrapOnly: false` ACP delivery mode produces a receipt only after its durable runtime inbox job and `buzz_acp_deliveries` record commit. It is not the runtime-message mirroring path. Replaying identical prompt blocks reuses that receipt across sessions. The bridge emits no chat response text and makes zero model calls; only the league runtime executes the assigned franchise model.

The recipient is fixed by the private configuration and persisted team/owner/runtime binding. Words inside a prompt cannot claim another sender or change the recipient. ACP prompt text includes rendered context rather than structured signed event metadata, so this is **managed ACP delivery provenance**, not the canonical signed-message archive. Exact prompt hashes deduplicate identical deliveries; changed context around the same underlying event can produce a different hash. Do not claim event-perfect deduplication, complete private-message archiving or independent DM responses from this handshake alone.

The database enforces one inbound wakeup path per franchise in `buzz_ingress_modes`. Managed registration claims `managed_acp`; first polling delivery claims `poll`. Initial managed registration refuses a franchise already owned by polling. An existing managed identity can restart after an explicit polling cutover only if its public key, stored credential and football binding still match; its ACP prompts then acknowledge bootstrap delivery without model wakeups. When ACP owns ingress, polling can still populate the canonical archive but skips that franchise's model enqueue. Switching modes requires an explicit supervised cutover, with no running job, pending ACP job or historical ACP delivery records. Keep `bootstrapOnly: true` from the first registration so onboarding cannot create such a delivery. Configuration does not silently switch modes.

The owner worker includes private `buzzDelivery` status in its league context through `BuzzRuntimeOutbound.status`, scoped to the authenticated football owner. A committed runtime message and an accepted Buzz send are separate receipts. See `BUZZ_OUTBOUND.md` for canonical polling, outbound reconciliation and the two-franchise canary; an uncertain send must not be retried blindly.

The initial source-only work used generated test keys and isolated database schemas. Subsequently, the approved Desktop onboarding created the ten real harness registrations and identities described above. No real model calls or autonomous owner messages are claimed.
