#!/usr/bin/env node
/**
 * ./black4 contribute --topic <slug> [--title "..."] [--note "..."] [--dry-run]
 *
 * Moves files an owner staged under workspace/OUTBOX/repo/<repo path> onto a
 * franchise/<company>/<topic> branch built from origin/main in a private scratch
 * clone, and opens a pull request. It never runs git in the shared checkout,
 * never touches main, and only accepts docs/franchise/<company>/**,
 * franchises/<company>/branding/** and docs/proposals/**.
 */
import {
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { dirname, resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  companyFor,
  branchName,
  classifyFiles,
  authorFor,
  prBody,
} from "./franchise-contribute-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [franchiseId, ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(name);
  return i === -1 ? null : (rest[i + 1] ?? "");
};
const dryRun = rest.includes("--dry-run");
const registry = JSON.parse(
  readFileSync(join(root, "config/native-harnesses.json"), "utf8"),
);
const company = companyFor(franchiseId, registry);
if (!company) {
  console.error(
    "Usage: franchise-contribute.mjs FRANCHISE_ID --topic <slug> [--title ...] [--note ...] [--dry-run]",
  );
  process.exit(2);
}
const topic = opt("--topic");
if (!topic) {
  console.error("--topic <slug> is required (letters, digits, dashes).");
  process.exit(2);
}
const workspace = join(root, "franchises", company, "workspace");
const outbox = join(workspace, "OUTBOX", "repo");
if (!existsSync(outbox)) {
  console.error(
    `Nothing staged. Put repo-relative files under ${relative(workspace, outbox)}/ (for example OUTBOX/repo/docs/franchise/${company}/week-1.md).`,
  );
  process.exit(2);
}
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
const staged = walk(outbox).map((abs) => {
  const bytes = statSync(abs).size;
  const buffer = readFileSync(abs);
  const text = /\.(md|txt|json|csv|svg|html|yml|yaml)$/i.test(abs)
    ? buffer.toString("utf8")
    : undefined;
  return { abs, path: relative(outbox, abs), bytes, text };
});
const plan = classifyFiles(company, staged);
const teamsFile = join(root, "config/public-scoreboard.json");
const teams = existsSync(teamsFile)
  ? JSON.parse(readFileSync(teamsFile, "utf8")).teams
  : [];
const author = authorFor(company, teams);
const branch = branchName(company, topic);
const title =
  opt("--title") ||
  `${author.name.replace(/ \(.*\)$/, "")}: ${topic.replace(/-/g, " ")}`;
const harness = registry.franchises[franchiseId].harness;
const summary = {
  company,
  branch,
  author: author.display,
  title,
  accepted: plan.accepted,
  refused: plan.refused,
  dryRun,
};
if (!plan.ok) {
  console.error(JSON.stringify({ ...summary, status: "refused" }, null, 2));
  console.error(
    "Allowed roots: docs/franchise/" +
      company +
      "/, franchises/" +
      company +
      "/branding/, docs/proposals/. Anything else needs a proposal under docs/proposals/.",
  );
  process.exit(3);
}
if (dryRun) {
  console.log(JSON.stringify({ ...summary, status: "dry-run" }, null, 2));
  process.exit(0);
}

const git = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
const origin = git(["-C", root, "remote", "get-url", "origin"], root);
const clones = join(root, ".local", "franchise-clones");
mkdirSync(clones, { recursive: true });
const clone = join(clones, company);
if (!existsSync(join(clone, ".git")))
  git(["clone", "--quiet", "--no-checkout", origin, clone], clones);
git(["fetch", "--quiet", "origin", "main"], clone);
let name = branch;
const remoteBranches = git(
  ["ls-remote", "--heads", "origin", `${branch}*`],
  clone,
);
if (
  remoteBranches.includes(`refs/heads/${branch}\n`) ||
  remoteBranches.endsWith(`refs/heads/${branch}`)
)
  name = `${branch}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
git(["checkout", "--quiet", "-B", name, "origin/main"], clone);
for (const f of plan.accepted) {
  const dest = join(clone, f.path);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(outbox, f.path), dest);
  git(["add", "--", f.path], clone);
}
const message = `${title}\n\nContributed through ./black4 contribute from the ${company} franchise workspace.\n\nCo-Authored-By: ${harness} <noreply@black4.ai>`;
git(
  [
    "-c",
    `user.name=${author.name}`,
    "-c",
    `user.email=${author.email}`,
    "commit",
    "--quiet",
    "--author",
    author.display,
    "-m",
    message,
  ],
  clone,
);
git(["push", "--quiet", "-u", "origin", name], clone);
let url = "";
try {
  url = execFileSync(
    "gh",
    [
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      name,
      "--title",
      title,
      "--body",
      prBody({ company, files: plan.accepted, note: opt("--note") }),
      "--label",
      "franchise",
    ],
    { cwd: clone, encoding: "utf8" },
  ).trim();
} catch {
  url = execFileSync(
    "gh",
    [
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      name,
      "--title",
      title,
      "--body",
      prBody({ company, files: plan.accepted, note: opt("--note") }),
    ],
    { cwd: clone, encoding: "utf8" },
  ).trim();
}
const sent = join(
  workspace,
  "OUTBOX",
  "sent",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
mkdirSync(sent, { recursive: true });
renameSync(outbox, join(sent, "repo"));
console.log(
  JSON.stringify(
    {
      ...summary,
      status: "opened",
      branch: name,
      pullRequest: url.split("\n").pop(),
      movedTo: relative(workspace, sent),
    },
    null,
    2,
  ),
);
