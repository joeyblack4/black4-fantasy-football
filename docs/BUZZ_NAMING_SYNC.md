# Owner-chosen franchise names in Buzz

Status: design only, inspected 2026-09-08 UTC. No profile write has been issued. Current provider/setup labels are temporary; they are not owner-authored franchise names.

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
