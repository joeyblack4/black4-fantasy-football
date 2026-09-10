import { createHash } from "node:crypto";
import { MflError } from "./contracts.js";
export const hash = (v: unknown) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : JSON.stringify(v))
    .digest("hex");
export function list<T = any>(v: T | T[] | null | undefined): T[] {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
}
const decode = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (_, v) => {
    if (v[0] === "#") {
      const n =
        v[1].toLowerCase() === "x"
          ? parseInt(v.slice(2), 16)
          : parseInt(v.slice(1), 10);
      if (n < 0 || n > 0x10ffff) throw new MflError("MFL_XML_INVALID");
      return String.fromCodePoint(n);
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as any)[
      v.toLowerCase()
    ];
  });
export function envelope(raw: string): {
  accepted: boolean;
  data: any;
  errorCode?: string;
  errorMessage?: string;
} {
  const text = raw.trim();
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new MflError("MFL_XML_UNSAFE");
  if (text.startsWith("{")) {
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new MflError("MFL_RESPONSE_INVALID");
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new MflError("MFL_RESPONSE_INVALID");
    if (data.error) {
      const e =
        typeof data.error === "string" ? data.error : (data.error.$t ?? "");
      return {
        accepted: false,
        data: null,
        errorCode: classifyError(e),
        errorMessage: safeErrorMessage(e),
      };
    }
    return { accepted: data.success === "OK" || data.status === "OK", data };
  }
  const stripped = text.replace(/^<\?xml[^?]*\?>\s*/, "");
  const match = stripped.match(
    /^<(status|error)(?:\s[^>]*)?>([\s\S]*?)<\/\1>\s*$/,
  );
  if (!match) throw new MflError("MFL_RESPONSE_INVALID");
  const value = decode(match[2]!);
  return match[1] === "status" && value.trim() === "OK"
    ? { accepted: true, data: { status: "OK" } }
    : {
        accepted: false,
        data: null,
        errorCode: classifyError(value),
        errorMessage: safeErrorMessage(value),
      };
}
/** Bounded provider explanation, never HTML or credentials. Not agent instructions. */
export function safeErrorMessage(value: string): string {
  return decode(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/gi, "[link removed]")
    .replace(
      /\b(?:MFL_USER_ID|APIKEY|token|password|authorization|cookie)\b\s*[:=]\s*[^\s,;]+/gi,
      "[credential removed]",
    )
    .replace(/\bBearer\s+\S+/gi, "[credential removed]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email removed]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}
/** Native live_draft uses success === "OK", otherwise response (official draft_response).
 * Deliberately separate from export/import envelopes; no arbitrary response text is retained. */
export function liveDraftEnvelope(raw: string): {
  accepted: boolean;
  data: null;
  errorCode?: string;
  nativeStatus: "OK" | "NON_OK";
  reasonCode: string | null;
} {
  if (raw.length > 16384) throw new MflError("MFL_DRAFT_RESPONSE_INVALID");
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new MflError("MFL_DRAFT_RESPONSE_INVALID");
  }
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !Object.hasOwn(data, "success") ||
    data.error !== undefined ||
    (data.status !== undefined && data.status !== data.success)
  )
    throw new MflError("MFL_DRAFT_RESPONSE_AMBIGUOUS");
  if (data.success === "OK")
    return { accepted: true, data: null, nativeStatus: "OK", reasonCode: null };
  const scalar =
    (typeof data.success === "string" &&
      data.success.length > 0 &&
      data.success.length <= 128) ||
    typeof data.success === "boolean" ||
    (typeof data.success === "number" && Number.isFinite(data.success));
  if (
    !scalar ||
    typeof data.response !== "string" ||
    !data.response.trim() ||
    data.response.length > 4096
  )
    throw new MflError("MFL_DRAFT_RESPONSE_AMBIGUOUS");
  const errorCode = classifyError(data.response);
  return {
    accepted: false,
    data: null,
    errorCode,
    nativeStatus: "NON_OK",
    reasonCode: errorCode,
  };
}
function classifyError(message: string): string {
  message = safeErrorMessage(message);
  if (
    /too many requests|rate limit|throttl|request limit exceeded/i.test(message)
  )
    return "MFL_THROTTLED";
  if (/^(?:Error\s*-\s*)?No League Scoring Rules\s*$/i.test(message.trim()))
    return "MFL_SCORING_RULES_NOT_CONFIGURED";
  if (/logged in|MFL_USER_ID|APIKEY|login|authentication/i.test(message))
    return "MFL_AUTH_REQUIRED";
  if (/not available|unavailable|season starts/i.test(message))
    return "MFL_DATA_UNAVAILABLE";
  if (/locked/i.test(message)) return "MFL_PLAYER_LOCKED";
  if (/invalid.*round|round.*(?:invalid|out of range)/i.test(message))
    return "MFL_WAIVER_ROUND_INVALID";
  if (
    /waivers?.*(?:not allowed|not available|closed)|(?:not allowing|not allowed|cannot perform|not permitted).*(?:waiver|free.agent)|first.come.*(?:not|closed)/i.test(
      message,
    )
  )
    return "MFL_ACQUISITION_UNAVAILABLE";
  if (/roster.*(?:limit|maximum|full|too many)|too many players/i.test(message))
    return "MFL_ROSTER_LIMIT";
  if (/bid.*exceeds|balance|budget/i.test(message))
    return "MFL_BID_BUDGET_REJECTED";
  if (/permission/i.test(message)) return "MFL_PERMISSION_REJECTED";
  return "MFL_APPLICATION_REJECTED";
}
/** Deliberately small parser for the documented static draft attributes, never arbitrary XML. */
export function draftState(raw: string) {
  if (raw.length > 2000000 || /<!DOCTYPE|<!ENTITY|<!\[CDATA/i.test(raw))
    throw new MflError("MFL_DRAFT_XML_INVALID");
  const xml = raw.trim().replace(/^<\?xml[^?]*\?>\s*/, "");
  const root = xml.match(/^<([A-Za-z][\w:-]*)\b([^>]*)>([\s\S]*)<\/\1>\s*$/);
  if (!root || root[1] !== "draftResults")
    throw new MflError("MFL_DRAFT_XML_INVALID");
  const attrs = (s: string) => {
    const out: Record<string, string> = {};
    let consumed = "";
    const re = /\s*([A-Za-z_][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/g;
    let m: RegExpExecArray | null;
    let end = 0;
    while ((m = re.exec(s))) {
      if (s.slice(end, m.index).trim())
        throw new MflError("MFL_DRAFT_XML_INVALID");
      if (out[m[1]!] !== undefined) throw new MflError("MFL_DRAFT_XML_INVALID");
      out[m[1]!] = decode(m[2]!.slice(1, -1));
      end = re.lastIndex;
    }
    consumed = s.slice(end);
    if (consumed.trim()) throw new MflError("MFL_DRAFT_XML_INVALID");
    return out;
  };
  const a = attrs(root[2]!),
    picks: any[] = [];
  const content = root[3]!,
    re = /<([A-Za-z][\w:-]*)\b([^>]*)\/\s*>/g;
  let m: RegExpExecArray | null,
    end = 0;
  while ((m = re.exec(content))) {
    if (content.slice(end, m.index).trim())
      throw new MflError("MFL_DRAFT_XML_INVALID");
    if (m[1] !== "draftPick") throw new MflError("MFL_DRAFT_XML_INVALID");
    const p = attrs(m[2]!);
    if (
      !/^\d+$/.test(p.round ?? "") ||
      !/^\d+$/.test(p.pick ?? "") ||
      !/^\d{4}$/.test(p.franchise ?? "") ||
      (p.player && !/^\d{4,5}$/.test(p.player)) ||
      Number(p.round) < 1 ||
      Number(p.pick) < 1 ||
      picks.some(
        (pick) =>
          pick.round === Number(p.round) && pick.pick === Number(p.pick),
      )
    )
      throw new MflError("MFL_DRAFT_XML_INVALID");
    picks.push({
      round: Number(p.round),
      pick: Number(p.pick),
      franchiseId: p.franchise,
      playerId: p.player || null,
    });
    end = re.lastIndex;
  }
  if (content.slice(end).trim()) throw new MflError("MFL_DRAFT_XML_INVALID");
  return {
    round: /^\d+$/.test(a.round ?? "") ? Number(a.round) : null,
    pick: /^\d+$/.test(a.pick ?? "") ? Number(a.pick) : null,
    franchiseId: /^\d{4}$/.test(a.franchise_id ?? "") ? a.franchise_id : null,
    status: a.status ?? null,
    paused: a.paused === "1",
    stopped: a.stopped === "1",
    over: a.over === "1",
    sourceTimestamp: /^\d+$/.test(a.timestamp ?? "") ? a.timestamp : null,
    picks,
  };
}
export const csv = (value: unknown): string[] =>
  typeof value === "string" ? value.split(",").filter(Boolean) : [];
