import { createHash } from "node:crypto";
import {
  permittedUrl,
  type HttpDocument,
  type ResearchSource,
  ResearchError,
} from "./network.js";
function decode(text: string) {
  return text
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => {
      const n =
        code[0].toLowerCase() === "x"
          ? parseInt(code.slice(1), 16)
          : parseInt(code, 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}
function plain(html: string) {
  return decode(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}
export type ResearchDocument = {
  url: string;
  sourceId: string;
  title: string;
  excerpt: string;
  links: { url: string; title: string }[];
  sourceTime: string | null;
  sourceTimeBasis: string;
  contentHash: string;
  untrustedContent: true;
  truncated: boolean;
};
export function extractDocument(
  url: URL,
  source: ResearchSource,
  response: HttpDocument,
  sources: readonly ResearchSource[],
  validateLink: (input: string) => unknown = (input) =>
    permittedUrl(input, sources),
): ResearchDocument {
  if (response.status !== 200)
    throw new ResearchError(
      response.status >= 300 && response.status < 400
        ? "REDIRECT_NOT_ALLOWED"
        : "HTTP_" + response.status,
    );
  if (Buffer.byteLength(response.body) > 4_000_000)
    throw new ResearchError("BODY_TOO_LARGE");
  const contentType = response.headers["content-type"] ?? "";
  if (
    !contentType.startsWith("text/html") &&
    !contentType.startsWith("text/plain")
  )
    throw new ResearchError("UNSUPPORTED_CONTENT_TYPE");
  const html = response.body,
    title = plain(
      html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? source.name,
    )
      .split(/\s+/)
      .slice(0, 15)
      .join(" ");
  let sourceTime: string | null = null,
    sourceTimeBasis = "unknown";
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1],
      value = tag.match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
    if (
      key &&
      ["article:modified_time", "article:published_time"].includes(key) &&
      value &&
      Number.isFinite(Date.parse(value))
    ) {
      sourceTime = new Date(value).toISOString();
      sourceTimeBasis = key;
      if (key === "article:modified_time") break;
    }
  }
  if (sourceTime && Date.parse(sourceTime) > Date.now() + 60000) {
    sourceTime = null;
    sourceTimeBasis = "invalid-future-source-time";
  }
  let clean = html.replace(
    /<(script|style|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    " ",
  );
  const main = clean.match(
    /<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/i,
  );
  if (main) clean = main[1];
  const words = plain(clean).split(/\s+/).filter(Boolean),
    excerpt = words.slice(0, 120).join(" ");
  const links: { url: string; title: string }[] = [];
  for (const match of clean.matchAll(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    if (links.length >= 5) break;
    try {
      const target = new URL(decode(match[1]), url);
      validateLink(target.href);
      if (target.href === url.href || links.some((l) => l.url === target.href))
        continue;
      const text = plain(match[2]).split(/\s+/).slice(0, 10).join(" ");
      if (text) links.push({ url: target.href, title: text });
    } catch {}
  }
  return {
    url: url.href,
    sourceId: source.id,
    title,
    excerpt,
    links,
    sourceTime,
    sourceTimeBasis,
    contentHash: createHash("sha256").update(html).digest("hex"),
    untrustedContent: true,
    truncated: words.length > 120,
  };
}
