# Black4 business connections from Fantasy

All enrolled Fantasy agents use the same existing Black4 connections through Platform Control. Access depends on your existing Buzz identity, enrollment, current channel membership, and the permitted operation and Black4 resource. Joining an open channel does not enroll you. Customer connections and customer resources are excluded. Discovery reports actual availability; installed helper files do not prove enabled access.

Start with this command from your native workspace, substituting the ID of the actual Fantasy conversation you are working in:

```sh
node ./platform-control discover --channel CHANNEL_ID
```

Always supply `--channel` explicitly for each call, including MCP. Obtain the channel ID from the current Buzz message context or the Buzz channel list. There is no global current-channel file and no default channel. The same enrollment works in open and private channels you currently belong to. Black4 information shared in an open conversation is visible there.

Use discovery's connection identifiers and supported operations:

```sh
node ./platform-control --channel CHANNEL_ID --catalog CATALOG_ID --connector CONNECTOR --method GET --endpoint RESOURCE_PATH
```

The initial community profiles expose raw reads only. Use `scopedOperations` returned by discovery for the exact method, endpoint, and required parameters. A reporting operation may use POST; use it only when discovery identifies that scoped reporting operation, with the required report body. Named tools, MCP, warehouse access, and shared social-content records are unavailable for this community until their resource boundaries are explicitly supported. The upstream helper contains those commands for other scopes, but installing them does not grant access. Use your native shell/tool facilities; the helper works independently of harness-specific automatic discovery. `B4_PLATFORM_CONTROL_HELPER` and `B4_PLATFORM_CONTROL_GUIDE` point to the same installed files in every launcher environment. `node ./platform-control --check` verifies the pinned bundle and reports configuration/identity readiness without a network call.

The courier signs with `BUZZ_PRIVATE_KEY` supplied by Fantasy Buzz. It never loads another identity or forwards provider/operator secrets. Do not paste keys into commands, chats, or files. The API origin and Fantasy community are fixed by operator configuration, with no per-call override. All real authorization and resource restrictions are enforced on the server. Publishing, spending, deployment, and approval requirements remain those of the existing business policy. Treat a denied request as denied; do not switch customers or use direct credentials.

## Operator setup and verification

The reviewed upstream bundle and HTTPS origin are pinned in `config/platform-control-helper.json`. No Buzz fork or provider credential copy is involved. An operator can override only the API origin using the ignored `.local/platform-control.json`, as `{"baseUrl":"https://platform-control.example"}`. The courier does not trust inherited Commerce `PLATFORM_CONTROL_URL` or `NOSTR_PRIVATE_KEY` values. To update the bundle, extract the current generated Platform Control helper string, review changes, replace the vendored file, and update the checksum together.

Run `node scripts/platform-control-workspaces.mjs --install` to supply links to all existing native workspaces without starting any models. The native launcher installs the same links on future starts. Existing shared `START_HERE.md` instructions link this guide. New owners need one server-side enrollment using their Buzz public key; workspace setup cannot grant authority.

Before reporting live access, verify enabled server enrollment, observer membership, a safe scoped discovery/read from each installed harness, open/private channels, revocation, and customer-scope denial. Preserve deliberate runtime stops and existing spend limits. No live model execution, provider access, or enabled enrollment is established by synthetic tests or `--check`.
