# Buzz deployment check and executable DM canary

Read-only inspection on 2026-09-07, public probes at 21:06:32 UTC (14:06:32 Pacific). No credentials, customer identity keys, authenticated queries, POST requests, community writes, messages, provisioning changes, or deployment mutations were used.

## Observed state

| Layer                           | Evidence                                                                                                  | Conclusion                                                                                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local source checkout           | HEAD `f815cc9b404fab30018f7eaf9df4ac4c061c7c17`, `/Users/joey/.codex/worktrees/buzz-black4-anyone-access` | Inspected source implements multi-community routing and operator endpoints; does not identify deployed code.                                                                                     |
| Installed desktop bundle        | Info.plist `CFBundleShortVersionString=0.5.20`, `CFBundleVersion=0.5.20`                                  | Bundle version verified. This does not prove bundled CLI/ACP source SHA or relay version.                                                                                                        |
| Installed `buzz` and `buzz-acp` | Both reject `--version`; CLI help verifies current command names                                          | No embedded source/build identity obtained. Do not equate bundle version with source HEAD.                                                                                                       |
| Public deployment               | Every unauthenticated request below returned Cloudflare HTTP 403                                          | Relay health, relay version, deployed source SHA and operator permission are UNKNOWN. This is an edge response, not evidence that the application route is unsupported or provisioning disabled. |

Probe receipt: `evidence/buzz-public-probe-2026-09-07.json`.

| Request                                       | Result                                                    |
| --------------------------------------------- | --------------------------------------------------------- |
| GET `/health`                                 | 403, Cloudflare, text `error code: 1010`                  |
| GET `/info`                                   | 403, Cloudflare, text `error code: 1010`                  |
| GET `/` with `Accept: application/nostr+json` | 403, Cloudflare problem JSON; no relay metadata obtained  |
| GET `/_liveness`                              | 403, Cloudflare, text `error code: 1010`                  |
| GET `/_readiness`                             | 403, Cloudflare, text `error code: 1010`                  |
| GET `/_status`                                | 403, Cloudflare, text `error code: 1010`                  |
| GET `/operator/communities`                   | 403, Cloudflare, text `error code: 1010`                  |
| OPTIONS `/operator/communities`               | 403, Cloudflare, text `error code: 1010`; no Allow header |

No request was retried with a forged User-Agent, alternate origin address, Host override or credential. A browser/approved deployment operator path may have different access; that remains unverified.

## Source routing and deployment findings

`crates/buzz-relay/src/router.rs` defines public `/health`, `/_liveness`, `/_readiness`, `/info`, and NIP-11 on `/`. The separate **health listener** defines `/_status` with version and intrinsic `build.source_sha`, `build.id`, `build.url`; it is not registered in the ordinary public API router. Therefore even an unblocked public `/_status` failure would not establish missing build identity. The authorized operator should inspect the health listener through the normal deployment path, not expose internal health networking for this test.

Source `/operator/communities` currently supports authenticated GET (list communities for an owner) as well as POST (provision). The GET requires `owner_pubkey` and operator authorization; our unauthenticated missing-query probe deliberately did not enumerate any owner. Provisioning still requires deployment-level `RELAY_OPERATOR_PUBKEYS`, independently of ordinary community owner authority. A 401/403/404/400 response alone would not prove successful authorization or provisioning.

`docs/deployment-identity.md` documents image digest/source attestation and `/_status` build identity. Generic Helm defaults permit digest-pinned relay images and shared infrastructure. `deploy/charts/buzz/templates/deployment.yaml` renders **RELAY_OWNER_PUBKEY** from `ownerPubkey`; that is not **RELAY_OPERATOR_PUBKEYS**. Additional operator allowlist configuration can be provided via `relay.extraEnv` or `extraEnvFrom`, but no live Black4 deployment values or operator grant were verified. No cluster secrets or environment files were read.

The source gate remains explicit: in a DM, only the owner or a cryptographically verified same-owner sibling can trigger an agent. An external human/differently owned agent cannot gain DM-trigger access merely through the explicit allowlist or `anyone`. The second human needs an approved private negotiation channel or a deliberately implemented peer-DM permission change. Agent-to-agent success cannot prove this human path.

## Prepared canary

`scripts/buzz-dm-canary.ts` is executable with `npx tsx scripts/buzz-dm-canary.ts`. Default behavior is **MOCK_ONLY**: constructs plans, invokes no CLI process, opens no database and sends no network request. This default was run during development. Its fake identities/conversation are explicitly synthetic; there is no reported peer reply.

Live mode is deliberately opt-in and was **not run**:

```text
npx tsx scripts/buzz-dm-canary.ts --execute-live --confirm-league-only --config /absolute/path/league-canary.json
```

A concrete live configuration must supply:

- Stable unique `runId` (reuse it when reconciling an interrupted attempt).
- Fresh league `communityUrl`; the script refuses the existing `black4.communities.buzz.xyz` customer community.
- Absolute Buzz executable path.
- `freshLeagueCommunity`, `ownershipMetadataVerified`, `receiverAlreadyListening`, each true only after independently established.
- `agentA` and `agentB`, each with distinct pubkey, same verified ownerPubkey, `ownershipEvidenceEventId`, and dedicated `keyEnvironmentVariable` (name must begin `B4_LEAGUE_`); optional similarly scoped `authTagEnvironmentVariable`.
- Explicit `DATABASE_URL` for the league receipt store, already migrated.

Example non-secret configuration shape:

```json
{
  "runId": "replace-with-stable-run-id",
  "communityUrl": "wss://NEW-LEAGUE-HOST",
  "executable": "/absolute/path/to/buzz",
  "freshLeagueCommunity": true,
  "ownershipMetadataVerified": true,
  "receiverAlreadyListening": true,
  "agentA": {
    "pubkey": "REPLACE_WITH_VERIFIED_64_HEX_A",
    "ownerPubkey": "REPLACE_WITH_VERIFIED_64_HEX_OWNER",
    "ownershipEvidenceEventId": "REPLACE_WITH_VERIFIED_PROFILE_EVENT_ID",
    "keyEnvironmentVariable": "B4_LEAGUE_A_KEY",
    "authTagEnvironmentVariable": "B4_LEAGUE_A_AUTH_TAG"
  },
  "agentB": {
    "pubkey": "REPLACE_WITH_VERIFIED_64_HEX_B",
    "ownerPubkey": "REPLACE_WITH_VERIFIED_64_HEX_OWNER",
    "ownershipEvidenceEventId": "REPLACE_WITH_VERIFIED_PROFILE_EVENT_ID",
    "keyEnvironmentVariable": "B4_LEAGUE_B_KEY",
    "authTagEnvironmentVariable": "B4_LEAGUE_B_AUTH_TAG"
  }
}
```

The script opens a DM as A through the existing adapter, independently reads B's DM membership and requires exactly A+B, sends one stable-idempotency canary as A, and looks for a matching ACK authored by B for up to sixty seconds. It does **not** script B's response: the separately running B agent must react. A relay reply alone still needs independent model identity, cost, author-gate and runtime execution receipts. The ownership evidence fields are a required trusted-preflight assertion, not a replacement for cryptographic profile verification.

## Next real canary prerequisites

1. Authorized deployment operator obtains current relay build/source identity and confirms the new-community provisioning grant, DNS/TLS route and shared-deployment availability.
2. Provision one isolated league tenant with `create_only:true` through the authorized process; read back tenant identity and verify cross-community isolation.
3. Create two dedicated league identities, verify same-owner delegation and give them no customer tools or secrets. Start B on persistent remote infrastructure with an independently verified model and small permitted budget.
4. Run the explicit live canary above, retain relay + runtime receipts, then test a restart between receipt and reply and a self-created appointment. Do not interpret mock output as this evidence.
5. Separately verify the second human negotiation path; current DM hardening remains a real limitation until changed or deliberately addressed with private channels.
