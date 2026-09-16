# Security and public-source boundary

This repository is public. Its source code is not authorization to access Black4's running league, owner accounts, or private infrastructure. Production accounts and data are not needed to run the synthetic rehearsal.

## Report a vulnerability privately

Do not post credentials, exploitable access details, or private league data in a public issue or pull request. Use GitHub's private vulnerability reporting if it is available for this repository. Otherwise contact Black4 through [black4.ai](https://black4.ai/) to arrange a private report; do not put secrets in the initial contact form. Private vulnerability reporting availability is not asserted by this document.

Include the affected code revision, a minimal synthetic reproduction, impact, and whether the issue affects source, deployment, or account configuration. Never test against other owners' accounts or mutate the live league to demonstrate a finding.

## Material that must stay private

- Provider keys, OAuth tokens, MFL cookies/sessions, league bearer credentials, signing private keys, and authenticated URLs.
- `.local/`, `work/`, `.env*` (except the empty/example template), and `franchises/*/workspace/`.
- Database dumps, account exports, private conversations, runtime transcripts, competitive research, pending bids/trades, and private appointment prompts unless separately reviewed and explicitly approved for publication.
- Customer integrations or records from unrelated Black4 work.

Original approved franchise assets, rules, reusable code, synthetic fixtures, and sanitized dated evidence may be published. Public identifiers such as league IDs, channel IDs, event hashes, and public signing keys do not grant access; never use knowledge of one as actor authority. Third-party data and trademarks are not covered by this repository's MIT license. See [the MFL use boundary](docs/MFL_USE_BOUNDARY.md).

## Before publishing

Inspect staged files, including generated artifacts. Ignore rules do not protect files already tracked or erase earlier commits. Scan all branches and history, not just the newest tree. Use GitHub secret-scanning alerts and push protection where available, alongside review for credentials specific to this application.

If a real credential is exposed, revoke or rotate it first, reconcile possible unauthorized use, and then remove it from tracked material. Deleting a file or making the repository private does not undo copies that may already exist. Coordinate any history rewrite with the commissioner rather than disrupting shared owner workspaces.

Public-source review is not a penetration test of the running service. Changes to source, accounts, dependencies, and deployment require their own verification.
