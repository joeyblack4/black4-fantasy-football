# Fantasy Git-managed deployment — completed handoff

Verified September 17, 2026, America/Los_Angeles (September 18 UTC).

Fantasy now uses the same GitHub editing model as Commerce: authorized teammates
edit portable definitions or shared skills, validate, commit, and push main.
The existing one-minute poller applies valid changes on the appropriate Mac.

## What to edit

| Change                                                            | Canonical source                                        | Destination                     |
| ----------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------- |
| Fantasy owner instructions                                        | `black4-agents/agents/fantasy/<owner>/INSTRUCTIONS.md`  | Fantasy Mac only                |
| Commerce agent instructions                                       | `black4-agents/agents/commerce/<agent>/INSTRUCTIONS.md` | Commerce Mac only               |
| Supported owner configuration                                     | The same folder's `agent.json`                          | Assigned Mac only               |
| Shared method                                                     | `black4-skills/.agents/skills/<skill>/SKILL.md`         | Both Macs, full library         |
| Fantasy workspace guidance                                        | `black4-agents/machines/fantasy/workspace/`             | Fantasy Mac                     |
| League rules, native harness integration, owner tools, scheduling | `black4-fantasy-football`                               | Separate application deployment |
| Private owner work, sessions, and memory                          | Existing native workspace/runtime                       | Stays on its owning Mac         |

A GitHub source checkout can contain both fleet directories; that does not run
both fleets on either machine. The trusted local machine designation selects
only its fleet. A Fantasy-only change normally yields a Commerce no-change
check. Fantasy does not fetch or deploy customer records.

The small owner folders are intentional: they contain portable maintained
inputs, not the owner's accumulated work. Existing Buzz identities, model
assignments, native harnesses, private workspaces, credentials, and appointments
remain attached to their current owners.

## Daily workflow

1. Update a clean development checkout from main; keep experiments in a separate
   branch or worktree, never the deployed inputs.
2. Edit the intended files. For agents, run `scripts/verify.sh` and
   `python3 -m unittest discover -s tests`. For skills, run `npm test`.
3. Commit only the intended change and push main. Direct main pushes remain the
   normal workflow. Integrate concurrent changes and rerun checks if a push is
   rejected; never force-push shared main.
4. Inspect the target Mac's deployment receipt, then verify the intended owner
   through its existing Buzz identity. A successful push or PID alone is not a
   completed model response.

Ordinary source editing does not require production SSH. On-machine development
readiness is independently verified; being able to fetch for deployment is not
proof that a teammate can push.

## Installed behavior

- The existing `ai.black4.agent-deploy` remains on a 60-second interval. It uses
  immutable Git revisions and does not pull or clean the Fantasy application.
- The reviewed shared reconciler validates applicable definitions, guides, and
  skills before active writes. Failed apply commands do not become success.
- Fantasy deploys `ABOUT.md`, `INSTRUCTIONS.md`, `agent.json`, managed guides,
  and only explicitly declared heartbeat files. No owner heartbeat was added.
- Identity, model, native profile, workspace, enabled, response mode, and
  parallelism remain fixed validated bindings. Optional declared heartbeat
  settings are the supported variable runtime fields in this version; copying
  a new model name is not an implemented model migration.
- Fantasy instruction/runtime changes use the existing whole-Fantasy-Buzz
  quit/apply/reopen path. Skill-only and reference-guide changes do not restart
  Fantasy owners. Stopped owners or unrelated active identities defer restart
  before changing files; the helper no longer disables unrelated identities.
- Commerce's installed reconciler and apply helper were not replaced. Its
  existing skill-change fleet restart behavior was observed and retained.
- Machine guides now name GitHub as the editing source. Owner ABOUT references
  no longer prescribe manual host edits.

## Published source and deployed revisions

| Repository      | Revision                                   | Meaning                                           |
| --------------- | ------------------------------------------ | ------------------------------------------------- |
| `black4-agents` | `b741791e1a8be8d58f38b4d58f61811cba3b82f5` | Parity implementation, tests, guides, and roadmap |
| `black4-agents` | `201d363507c53451729ff621913552f24a956584` | Temporary one-owner instruction canary            |
| `black4-agents` | `c1f5a9bf6ef65cea2c2c396dc677c11917829f8f` | Canary reverted; final deployed agent revision    |
| `black4-skills` | `b635170b7f293b2816a56dd21dda79140424c76d` | Temporary shared-skill canary                     |
| `black4-skills` | `8810ba3bc05c218899483e27135e139f3ec4c5e9` | Canary reverted; final deployed skill revision    |

All these commits reached main. The shared skill's final content is restored to
its original bytes. Documentation in this repository is not an application
release to the league Mac.

Installed Fantasy reconciler SHA-256:
`09e1db55621209f4df5dd9f386aebc335b3405544383be952b6be4519d267c86`.
Installed Fantasy apply helper SHA-256:
`97ae5692f50f5bd9da7dd6c3c20e5661ac4ad9eefe2f0f46a076ae09a5c80fe0`.
Both match the reviewed repository files.

## Verification receipts

- Local validation passed for six Commerce and eleven Fantasy definitions;
  ten deployment tests passed. GitHub Actions passed for implementation and
  instruction-canary commits. Skills validation passed eleven tests and 33 skills.
- The Fantasy source checkouts were clean and fast-forwarded in place.
  `check-dev-ready.sh` passed, including tools, GitHub CLI authentication as
  `joeyblack4`, fetch, agent push dry-run, and read-only runtime checks. The skills
  push dry-run also passed. Its existing read-only SSH fetch key remains in use;
  developer pushes use the authenticated HTTPS route.
- Initial configuration/reference/guide deployment changed no Fantasy worker
  PIDs. The instruction canary changed exactly one owner's instructions and
  restarted the Fantasy fleet. All eleven exact native bindings verified.
- Signal Callers returned the unique token from its updated instruction file in
  a private operator-created test channel. After Git revert, it reread the file
  and confirmed the temporary section was absent. Replies were authored by the
  original OpenAI Buzz identity, not scripted owner messages.
- Commerce recorded no changed files for the Fantasy instruction revision;
  all six Commerce worker PIDs remained unchanged during that canary.
- The shared skill canary reached both Macs. Signal Callers read its new token
  on a later turn. All eleven Fantasy PIDs stayed unchanged across both the
  skill update and its revert. Commerce restarted under its existing policy.
- Both Macs byte-verified all 191 published files across 33 skills with zero
  mismatches. Final receipts reported `current`, empty changed-file lists, and
  the final agent/skill revisions above.
- The dirty production application's HEAD/status and all 525 inventoried source
  files were unchanged. All 6,414 inventoried private workspace/credential files
  were unchanged. Managed identity/model/harness/start settings were unchanged;
  only normal last-started/updated timestamps changed after required restarts.
- PostgreSQL read-back found 45 durable appointments, zero newly created or
  updated appointments, and zero schedule commands during the verification
  window. No football transaction was requested by any canary.
- Temporary instruction and skill markers were reverted through Git. The
  private canary channel was archived with its evidence retained.

These tests establish deployed files, exact runtime bindings, and completed
native responses for the tested owner. They do not claim a fresh response from
all eleven models, a football-state change, a reboot recovery test, or a
performance/load benchmark of the poller.

## Recovery locations and scope

Private inventories, exact pre-change backups, per-stage receipts, message
read-backs, and preservation reports are retained on each Mac under
`~/Black4/.system/deployments/fantasy-parity-20260918/`.
The developer workstation retains isolated worktrees and evidence under
`~/Black4/Operations/fantasy-git-parity-20260918/`.
Do not commit raw private backups, credentials, or workspace contents.

The production Fantasy application checkout was not cleaned, reset, or updated.
Existing workstation changes were preserved in place; implementation used clean
worktrees. Content rollback is a Git revert. Deployment-helper recovery restores
only scoped files from the pre-install backup, never old databases or owner work.

## Deferred roadmap

1. GitHub Actions-triggered deployment over the private network, with lightweight
   recovery checks instead of full one-minute reconciliation.
2. Consistent skill-only no-restart behavior on both Macs, managed skill removal,
   and rollback support.
3. A unified deployment-status command and streamlined teammate onboarding.
4. Broader private-state recovery coverage and retirement of obsolete
   runtime-to-Git publishing utilities.

No new deployment service, default owner schedules, shared football strategy,
spending limits, subscriptions, or customer workflow was introduced.
