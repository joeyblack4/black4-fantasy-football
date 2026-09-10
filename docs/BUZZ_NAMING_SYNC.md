# Owner-chosen franchise names in Buzz

Status: local reconciliation and operator handoff implemented; inspected 2026-09-08 UTC. No live reconciliation or profile write has been issued by this implementation. Current provider/setup labels are temporary; they are not owner-authored franchise names.

The permanent displayed name is exactly `Team Name - Model Name`. `Team Name` comes from the real owner's committed `brand` action (`franchise_brand_versions.payload.name`), after a live model activation. `Model Name` comes from the active provider manifest's verified model identity, using a pinned catalog display name if available and its exact model slug otherwise. A serving provider name must not be substituted for a model name. The owner chooses the team name; the model suffix is controlled by the runtime's actual assignment. Keep runtime IDs, team IDs, pubkeys and harness config paths stable when names change.

## Supported commands and their limits

The installed `/Users/joey/.local/bin/buzz` exposes:

- `users get --pubkey HEX`: read the identity's kind-0 profile.
- `users set-profile --name DISPLAY_NAME`: write the current signing identity's display name. `--name` is one argument value; execute using an argument array with `shell: false` and the franchise's protected managed credential.
- `agents draft-update --channel UUID --agent-name CURRENT_NAME --display-name DISPLAY_NAME`: open an owner-reviewed edit form. This requires the owner's signer and does not save a change until the owner saves the form. It is not an autonomous agent rename operation.

Source verification: `crates/buzz-cli/src/commands/users.rs` in the inspected Buzz checkout implements `set-profile` as read/merge/write of a kind-0 profile. It preserves picture, about and nip05, then calls the profile builder with username `None`. It does not preserve arbitrary profile extensions. Therefore, do not assume that command safely preserves managed-agent metadata or that changing kind-0 updates the separate owner-managed agent definition. `agents draft-update` addresses the owner-managed definition, with explicit Desktop save semantics.

## Narrow synchronization design

1. Consume a committed real `brand.saved` receipt and the active manifest ID/version. Reject synthetic brand history, missing activation, a foreign league/team, a changed football owner, or an unverified managed pubkey. The exact community is `wss://black4fantasysports.communities.buzz.xyz`.
2. Build the desired display name, reject control characters and unsupported length, and retain the source brand receipt and manifest version. Serialize by league/pubkey. A model upgrade schedules a new version of the suffix without changing the team identity.
3. Read the current profile and managed-agent definition. If the display name already matches, record an observed no-op. If the CLI's limited merge would discard existing fields, hold for a profile-preserving supported update path. Do not overwrite the profile blindly.
4. Persist an outbox operation keyed by `(league, pubkey, brand receipt, manifest version)` before dispatch, containing only public identity/name fields. Send using the franchise's managed credential only after the preservation/managed-name behavior has passed a canary. There are no new LLM calls in this transport worker.
5. Store the returned event receipt, independently read back the same pubkey and require the intended displayed name. Track accepted and observed separately. On timeout or crash, read back and reconcile; never blindly repeat an uncertain profile write. Keep the old observed name for rollback.
6. Verify in Buzz Desktop that both message author labels and the managed-agent list show `Team Name - Model Name`. A successful kind-0 read alone does not prove both surfaces changed. Until that is verified, report the profile and managed-agent labels separately, and use owner-reviewed `draft-update` for the latter if required.

The next naming canary should use one newly provisioned league identity after its real owner has chosen a name. It must first inspect its current metadata and test the exact installed/deployed behavior. Public launch materials should show temporary names as setup labels until that canary and the real owner decision exist.

## Implemented operator interface

`src/franchise/names.ts` exports `FranchiseNames`, backed by migration `030_franchise_names.sql`. Only an authenticated commissioner scoped to the same league can call it. The module performs no network calls, shell execution, MFL writes, or publication.

- `reconcile(actor, { teamId, channelId })` loads the latest brand and requires its exact delivered franchise-outbox receipt, completed non-canary owner job, verified provider generation and activated source manifest. A brand written directly through the API is insufficient. It verifies the real football community, managed pubkey, owner relationship and private-channel membership. It changes only `league_teams.name`, preserving every routing ID. One immutable receipt per brand/active-manifest pair records the previous local name and source versions. Concurrent repetitions have one effect; detected local name drift is explicit.
- `prepareBuzzHandoff(actor, { receiptId, observedPubkey, currentManagedName, profileReference })` rechecks current sources and returns an argument array for the supported owner-signed `agents draft-update` command. The caller must first inspect the managed profile, match its pubkey, and confirm the current name uniquely identifies it in the football channel. The argument array is not executed by this module. The resulting form requires Desktop Save. Joey has authorized the rename once a real owner brand exists; this is an execution step, not a new permission request.
- `attestBuzzReadback(actor, { receiptId, pubkey, profileName, managedName, profileEventId, managedReadbackReference })` records exact matching profile and managed-list names as an **operator attestation**. It does not claim automated verification. Inspect both surfaces after saving, and retain the kind-0 event ID plus the managed-profile readback reference. A changed brand, model assignment or identity invalidates old handoffs/readbacks.

The application limit is 200 JavaScript string units for the complete name, with no control/bidirectional-format characters and no silent truncation. This is an application policy, not a verified native Buzz maximum. Current manifests do not store catalog-friendly labels, so the suffix uses the exact canonical model slug (or the assigned model slug when no canonical slug exists). A model upgrade creates a new reconciliation receipt; an old owner-authored brand remains usable with its original provider provenance.

Tests in `tests/franchise-names.test.ts` use isolated synthetic database rows and never contact Buzz or a model. They cover forged/direct brand provenance, commissioner scope, community/channel constraints, concurrent replay, name validation, stale versions, and mismatched profile readback. Passing these tests is not a live naming canary. Local team-name synchronization also does not rename an MFL franchise; that external host name requires its own supported operator update/readback.
