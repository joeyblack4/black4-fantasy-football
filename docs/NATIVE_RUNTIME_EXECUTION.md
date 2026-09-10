# Native runtime execution status — September 8, 2026

> Historical setup/draft record. Preserved evidence below describes its dated phase and does not impose current holds. The production draft is complete; use [SEASON_OPERATIONS.md](SEASON_OPERATIONS.md) for regular-season authority and tools.
> The roster is fixed: seven company harnesses, Meta and DeepSeek on Goose, Z.ai on OpenCode. Native cognition stays native. Black4 provides league state, actions, events, receipts and spending records. Production draft actions remain held.

## Built locally

- Ten v3 franchise workspaces with the fast-and-loose owner charter.
- Repo-local Codex/Claude ACP adapters, Gemini CLI, Grok Build, Qwen Code, Kimi Code, OpenCode, Vibe and Goose executables. npm dependencies are pinned in tooling/package-lock.json. Vibe 2.25.0 is installed under .local/tooling; Goose copied from the existing local installation without credentials.
- Thin ACP client: sessions, requested lead selection, streaming, native-friendly tool permissions and cancellation. Synthetic tests only.
- Worker cancellation propagation and late/unknown cost preservation.
- Independent actual cash and reference usage accounting. Reference estimates are reporting only.
- Run `npm run harness:doctor` for filesystem inventory. It deliberately does not claim authentication or working model access.

## Remaining implementation, in order

1. Connect repo-local native processes to ACP with per-franchise auth/state, process shutdown and restartable sessions.
2. Connect each existing Buzz franchise identity/channel to its native session and Black4 league MCP tools; prevent duplicate delivery.
3. Connect native usage events and provider/subscription evidence to the existing cash ledger and spend caps. No automatic paid fallback.
4. Authenticate each selected route, confirm its exact lead model, and demonstrate a real Buzz reply and league-state read.
5. Exercise stop/restart, duplicate messages and exhausted spending; retire mandatory generic cognition for migrated franchises.

Installed tools and synthetic tests do not mean the fleet is running. Native production routing has not been activated.

## Joey can unblock in parallel

- Google: https://aistudio.google.com/apikey — create a dedicated Black4 Football project/key. Enable billing if the selected model requires it. Documentation: https://ai.google.dev/gemini-api/docs/api-key
- Meta: https://dev.meta.ai/ — sign in and check whether the account has model API access and can create a key for Muse Spark. Ordinary Meta login does not establish this; access is currently unverified.
- xAI: https://console.x.ai/ — create/access the developer account and API key; its quickstart requires credits for API use. Confirm Grok 4.6 availability. Documentation: https://docs.x.ai/developers/quickstart
- Kimi: https://platform.kimi.com/ — check existing API access or create the account. Kimi Code also supports its own subscription login. Documentation: https://moonshotai.github.io/kimi-code/en/guides/getting-started.html
- Mistral: https://chat.mistral.ai/ — account access for Vibe, with Code > Vibe CLI key setup if needed. Documentation: https://docs.mistral.ai/vibe/code/cli/api-keys-profiles
- Codex/Claude: retain existing subscriptions; provide tier names and complete local login when the isolated runtime login is ready. Do not buy duplicate API plans yet.
- DeepSeek/Qwen/Z.ai: try the existing OpenRouter provision first; exact model compatibility still needs a native turn. No new account purchase yet.
- MiniMax: no action; not in the selected roster.

Keep keys in local credential setup, not chat or tracked files. Account availability and model access remain unverified until authenticated.

## Google account update

The existing Black 4 Fantasy League key is saved in ignored local credentials (owner-only file permissions), bound to B4_LEAGUE_NATIVE_GOOGLE. Google model listing authenticated successfully and returned models/gemini-3.8-flash. AI Studio shows Tier 1 Prepay for project gen-lang-client-0855809837. No generation call has run. Exact dated canonical mapping and a native Gemini CLI turn remain unverified.

AI Studio billing read-back: $50 credit balance, auto-reload ON, $250 billing account tier cap. The $50 balance is not a hard total-spend ceiling. Billing settings were not changed.

## xAI account update

Existing console.x.ai key saved in ignored owner-only local credentials as B4_LEAGUE_NATIVE_XAI; runtime environment binding is XAI_API_KEY. Authenticated model listing succeeded and includes grok-4.6. No generation call or native Grok Build turn has run; console shows $50.00 balance; runtime billing caps remain unverified. This is xAI model access, separate from the X social API.

## Setup blockers resolved or identified

- Kimi: platform.kimi.com redirected to the Chinese login. Official international platform https://platform.kimi.ai loads in English; its login offers email/code or Google. Left open for Joey to complete account setup. No key obtained.
- Mistral: chat.mistral.ai/work returns a workspace permission 403, but https://chat.mistral.ai/code/extensions works in the same account. Generate API Key is enabled; monthly usage shows 0.00% and says usage stops at the quota. Left open for Joey to generate the key. No subscription purchase needed to reach this page; exact lead access remains unverified.
- Meta: existing Muse Code subscription key is listed, but Create API key is disabled. Billing shows no pay-as-you-go payment method and says one is required to start building with Model API. This is a likely cause, not a verified diagnosis of the disabled button. Left billing open. No payment settings or existing key changed.

## Meta subscription billing clarified

Verified in signed-in official documentation on September 8: https://dev.meta.ai/docs/muse-code/subscriptions. The subscription credential is for Muse Code only and the subscription works through the signed-in Muse Code CLI. Additional API keys are pay-as-you-go. Therefore the selected Meta + Goose runtime cannot be treated as included subscription usage. Keep the existing subscription unchanged; use a separate PAYG key for the accepted Goose roster, or explicitly revisit the deferred native Muse CLI bridge before claiming subscription support. No subscription key was extracted or repurposed; no billing changes made.

## Meta credential and Mistral plan decision

Meta: Joey explicitly authorized key creation. Black4 Fantasy League PAYG key created and saved privately as B4_LEAGUE_NATIVE_META (0600). Authenticated /v1/models succeeds and lists muse-spark-1.3 and its contributor variant. No generation call; Goose turn remains pending.

Mistral: signed-in monthly upgrade screen verifies Pro at $14.99/month with $30/month API credits and increased native Vibe access; Free includes $10/month credits. Recommend monthly Pro for the persistent native Vibe franchise, with PAYG disabled initially, no annual commitment. Docs confirm included allowance is used first and PAYG extends it; if disabled, usage stops at exhaustion. This is a recommendation, not a purchase or measured cost-savings claim. Track fixed fee separately from reference/token usage; verify selected model access with the actual account before claiming live operation. Sources: https://mistral.ai/pricing/ and https://docs.mistral.ai/admin/billing-usage/subscriptions . Monthly selection left open for Joey.

## Mistral subscription verified

Signed-in subscription screen confirms Pro Active, $14.99/month, separate $30 API/Studio and $300 Vibe Code monthly allowances, both currently unused. These are provider usage units, not cash. Both API PAYG and Vibe Code PAYG are disabled; auto-recharge disabled. Account UI is more specific than public shared-allowance prose. Billing invoice still says payment pending; do not equate active entitlement with settled invoice. Vibe credential generation and native model turn remain pending.

## Chris departure: proposed roster update

Joey reports Chris is out. Recommend retaining 12 teams: Joey plus 11 AI franchises, adding MiniMax M3 with first-party MiniMax Code. Official https://agent.minimax.io/docs/cli/features documents headless mcode exec, native mcode acp, session controls, MCP and Token Plan/API credential options. This better follows company-native preference than the previously considered MiniMax + OpenCode exception. Buzz compatibility is inferred from the ACP transport match, not verified live. No league/team ownership, scheduling or production database changes made. Existing 10-team alternative would require cutting one of the ten current AI entrants; no performance evidence presently justifies a cut.

Mistral continuation: browser handoff poll exited with BrowserSignInError (status could not be retrieved); no local credential saved. At read-back the original auth tab still displayed AI Studio Terms of Service. Pro Active was previously verified, but native authentication remains incomplete; do not claim Mistral setup complete based on subscription alone.

Mistral recovery completed: official Vibe browser authentication succeeded, credential stored privately as B4_LEAGUE_NATIVE_MISTRAL; authenticated model list includes mistral-medium-3.5. No model generation performed. MiniMax Code 0.3.10 installed repo-locally; authentication next.

MiniMax onboarding: signed-in account shows Token Plan not subscribed and subscription credits 0. MiniMax Code 0.3.10 installed. Isolated MCODE_CONFIG_DIR=.local/franchise-runtimes/minimax/.mcode; official global device login waiting for Joey on the Authorize screen, which accepts Terms. Do not purchase a Token Plan yet; investigate supported custom OpenRouter provider with the existing balance before adding spending. Authentication and MiniMax M3 inference still unverified.

MiniMax Code global login completed successfully. OpenRouter endpoint discovery confirms M3 tool support on several routes, including Minimax, while some routes lack tools. Configure a tool-capable route before native inference. OpenRouter franchise credential not yet configured; no generation calls. No MiniMax subscription purchase needed at this stage.

## Legacy runtime reset applied

All eleven ai.black4.football launchd services disabled; none was loaded at reset read-back. Twenty Buzz black4-owner-loop-* template/instance entries marked inactive with autostart and config-change restart off. Other managed agents preserved. Private rollback copies are in .local/legacy-reset. Community messages/channels were not deleted; these are historical records, not an active cognition path. New native entries have not yet been activated. Catalog now includes MiniMax Code; build passed. Spend work is separate under the latest principle.
