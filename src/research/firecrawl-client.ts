import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { z } from "zod";
import { generalPublicUrl, isPublicAddress, ResearchError } from "./network.js";
const endpoint = "https://api.firecrawl.dev/v2/";
const operationKey = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,100}$/)
  .optional();
export const FirecrawlInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("search"),
      query: z.string().trim().min(1).max(200),
      operationKey,
    })
    .strict(),
  z
    .object({ kind: z.literal("scrape"), url: z.url().max(2000), operationKey })
    .strict(),
]);
export type FirecrawlInput = z.infer<typeof FirecrawlInputSchema>;
export type FirecrawlPlan = {
  kind: "search" | "scrape";
  body: Record<string, unknown>;
  requestHash: string;
};
export type FirecrawlResponse = {
  success: boolean;
  httpStatus: number;
  responseHash: string;
  providerId: string | null;
  creditsUsed: number | null;
  creditsField: string | null;
  code: string | null;
  results: {
    url: string;
    title: string;
    excerpt: string;
    contentHash: string;
    sourceTime: null;
    untrustedContent: true;
  }[];
};
export function hashValue(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
const text = (value: unknown, max: number) =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
        .slice(0, max)
    : "";
function item(raw: any) {
  const url = generalPublicUrl(
    raw.url ?? raw.metadata?.sourceURL ?? raw.metadata?.url,
  ).url.href;
  const full = text(raw.markdown ?? raw.description, 50000),
    excerpt = full.split(/\s+/).slice(0, 120).join(" ");
  return {
    url,
    title: text(raw.title ?? raw.metadata?.title, 300),
    excerpt,
    contentHash: hashValue(full),
    sourceTime: null,
    untrustedContent: true as const,
  };
}
export class FirecrawlClient {
  constructor(
    private config: {
      apiKey: string;
      enabled: boolean;
      fetchImpl?: typeof fetch;
      resolveHost?: (
        host: string,
      ) => Promise<{ address: string; family: number }[]>;
    },
  ) {}
  async plan(input: FirecrawlInput): Promise<FirecrawlPlan> {
    const v = FirecrawlInputSchema.parse(input);
    if (!this.config.enabled || !this.config.apiKey)
      throw new ResearchError("FIRECRAWL_DISABLED");
    let body: Record<string, unknown>;
    if (v.kind === "search")
      body = {
        query: v.query,
        limit: 3,
        sources: ["web"],
        timeout: 15000,
        highlights: false,
      };
    else {
      const target = generalPublicUrl(v.url).url;
      let addresses: { address: string; family: number }[];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        addresses = await Promise.race([
          (this.config.resolveHost ?? ((h) => lookup(h, { all: true })))(
            target.hostname,
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timeout")), 5000);
          }),
        ]);
      } catch {
        throw new ResearchError("DNS_UNAVAILABLE");
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (
        !addresses.length ||
        addresses.some((a) => !isPublicAddress(a.address))
      )
        throw new ResearchError("NONPUBLIC_ADDRESS");
      body = {
        url: target.href,
        formats: ["markdown"],
        onlyMainContent: true,
        proxy: "basic",
        maxAge: 0,
        timeout: 15000,
        parsers: [],
        storeInCache: false,
        skipTlsVerification: false,
      };
    }
    return {
      kind: v.kind,
      body,
      requestHash: hashValue({ kind: v.kind, body }),
    };
  }
  async send(plan: FirecrawlPlan): Promise<FirecrawlResponse> {
    if (!this.config.enabled || !this.config.apiKey)
      throw new ResearchError("FIRECRAWL_DISABLED");
    const response = await (this.config.fetchImpl ?? fetch)(
      endpoint + plan.kind,
      {
        method: "POST",
        headers: {
          authorization: "Bearer " + this.config.apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(plan.body),
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.body) throw new ResearchError("FIRECRAWL_RESPONSE_MISSING");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 2_000_000) {
        await reader.cancel();
        throw new ResearchError("FIRECRAWL_RESPONSE_TOO_LARGE");
      }
      chunks.push(next.value);
    }
    const raw = Buffer.concat(chunks).toString("utf8"),
      responseHash = createHash("sha256").update(raw).digest("hex");
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ResearchError("FIRECRAWL_RESPONSE_INVALID");
    }
    const creditCandidates = [
      ["creditsUsed", parsed.creditsUsed],
      ["data.metadata.creditsUsed", parsed.data?.metadata?.creditsUsed],
    ] as const;
    const credited = creditCandidates.find(
      ([, v]) =>
        typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1_000_000,
    );
    let results: ReturnType<typeof item>[] = [];
    let dropped = 0;
    if (response.ok && parsed.success === true) {
      const rows = plan.kind === "search" ? parsed.data?.web : [parsed.data];
      if (!Array.isArray(rows))
        throw new ResearchError("FIRECRAWL_RESPONSE_INVALID");
      for (const row of rows.slice(0, 3))
        try {
          if (row?.metadata?.statusCode && row.metadata.statusCode !== 200) {
            dropped++;
            continue;
          }
          results.push(item(row));
        } catch {
          dropped++;
        }
    }
    return {
      success: response.ok && parsed.success === true,
      httpStatus: response.status,
      responseHash,
      providerId: typeof parsed.id === "string" ? text(parsed.id, 200) : null,
      creditsUsed: credited?.[1] ?? null,
      creditsField: credited?.[0] ?? null,
      code:
        response.ok && parsed.success === true
          ? dropped
            ? "SOME_RESULTS_UNAVAILABLE"
            : null
          : "FIRECRAWL_HTTP_" + response.status,
      results,
    };
  }
}
