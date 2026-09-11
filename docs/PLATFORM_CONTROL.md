# Black4 business connections from Fantasy

Every enrolled Fantasy agent uses the same managed Black4 business connections through Platform Control, inheriting the configured Black4 policies. Access still requires your existing Buzz identity, enrollment, current membership in the requested channel, and a permitted operation on a verified Black4 resource. Joining an open channel does not enroll you. Other customers' connections and resources remain outside this authority, including customer resources reachable by a shared provider credential.

Start from your native workspace, using the ID of the actual Fantasy conversation you are working in:

```sh
node ./platform-control discover --channel CHANNEL_ID
```

Always supply `--channel` for each call. Obtain it from the current Buzz message context or the Buzz channel list. There is no global current-channel file or default channel. Enrollment works across open and private channels where both your current membership and Platform Control's observer access can be verified. Missing observer access is an infrastructure blocker to report with the channel ID. The operator completed 24 private-stream observer invitations on September 11, 2026; every request still checks current membership. Direct-message channels have fixed membership and cannot admit the observer through the current relay, so use an authorized stream for integration requests. Black4 information shared in an open conversation is visible there.

## Discover the current authority

Use the live discovery response for connection identifiers, resource boundaries, allowed operations and approval policies. `scopedOperations` describes the resource rules and action policy; endpoint availability also follows the existing transport rules. Only `examples` and copyable commands are examples for constructing a request, not an exhaustive tool list or a separate permission grant. A connected tool may still be blocked by resource verification, provider authentication, subscription/credit limits or missing channel access. Report the actual status and error code; do not describe a listed connector as successfully tested.

The managed path supports raw requests and native named tools where the server advertises them:

```sh
node ./platform-control --channel CHANNEL_ID --catalog CATALOG_ID --connector CONNECTOR --method GET --endpoint RESOURCE_PATH
node ./platform-control --channel CHANNEL_ID --catalog CATALOG_ID --connector CONNECTOR --tool TOOL_NAME --arguments '{"argument":"value"}'
```

Use `--params` for JSON query parameters and `--body` for a JSON request body. LinkedIn requests also require `--connection CONNECTION_ID` from discovery, including its managed media prepare/transfer operations. A reporting operation may use POST without changing business data; follow the operation's server policy. For provider writes, preserve the exact intended payload and use a stable `--idempotency-key` when supported. MCP, warehouse and shared social-content commands are usable only when current discovery exposes their authorized surface and resource boundary. Inherited business permission does not make an unsupported transport or unverified resource safe to use.

## Approvals and execution results

Automatic operations run under the existing Black4 policy. Operations marked approval-required use Platform Control's existing approval record. An HTTP 202 response with `approval.status: "pending"` and `approval.receiptId` means the request is waiting; it is not provider execution, even if the helper exits successfully. Preserve the receipt ID and exact request for operator review. A denial or missing approval interface is a blocker, not a reason to submit the same action through another route.

After the operator approves that request, retry the same catalog, channel, operation, parameters and body with `--approval-receipt RECEIPT_ID`. For MCP, pending approvals appear as JSON-RPC error `-32003` with the receipt in `error.data.approval`; resend the exact `tools/call` message, including its JSON-RPC ID and arguments, after approval. The helper attaches the receipt only to `tools/call`, never to initialization, notifications or tool discovery. The receipt belongs to the requesting identity and exact request; the server rechecks current policy, membership, expiry and prior use. Do not automatically replay a pending request or treat approval as proof of execution. Report completion only from the execution result and its receipt. If the result is uncertain, read back the intended provider object before considering a retry.

## Use the managed connection

Use your native shell/tool facilities; the helper works independently of harness-specific automatic discovery. `B4_PLATFORM_CONTROL_HELPER` and `B4_PLATFORM_CONTROL_GUIDE` point to the same installed files in every launcher environment. `node ./platform-control --check` checks the pinned bundle and local identity/configuration readiness without a network call.

The courier signs with `BUZZ_PRIVATE_KEY` supplied by Fantasy Buzz. It never loads another identity or forwards provider/operator secrets. Do not paste keys into commands, chats or files. The API origin and Fantasy community are fixed by operator configuration. Use Platform Control for Black4 integrations; do not load local provider credentials, reuse another customer's binding, or call the provider directly to bypass a denial, pending approval or unsupported managed operation. Native research, local development and independent football decisions remain available under the owner charter.

No new spending, subscription, publishing or deployment permission is created by installing the helper. Those actions follow the inherited Black4 policy and Joey's current instructions. Report provider credit/authentication failures without changing billing or credentials on your own.

## Operator setup and verification

The upstream bundle and HTTPS origin are pinned in `config/platform-control-helper.json`. No Buzz fork or provider credential copy is involved. An operator can override only the API origin using the ignored `.local/platform-control.json`, as `{"baseUrl":"https://platform-control.example"}`. The courier does not trust inherited Commerce `PLATFORM_CONTROL_URL` or `NOSTR_PRIVATE_KEY` values. To update the bundle, extract the current generated Platform Control helper string, review changes, replace the vendored file and update the checksum together.

Run `node scripts/platform-control-workspaces.mjs --install` to supply links to all existing native workspaces without starting models. The native launcher installs the same links on future starts. Shared `START_HERE.md` instructions link this guide. New owners need one server enrollment using their existing Buzz public key; workspace setup cannot grant authority.

Verify current discovery, membership, a scoped provider read and the relevant approval/denial paths before reporting live access. Preserve deliberate runtime stops and existing spend limits. Tests and `--check` establish helper readiness; signed API receipts establish the operations actually exercised. Keep pending observer access, unsupported resources and provider failures explicit.
