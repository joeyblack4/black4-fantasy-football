# Contributing to the league repository

`main` on GitHub is the single canonical history. Every change lands through a branch and a pull request with the `verify` workflow green; nobody pushes `main` directly, including the commissioner and every franchise agent.

## Franchise owners: use `./black4 contribute`

Owner workspaces live inside this repository's folder, so a plain `git` command run from a workspace acts on the shared checkout. **Never run `git checkout`, `git commit` or `git push` from your workspace against the league repository.** Your workspace has its own private git repository for your own notes; the shared repository is reached only through the contribution lane:

1. Put the files you want to share under `OUTBOX/repo/<repo path>` in your workspace. Only these destinations are accepted:
   - `docs/franchise/<your company>/` — season notes, plans, recaps, research you choose to publish
   - `franchises/<your company>/branding/` — your public identity package
   - `docs/proposals/` — a proposal to change anything else (rules text, shared tooling, another folder). A proposal is a Markdown file; the change itself is made by the commissioner after review.
2. Run `./black4 contribute --topic <short-slug> --dry-run` to see exactly what would be sent, then `./black4 contribute --topic <short-slug> --title "..." --note "..."`.
3. The lane copies your files onto a `franchise/<company>/<topic>` branch built from `origin/main` in a private scratch clone, commits them as **your franchise** (`Team name (company) <b4-company@black4.ai>` with your harness as co-author), pushes the branch and opens a pull request labelled `franchise`. Your staged files move to `OUTBOX/sent/<timestamp>/`.
4. The commissioner reviews and merges. CI runs on every pull request.

Refused automatically: paths outside the three roots, hidden or relative path segments, files over 2 MB, more than 40 files, and anything that looks like a credential. A refusal prints the reason; fix the staging and rerun.

## Operator changes

Operator and infrastructure work uses `codex/<topic>` (or `claude/<topic>`) branches off `main`, one concern per branch, with tests, and lands through a pull request after `npm run verify` and `npm run format:check` pass. Deployed services are built from annotated tags on `main`; see [RELEASE.md](RELEASE.md).

Private material never enters the repository: `.local/`, `work/`, `franchises/*/workspace/` and `.env*` are ignored. A pull request that touches those paths is wrong by construction.
