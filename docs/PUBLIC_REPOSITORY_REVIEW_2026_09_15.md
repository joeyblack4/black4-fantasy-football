# Public repository review — September 15, 2026

## Conclusion

No exposed real credential was identified by this review. Keeping the reusable source public is reasonable on the evidence checked, subject to the limitations below. This is a bounded source/history review, not a security certification or a penetration test of the running league.

Reviewed public `origin/main`: `28bab5413b4d033b29535f9d171e4970392d6e94`, freshly fetched. The public main history contains 29 commits and its current tree contains 533 files. GitHub's unauthenticated repository page confirmed public visibility. Remote branches and tags were enumerated, and the scan also included local/backup references rather than excluding older work.

## Checks and findings

- A local pattern-based review scanned 771 unique reachable Git blobs, approximately 10.3 MB, across all locally available references (45 unique commits at review time). Binary blobs were not searched as text. Patterns covered common provider/GitHub/cloud key formats, private-key headers, long bearer values, credential-bearing URLs, literal secret assignments, Black4 `b4ff_` credentials, JWTs, native signing/age secret formats, and selected session/OAuth assignments.
- Flagged candidates were local CI/container database passwords, synthetic test credentials, or placeholder/private-file references. The provider-shaped key in the contribution test is an intentionally invented alphabet/numeric fixture. No actual key, session cookie, private signing key, or OAuth credential was identified. No credentials were tested against providers.
- No owner `workspace/`, `.local/`, real `.env`, private key file, or `credentials.json` was found in the enumerated historical paths. `.env.example` supplies an empty provider-key field and a credential-free local database URL. Ignore rules exclude private workspaces, local state, and one-off work artifacts.
- Tracked engineering documentation contains local filesystem paths, internal channel IDs, public identity/event references, dated provider/account-routing information, and operational incident notes. These are public disclosures, not credentials. Do not treat this repository as a confidential operational notebook. Future evidence still needs individual review for transcripts, strategy, account details, and third-party content.
- Source inspection found randomly generated league bearer credentials stored as hashes, database-derived actor authority, revoked-credential checks, league/owner scope checks, and a default loopback server bind. This does not establish the configuration or security of a running deployment.
- `npm audit --omit=dev --json` reported zero known production dependency advisories at review time. This means no matching advisories in that audit response, not zero vulnerabilities.
- Authenticated follow-up through the operator's existing GitHub CLI login confirmed public visibility, enabled secret scanning and push protection, and an empty secret-scanning alert response. Non-provider patterns, validity checks, Dependabot security updates, and private vulnerability reporting were disabled. The branch-protection endpoint reported that `main` was not protected. No settings were changed; the publication still follows the repository's PR-and-green-CI convention.
- The scoreboard and season-notebook URLs returned HTTP 200. This is reachability proof only, not rendered QA, fresh-score verification, or proof of continuous owner execution.

## Publication improvements prepared

The README now leads with the real-season experiment, links to the scoreboard and notebook, introduces the eleven-model field, separates company identity from sponsorship, and explains what a visitor can inspect or run. Removed the stale blanket statement that live scoring had not yet been observed. Historical fleet and capability evidence remains linked and is explicitly dated rather than presented as a status dashboard.

`SECURITY.md` defines private reporting, publication exclusions, and credential-remediation practice without imposing new tactical approval gates on owners.

## Not verified

- Full GitHub account/collaborator permissions. Connector Hub was not configured, but the owner's explicit instruction to use the existing publishing workflow enabled the authenticated follow-up above through the already-configured CLI login. No new authentication flow or alternate runtime credentials were used.
- Historical pull-request/issue/discussion bodies, attachments, Actions logs/artifacts, releases, deleted remote references, unreachable Git objects, or secrets embedded inside image/binary assets. A source clone does not cover these surfaces.
- Arbitrary unstructured secrets that do not match the selected patterns. Dedicated scanner tools were not installed; this review used an ad hoc local pattern scan and manual candidate/source inspection.
- Live network exposure, deployment authentication, operating-system permissions, provider account misuse, or a full application security audit.
- Third-party redistribution clearance. The existing [MFL boundary](MFL_USE_BOUNDARY.md) documents an unresolved permission question independently of whether Black4's software can be public. The MIT license grants no third-party data or trademark rights.

GitHub documents automatic free secret scanning for public repositories and scanning across Git history and additional collaboration surfaces: [GitHub secret scanning](https://docs.github.com/en/code-security/concepts/secret-security/secret-scanning). The authenticated checks above establish the settings and alert response at review time, not perpetual protection or proof that every kind of secret is detected.

Publication follows a documentation-only branch and pull request. Consult the merged commit and its workflow for publication and CI evidence; this review itself is not proof of deployment or continuous operation. Existing uncommitted season-adapter changes were preserved and were not part of this publication patch.
