import { it, expect } from "vitest";
import {
  classifyFiles,
  branchName,
  companyFor,
  authorFor,
  prBody,
} from "../scripts/franchise-contribute-lib.mjs";

const registry = {
  franchises: {
    "b4-anthropic": { harness: "claude-code" },
    "b4-kimi": { harness: "kimi-code" },
  },
};
const teams = [
  { teamId: "b4-team-anthropic", siteId: "anthropic", name: "Marginal Gains" },
];

it("maps a registered franchise id to its company and refuses unknown ids", () => {
  expect(companyFor("b4-anthropic", registry)).toBe("anthropic");
  expect(companyFor("b4-kimi", registry)).toBe("kimi");
  expect(companyFor("b4-nobody", registry)).toBeNull();
  expect(companyFor("../x", registry)).toBeNull();
});
it("builds a safe branch name under franchise/<company>/", () => {
  expect(branchName("meta", "MNF Growth Plan!")).toBe(
    "franchise/meta/mnf-growth-plan",
  );
  expect(branchName("meta", "x".repeat(80)).length).toBeLessThanOrEqual(
    "franchise/meta/".length + 40,
  );
  expect(() => branchName("meta", "???")).toThrow(/CONTRIBUTE_TOPIC_REQUIRED/);
});
it("accepts only the franchise's own docs, branding and proposals, and refuses secrets and escapes", () => {
  const plan = classifyFiles("anthropic", [
    {
      path: "docs/franchise/anthropic/week-1.md",
      bytes: 100,
      text: "# Week 1",
    },
    { path: "franchises/anthropic/branding/logo.png", bytes: 5000 },
    { path: "docs/proposals/rule-change.md", bytes: 100, text: "proposal" },
    { path: "docs/franchise/openai/steal.md", bytes: 10, text: "no" },
    { path: "src/mfl/adapter.ts", bytes: 10, text: "code" },
    { path: "docs/franchise/anthropic/../../../.env", bytes: 10, text: "x" },
    { path: "docs/franchise/anthropic/.hidden.md", bytes: 10, text: "x" },
    {
      path: "docs/franchise/anthropic/keys.md",
      bytes: 10,
      text: "OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789",
    },
    { path: "docs/franchise/anthropic/big.bin", bytes: 3 * 1024 * 1024 },
  ]);
  expect(plan.accepted.map((f) => f.path)).toEqual([
    "docs/franchise/anthropic/week-1.md",
    "franchises/anthropic/branding/logo.png",
    "docs/proposals/rule-change.md",
  ]);
  expect(plan.refused.map((f) => f.reason)).toEqual([
    "outside-allowed-roots",
    "outside-allowed-roots",
    "hidden-or-relative-segment",
    "hidden-or-relative-segment",
    "looks-like-a-secret",
    "file-too-large",
  ]);
  expect(plan.ok).toBe(false);
  expect(
    classifyFiles("anthropic", [
      { path: "docs/franchise/anthropic/a.md", bytes: 1, text: "a" },
    ]).ok,
  ).toBe(true);
  expect(classifyFiles("anthropic", []).ok).toBe(false);
});
it("attributes the commit to the franchise and writes a reviewable PR body", () => {
  expect(authorFor("anthropic", teams)).toEqual({
    name: "Marginal Gains (anthropic)",
    email: "b4-anthropic@black4.ai",
    display: "Marginal Gains (anthropic) <b4-anthropic@black4.ai>",
  });
  expect(authorFor("zai", teams).display).toBe("zai <b4-zai@black4.ai>");
  const body = prBody({
    company: "anthropic",
    files: [{ path: "docs/franchise/anthropic/a.md", bytes: 1 }],
    note: "hello",
  });
  expect(body).toContain("- `docs/franchise/anthropic/a.md`");
  expect(body).toContain("hello");
});
