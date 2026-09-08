import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
export type ResearchSource = {
  id: string;
  name: string;
  origin: string;
  paths: string[];
  homeUrl: string;
  cacheSeconds: number;
  verifiedAt: string;
  access: "public-free";
};
export const officialNflSources: readonly ResearchSource[] = [
  {
    id: "nfl-news",
    name: "NFL official news",
    origin: "https://www.nfl.com",
    paths: ["/news"],
    homeUrl: "https://www.nfl.com/news",
    cacheSeconds: 60,
    verifiedAt: "2026-09-07",
    access: "public-free",
  },
  {
    id: "nfl-injuries",
    name: "NFL official injury reports",
    origin: "https://www.nfl.com",
    paths: ["/injuries"],
    homeUrl: "https://www.nfl.com/injuries/",
    cacheSeconds: 60,
    verifiedAt: "2026-09-07",
    access: "public-free",
  },
  {
    id: "nfl-schedule",
    name: "NFL official schedule",
    origin: "https://www.nfl.com",
    paths: ["/schedules"],
    homeUrl: "https://www.nfl.com/schedules",
    cacheSeconds: 300,
    verifiedAt: "2026-09-07",
    access: "public-free",
  },
];
export class ResearchError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export function permittedUrl(
  input: string,
  sources: readonly ResearchSource[] = officialNflSources,
) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ResearchError("URL_NOT_PERMITTED");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    input.length > 2000 ||
    /[\\\x00-\x20]/.test(input)
  )
    throw new ResearchError("URL_NOT_PERMITTED");
  // Reject encoded path separators/dot segments instead of normalizing an ambiguous model-supplied URL.
  if (/%(?:2f|5c|2e|00)/i.test(url.pathname))
    throw new ResearchError("URL_NOT_PERMITTED");
  const source = sources.find(
    (s) =>
      s.access === "public-free" &&
      url.origin === s.origin &&
      s.paths.some(
        (p) => url.pathname === p || url.pathname.startsWith(p + "/"),
      ),
  );
  if (!source) throw new ResearchError("URL_NOT_PERMITTED");
  return { url, source };
}
/** Explicit operator opt-in. Public means network reachability, not editorial trust. */
export function generalPublicUrl(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ResearchError("URL_NOT_PERMITTED");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    input.length > 2000 ||
    /[\\\x00-\x20]/.test(input) ||
    /%(?:2f|5c|2e|00)/i.test(url.pathname) ||
    isIP(hostname) ||
    hostname.includes(":") ||
    !hostname.includes(".") ||
    /\.(?:localhost|local|internal|test|invalid|onion)\.?$/.test(hostname) ||
    hostname.endsWith(".")
  )
    throw new ResearchError("URL_NOT_PERMITTED");
  const source: ResearchSource = {
    id: "public-web:" + hostname,
    name: hostname + " (unverified public source)",
    origin: url.origin,
    paths: ["/"],
    homeUrl: url.origin + "/",
    cacheSeconds: 60,
    verifiedAt: "not-preverified",
    access: "public-free",
  };
  return { url, source };
}
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (
      lower.includes(".") ||
      lower.startsWith("::") ||
      lower.startsWith("2001:db8:")
    )
      return false;
    const first = Number.parseInt(lower.split(":")[0], 16);
    return first >= 0x2400 && first <= 0x3fff;
  }
  return false;
}
export type HttpDocument = {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
};
export type ResearchTransport = (url: URL) => Promise<HttpDocument>;
/** HTTPS socket pins the validated DNS address; redirects, arbitrary headers and proxies are never followed. */
export const securePublicGet: ResearchTransport = async (url) => {
  // Defense in depth even if a trusted caller forgets its policy validator.
  generalPublicUrl(url.href);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let addresses: { address: string; family: number }[];
  try {
    addresses = await Promise.race([
      lookup(url.hostname, { all: true }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new ResearchError("DNS_TIMEOUT")),
          5000,
        );
      }),
    ]);
  } catch {
    throw new ResearchError("DNS_UNAVAILABLE");
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    throw new ResearchError("NONPUBLIC_ADDRESS");
  const address = addresses[0];
  return new Promise<HttpDocument>((resolve, reject) => {
    let settled = false;
    let absoluteTimeout: ReturnType<typeof setTimeout> | undefined;
    const fail = (code: string) => {
      if (!settled) {
        settled = true;
        if (absoluteTimeout) clearTimeout(absoluteTimeout);
        reject(new ResearchError(code));
      }
    };
    const req = request(
      url,
      {
        method: "GET",
        agent: false,
        servername: url.hostname,
        lookup: ((_host: unknown, options: unknown, callback: Function) => {
          const all =
            typeof options === "object" &&
            options !== null &&
            "all" in options &&
            (options as { all?: boolean }).all;
          if (all) callback(null, [address]);
          else callback(null, address.address, address.family);
        }) as never,
        headers: {
          "User-Agent":
            "Black4-Fantasy-Research/0.1 (bounded public page reader)",
          Accept: "text/html,text/plain",
          "Accept-Encoding": "identity",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.destroy();
          req.destroy();
          fail("REDIRECT_NOT_ALLOWED");
          return;
        }
        if (status !== 200) {
          res.destroy();
          req.destroy();
          fail("HTTP_" + status);
          return;
        }
        const type = String(res.headers["content-type"] ?? "").toLowerCase();
        if (!type.startsWith("text/html") && !type.startsWith("text/plain")) {
          res.destroy();
          req.destroy();
          fail("UNSUPPORTED_CONTENT_TYPE");
          return;
        }
        if (
          res.headers["content-encoding"] &&
          res.headers["content-encoding"] !== "identity"
        ) {
          res.destroy();
          req.destroy();
          fail("UNSUPPORTED_ENCODING");
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 4_000_000) {
            res.destroy();
            req.destroy();
            fail("BODY_TOO_LARGE");
          } else chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          if (absoluteTimeout) clearTimeout(absoluteTimeout);
          resolve({
            status,
            headers: {
              "content-type": type,
              "last-modified":
                typeof res.headers["last-modified"] === "string"
                  ? res.headers["last-modified"]
                  : undefined,
            },
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", () => fail("NETWORK_UNAVAILABLE"));
      },
    );
    absoluteTimeout = setTimeout(() => {
      req.destroy();
      fail("REQUEST_TIMEOUT");
    }, 10000);
    req.setTimeout(10000, () => {
      req.destroy();
      fail("REQUEST_TIMEOUT");
    });
    req.on("error", () => fail("NETWORK_UNAVAILABLE"));
    req.end();
  });
};
