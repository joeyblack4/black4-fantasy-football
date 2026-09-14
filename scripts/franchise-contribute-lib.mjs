/** Pure helpers for the franchise contribution lane. No git, no network. */
export const ALLOWED_ROOTS = (company) => [
  `docs/franchise/${company}/`,
  `franchises/${company}/branding/`,
  "docs/proposals/",
];
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 40;
const SECRET_PATTERNS = [
  /sk-(?:or-|ant-)?[A-Za-z0-9_-]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /nsec1[a-z0-9]{20,}/,
  /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_\-]{24,}/i,
];

export function companyFor(franchiseId, registry) {
  if (!Object.hasOwn(registry.franchises ?? {}, franchiseId)) return null;
  const m = /^b4-([a-z0-9]+)$/.exec(franchiseId);
  return m ? m[1] : null;
}

export function branchName(company, topic) {
  const slug = String(topic ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!slug) throw new Error("CONTRIBUTE_TOPIC_REQUIRED");
  return `franchise/${company}/${slug}`;
}

/** Split staged repo-relative paths into accepted and refused, with reasons. */
export function classifyFiles(company, files) {
  const roots = ALLOWED_ROOTS(company);
  const accepted = [];
  const refused = [];
  let total = 0;
  for (const f of files) {
    const path = f.path.replace(/\\/g, "/");
    if (
      path
        .split("/")
        .some((seg) => seg === ".." || seg === "" || seg.startsWith("."))
    )
      refused.push({ path, reason: "hidden-or-relative-segment" });
    else if (!roots.some((r) => path.startsWith(r)))
      refused.push({ path, reason: "outside-allowed-roots" });
    else if (f.bytes > MAX_FILE_BYTES)
      refused.push({ path, reason: "file-too-large" });
    else if (
      typeof f.text === "string" &&
      SECRET_PATTERNS.some((p) => p.test(f.text))
    )
      refused.push({ path, reason: "looks-like-a-secret" });
    else {
      accepted.push({ path, bytes: f.bytes });
      total += f.bytes;
    }
  }
  if (accepted.length > MAX_FILES)
    refused.push({ path: "*", reason: "too-many-files" });
  if (total > MAX_TOTAL_BYTES)
    refused.push({ path: "*", reason: "total-too-large" });
  return { accepted, refused, ok: refused.length === 0 && accepted.length > 0 };
}

export function authorFor(company, teams) {
  const team = teams.find((t) => t.teamId === `b4-team-${company}`);
  const name = team ? `${team.name} (${company})` : company;
  return {
    name,
    email: `b4-${company}@black4.ai`,
    display: `${name} <b4-${company}@black4.ai>`,
  };
}

export function prBody({ company, files, note }) {
  const list = files.map((f) => `- \`${f.path}\``).join("\n");
  return [
    `Contribution from the ${company} franchise through \`./black4 contribute\`.`,
    "",
    "Files:",
    list,
    "",
    note ? `Note from the owner:\n\n${note}` : "",
    "",
    "Reviewed and merged by the commissioner. Scope: franchise notes, branding and proposals only; no shared code or configuration.",
  ]
    .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
    .join("\n");
}
