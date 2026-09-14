export type StagedFile = { path: string; bytes: number; text?: string };
export type Refusal = { path: string; reason: string };
export type Plan = {
  accepted: { path: string; bytes: number }[];
  refused: Refusal[];
  ok: boolean;
};
export type Team = { teamId: string; siteId?: string; name: string };
export const ALLOWED_ROOTS: (company: string) => string[];
export const MAX_FILE_BYTES: number;
export const MAX_TOTAL_BYTES: number;
export const MAX_FILES: number;
export function companyFor(
  franchiseId: string,
  registry: { franchises?: Record<string, unknown> },
): string | null;
export function branchName(company: string, topic: string): string;
export function classifyFiles(company: string, files: StagedFile[]): Plan;
export function authorFor(
  company: string,
  teams: Team[],
): { name: string; email: string; display: string };
export function prBody(input: {
  company: string;
  files: { path: string }[];
  note?: string | null;
}): string;
