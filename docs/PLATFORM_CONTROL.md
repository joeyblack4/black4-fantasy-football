# Black 4 from Fantasy: the Black 4 MCP

Every owner reaches Black 4 the same way any agent does: through the Black 4
MCP (`black4`, `https://api.black4.ai/mcp`), already configured in your own
harness. It is signed in as the Fantasy Football customer, so it reaches only
the Fantasy Football business (`business-fantasy-football`) and never another
customer or Black 4's own platform administration. There is no local helper,
courier, skill folder or provider key for Black 4 on this Mac.

## Skills

Black 4's methods for the league live in Platform Control. Call
`list_skills` with `businessId: "business-fantasy-football"`. That list is the
only source of Black 4 skills. When a listed skill's description fits your
task (for example `fantasy-lineup-decision` before a start/sit choice), load it
with `get_skill` before you start, read the files it lists with
`get_skill_file`, and follow it. Pass your own name as `agent` and your model
as `model`, so the receipt shows who loaded which version. An empty list means
no skill is turned on, not permission to use another source.

## League tools

`discover_business_tools` shows Fantasy Football's connections (for example
its X and Meta accounts and Google Analytics through Treg), their read/write
access and selected resources. Call a connection with `call_provider`, and Treg
tools with `treg_search` and `treg_call`. Business publishing and purchases
follow Fantasy Football's configured policies; changes that need a person go
to Reviews (`start_review`), where people decide. Never use local credentials
or another route to get around a refusal, a pending review or a missing
connection: report it.

## When the MCP is unavailable

If the `black4` server is missing, asks you to sign in, or refuses, say so once
in your conversation and continue your football work without it. Joey signs
the harness in again (`node scripts/mcp-sign-in.mjs <owner>` on the Fantasy
Mac). Do not paste tokens or keys anywhere.

## Operator setup

`scripts/native-harness.mjs` writes the `black4` entry into each owner's own
harness config on every start (`scripts/black4-mcp.mjs`, server in
`config/black4-mcp.json`). Each harness keeps its own OAuth sign-in in its own
franchise home; no token is shared or copied between owners. Joey signs each
owner in once with `node scripts/mcp-sign-in.mjs <owner>`, as
joeysterling22@gmail.com, never as Black 4 staff. No channel-bound header is
sent: a customer sign-in reaches one business only.
`node scripts/platform-control-workspaces.mjs --install` removes the retired
`platform-control` link from every workspace and keeps this guide linked.
