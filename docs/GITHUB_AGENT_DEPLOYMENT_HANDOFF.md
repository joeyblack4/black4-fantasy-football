# Handoff: align Fantasy agent editing with Commerce

Status: implementation handoff

Prepared: September 17, 2026

Target repository: `joeyblack4/black4-fantasy-football`

## Assignment for the next Codex agent

Make the eleven Fantasy franchise agents as easy to update through GitHub as
the six Commerce agents, while preserving the Fantasy league's separate Mac,
native harnesses, private owner workspaces, league scheduling, model
assignments, credentials, and current in-season work.

Do not design a new deployment system. Finish and document the one that already
exists in `joeyblack4/black4-agents`.

Before changing anything, read:

1. this repository's `AGENTS.md`;
2. `docs/DEPLOYMENT_TOPOLOGY.md`;
3. `docs/NATIVE_FLEET_LIVE.md`;
4. `docs/NATIVE_SCHEDULING.md`;
5. `docs/SEASON_OPERATIONS.md`; and
6. the root `README.md` and `AGENTS.md` in `joeyblack4/black4-agents`.

## Desired operator experience

```text
Codex, Cursor, Claude, or GitHub editor
                  │
                  ▼
     edit black4-agents or black4-skills
                  │
          validate and push main
                  ▼
      league Mac checks every minute
                  │
                  ▼
 existing Buzz identities receive the change
                  │
                  ▼
       verify a real response in Buzz
```

Humans should not need to locate the league Mac's live agent folders, edit them
over SSH, or run a release-manager process for an ordinary instruction or skill
change.

## State found during this handoff

Verified directly on the league Mac on September 17, 2026:

- The production machine is separate from the development workstation.
- All eleven Buzz owner workers were running.
- LaunchAgent `ai.black4.agent-deploy` was installed, healthy, and scheduled
  every 60 seconds.
- Its deployment receipt reported the current GitHub revisions for
  `black4-agents` and `black4-skills`.
- `black4-agents` already contains all eleven Fantasy agent definitions,
  `targetMachine: "fantasy"` settings, exact Buzz identities, model bindings,
  workspace mappings, and the trusted Fantasy manifest.
- The deployed agent reconciler reads `origin/main` snapshots. The working
  checkout itself may remain behind even while deployed files are current.
- The eleven live instruction files were managed by the reconciler.
- The league Mac had the required Git, Node 22, npm, Python, uv, Codex, Claude,
  and GitHub CLI tools.

This means GitHub-to-Mac agent deployment is already operating. The task is to
make it complete, symmetric, safe to develop from, and accurately documented.

## Important gaps and contradictions

### 1. The live guide is stale

The league Mac's `START HERE.md` and
`black4-agents/machines/fantasy/START-HERE.md` still say updates are manual,
host-only, and not automatically synchronized. That is no longer true.

Commerce already deploys Git-managed workspace guidance from:

```text
black4-agents/machines/commerce/workspace/
```

Fantasy has no equivalent managed workspace directory yet, so the stale guide
survives even though automatic deployment is active.

### 2. The installed Fantasy reconciler is older than the repository version

The running reconciler predates the current shared implementation. It deploys
`ABOUT.md`, `INSTRUCTIONS.md`, and skills, but it does not yet deploy the full
supported `agent.json` configuration or Git-managed workspace guidance.

Do not simply overwrite it and assume parity. Review the current shared
reconciler's restart behavior first. Fantasy native harnesses load shared skills
at owner-turn start, so a skill-only change should not automatically terminate
eleven unrelated in-flight owner turns. Agent instruction or runtime-setting
changes still require the existing safe Buzz apply-and-verify path.

### 3. The source checkouts are clean but behind their remote branches

The reconciler correctly deploys archives from `origin/main`, but the local
`AgentDefinitions` and `SkillDefinitions` branches are behind. As a result,
`scripts/check-dev-ready.sh` fails its push dry-run even though production files
are current.

If those checkouts are clean, fast-forward them explicitly. Do not reset or
replace a dirty checkout. Decide whether to retain the compatible legacy paths
or move them to the shared `.system/sources/` layout only after an exact
before/after canary.

### 4. The production Fantasy Football checkout is dirty

The league Mac's `Black4/Fantasy/Repository` was at the same commit as
`origin/main`, but it contained material modified, deleted, backup, and
untracked runtime work. The development workstation also has substantial
uncommitted Fantasy work.

Treat every existing change as owner or production work. Do not run `reset`,
`clean`, mass checkout, broad deletion, or automatic `git pull` there. Capture
an inventory and recoverable snapshot before deciding which changes belong in
Git, quarantine, runtime state, or a separate branch.

Agent-definition deployment and full Fantasy application deployment are
separate problems. Finish agent-definition parity without making the dirty
production application checkout auto-update.

## Ownership model to preserve

| State | Canonical owner |
| --- | --- |
| Portable owner identity and instructions | `joeyblack4/black4-agents` |
| Reusable shared methods | `joeyblack4/black4-skills` |
| League source, rules, common owner charter, and application code | `joeyblack4/black4-fantasy-football` |
| Private owner work and memory | Each owner workspace on the league Mac |
| Live Buzz identity, start, stop, restart, and native execution | Buzz on the league Mac |
| Football truth and transactions | MyFantasyLeague through the authenticated league interface |
| Durable owner-selected appointments and receipts | The existing Fantasy scheduler and PostgreSQL state |
| Credentials, model accounts, and provider state | Their existing private machine or provider owners |

Do not copy private owner workspaces, credentials, transcripts, schedules,
databases, pending bids, trades, or runtime memory into `black4-agents` or
`black4-skills`.

## Required implementation

### A. Make Fantasy workspace guidance Git-managed

Add the Fantasy equivalent of the Commerce managed workspace files:

```text
black4-agents/machines/fantasy/workspace/AGENTS.md
black4-agents/machines/fantasy/workspace/START-HERE.md
black4-agents/machines/fantasy/workspace/AGENTS-README.md
```

The guide should state:

- GitHub `main` is the editing source for portable definitions and skills;
- the league Mac is the runtime;
- the Mac checks for valid changes every minute;
- live identities and private owner workspaces remain local and are preserved;
- an ordinary instruction change restarts through the existing Buzz apply path;
- a skill-only change becomes available to later owner turns without restarting
  unrelated owners;
- common league rules and source belong in this repository, not in an agent
  prompt; and
- a live Buzz response—not a PID alone—proves an agent update works.

Replace or retire `machines/fantasy/START-HERE.md` so it cannot compete with the
managed guide.

### B. Bring the Fantasy reconciler onto one reviewed shared implementation

Use the reconciler in `black4-agents` as the source. Preserve these
Fantasy-specific rules:

- validate the exact trusted eleven-identity manifest;
- reject new or identity-changing folders before touching the runtime;
- deploy `ABOUT.md`, `INSTRUCTIONS.md`, and supported `agent.json` fields;
- deploy only declared heartbeat files when an owner intentionally has one;
- deploy shared skills without deleting private runtime state;
- deploy managed workspace guidance;
- do not deploy `black4-customers` to the Fantasy Mac;
- restart only when the changed input requires it;
- verify all eleven workers and their exact instruction bindings after a
  restart; and
- write one honest deployment receipt naming the Git revisions and changed
  files.

Do not add another daemon or scheduler. Continue using
`ai.black4.agent-deploy` and the existing Buzz apply command.

### C. Restore a genuinely development-ready source checkout

On the league Mac, after proving each source checkout is clean:

1. fetch its remote;
2. fast-forward the local branch to `origin/main`;
3. run `black4-agents/scripts/check-dev-ready.sh`;
4. fix only demonstrated missing tools or authentication;
5. prove `gh`, Git fetch, and push dry-run without publishing a test commit; and
6. retain the one-minute deployer's use of immutable `origin/main` snapshots.

Being able to deploy from the remote is not the same as being able to develop
and push from the machine. Prove both separately.

### D. Keep Fantasy scheduling separate from deployment

Do not copy Lucky's Commerce customer-work heartbeat onto all Fantasy owners.
Fantasy already has two distinct wake mechanisms:

- native harness/session scheduling; and
- owner-controlled durable appointments in the league scheduler.

Preserve owner autonomy: no default cadence, lineup choice, waiver check, or
shared tactical prompt. A future periodic owner heartbeat must be an explicit
league design decision with cost, football-deadline, duplicate-action, and
receipt semantics—not a side effect of Git deployment parity.

### E. Document ordinary edits and new identities

Document these paths clearly:

- Existing owner instruction: edit
  `black4-agents/agents/fantasy/<owner>/INSTRUCTIONS.md`.
- Existing owner runtime setting: edit only supported `agent.json` fields.
- Shared method: edit one canonical skill in `black4-skills`.
- League-wide rule or interface: edit `black4-fantasy-football`.
- New owner identity: create and verify it through Buzz first, then add its
  portable definition and trusted manifest entry. Git must not invent a live
  identity.

## Safe execution order

1. Inventory both current dirty worktrees and the live deployment receipt.
2. Back up only the exact files that will change.
3. Update `black4-agents` validation and Fantasy workspace guidance.
4. Test the reconciler against a temporary fixture or dry-run copy.
5. Install the reviewed reconciler on the league Mac without changing any
   agent definition.
6. Confirm a no-change run reports `current`, all eleven workers remain up, and
   no owner workspace, schedule, credential, or model binding changed.
7. Push one harmless instruction marker for one owner, let the one-minute poll
   apply it, and verify that exact owner gives a real Buzz response reflecting
   the change.
8. Revert the marker through GitHub and verify the second deployment.
9. Push one harmless skill canary and prove a later owner turn can use it
   without an unnecessary eleven-owner restart.
10. Update this repository's topology and fleet documentation with the final
    receipts and remaining limitations.

## Acceptance tests

Do not call this complete until all are true:

- `black4-agents/scripts/verify.sh` passes for 11 Fantasy and 6 Commerce
  definitions.
- The league Mac passes `scripts/check-dev-ready.sh` from a clean,
  fast-forwarded checkout.
- The installed reconciler hash matches the reviewed repository version.
- A no-change poll reports the current agent and skill revisions.
- A GitHub instruction change reaches one exact owner within the documented
  poll interval.
- The existing Buzz identity, pubkey, model, runtime profile, and workspace are
  unchanged.
- The intended owner produces a real response using the new instruction.
- The Git revert reaches the same owner.
- A skill-only update does not restart unrelated in-flight owners.
- All eleven workers remain correctly bound after a required restart.
- Private workspaces, schedules, credentials, conversations, football state,
  and production application changes are byte-for-byte or semantically
  unchanged outside the exact canary.
- The live `START HERE.md` accurately names GitHub as the editable source and
  the league Mac as the runtime.

## Explicit non-goals

- Do not clean or auto-deploy the dirty production Fantasy application
  checkout as part of this task.
- Do not merge or publish unrelated workstation changes.
- Do not create a release-manager process.
- Do not add a second file-sync system, scheduler, identity registry,
  credential store, or agent-memory service.
- Do not place private owner state in Git.
- Do not standardize the eleven owners' strategies, native tools, or schedules.
- Do not interpret running processes as proof of model execution.

## Final handoff format

Report these separately:

1. repository commits and whether they reached `main`;
2. installed league-Mac revisions and reconciler hash;
3. files changed on the league Mac;
4. whether Buzz restarted, and why;
5. eleven-worker and exact-binding verification;
6. real owner response evidence;
7. skill-only no-restart evidence;
8. preserved dirty-work inventory and recovery location; and
9. anything still configured but not demonstrated end to end.

Use the words `configured`, `deployed`, `delivered`, `started`, `completed`, and
`football-state verified` precisely. Missing evidence is `UNKNOWN`, never a
successful assumption.
