/**
 * Decoding of JSON Web Tokens (JWS compact form), in the browser: base64url,
 * JSON and claim analysis. Nothing here verifies a signature (that's Go's
 * `core/jwtx`) and nothing here knows about the UI.
 */
import { relativeTime } from "@/features/request/oauth2";

export type Segment = "header" | "payload" | "signature";

/** What went wrong, and in which part of the token ("token" for the whole). */
export interface JwtProblem {
  segment: Segment | "token";
  message: string;
}

export type TimeClaim = "exp" | "nbf" | "iat";

/** A registered claim found in the payload. */
export interface ClaimInfo {
  name: "exp" | "nbf" | "iat" | "iss" | "sub" | "aud" | "jti";
  /** Plain-words name, e.g. "Expires". */
  label: string;
  /** The value as it appears in the payload. */
  value: unknown;
  /** The value as text (arrays joined with ", "). */
  text: string;
  /** For exp, nbf and iat holding a number: seconds since the Unix epoch. */
  seconds?: number;
}

export interface DecodedJwt {
  /** "empty": nothing to decode; "jwe": an encrypted token (only its header is read). */
  kind: "empty" | "jws" | "jwe" | "invalid";
  /** The text that was decoded: whitespace and a leading "Bearer " removed. */
  token: string;
  /** The parsed header, when it's a JSON object. */
  header: Record<string, unknown> | null;
  /** The header formatted for display ("" when it couldn't be read). */
  headerText: string;
  /** The parsed payload, when it's JSON. */
  payload: unknown;
  /** The payload formatted for display: JSON, or the raw text if it isn't JSON. */
  payloadText: string;
  /** The signature segment as it appears in the token (base64url). */
  signature: string;
  /** The header's `alg` ("" when missing). */
  alg: string;
  /** `alg: none`: the token claims to have no signature. */
  unsigned: boolean;
  claims: ClaimInfo[];
  /** Problems that stop a part from being read. */
  errors: JwtProblem[];
  /** Things worth knowing that don't stop decoding. */
  warnings: string[];
}

const SEGMENT_NAMES: Record<Segment, string> = {
  header: "header",
  payload: "payload",
  signature: "signature",
};

const B64URL = /^[A-Za-z0-9_-]*={0,2}$/;

/** Removes whitespace (tokens get wrapped when pasted) and a leading "Bearer ". */
export function cleanToken(text: string): string {
  return text
    .trim()
    .replace(/^bearer\s+/i, "")
    .replace(/\s+/g, "");
}

/** Decodes base64url (padding optional) to bytes; null when it isn't valid base64url. */
export function base64UrlDecode(seg: string): Uint8Array | null {
  if (!B64URL.test(seg)) return null;
  const bare = seg.replace(/=+$/, "");
  if (bare.length % 4 === 1) return null;
  // With padding, it has to be the right amount.
  if (bare.length !== seg.length && seg.length % 4 !== 0) return null;
  const b64 = bare.replace(/-/g, "+").replace(/_/g, "/");
  let bin: string;
  try {
    bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

type SegmentRead =
  | { ok: true; text: string; json: unknown; isJson: true }
  | { ok: true; text: string; isJson: false }
  | { ok: false; message: string };

/** Base64url → UTF-8 text → JSON, naming the segment in each error. */
function readSegment(seg: string, name: Segment): SegmentRead {
  const label = SEGMENT_NAMES[name];
  if (seg === "") return { ok: false, message: `The ${label} is empty.` };
  const bytes = base64UrlDecode(seg);
  if (!bytes) return { ok: false, message: `The ${label} isn't valid base64url.` };
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return { ok: false, message: `The ${label} isn't UTF-8 text.` };
  }
  try {
    return { ok: true, text, json: JSON.parse(text) as unknown, isJson: true };
  } catch {
    return { ok: true, text, isJson: false };
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function empty(token: string, kind: DecodedJwt["kind"]): DecodedJwt {
  return {
    kind,
    token,
    header: null,
    headerText: "",
    payload: undefined,
    payloadText: "",
    signature: "",
    alg: "",
    unsigned: false,
    claims: [],
    errors: [],
    warnings: [],
  };
}

/** Decodes a JWT (or says why it can't). Pure and fast enough to run on every keystroke. */
export function decodeJwt(text: string): DecodedJwt {
  const token = cleanToken(text);
  if (!token) return empty(token, "empty");
  const parts = token.split(".");
  const out = empty(token, "jws");

  const header = readSegment(parts[0], "header");
  if (header.ok) {
    out.headerText = header.isJson ? prettyJson(header.text) : header.text;
    if (!header.isJson) out.errors.push({ segment: "header", message: "The header isn't JSON." });
    else if (!isObject(header.json))
      out.errors.push({ segment: "header", message: "The header isn't a JSON object." });
    else out.header = header.json;
  } else {
    out.errors.push({ segment: "header", message: header.message });
  }

  if (parts.length === 5 && out.header && "enc" in out.header) {
    out.kind = "jwe";
    out.alg = typeof out.header.alg === "string" ? out.header.alg : "";
    return out;
  }
  if (parts.length !== 3) {
    out.kind = "invalid";
    // The count is the problem; what the first part holds would only be noise.
    out.errors = [
      {
        segment: "token",
        message:
          parts.length === 1
            ? "This isn't a JWT: a JWT has three parts separated by dots."
            : `A JWT has three parts separated by dots; this has ${parts.length}.`,
      },
    ];
    return out;
  }

  if (out.header) {
    const alg = out.header.alg;
    if (typeof alg !== "string" || alg === "") {
      out.errors.push({ segment: "header", message: 'The header has no "alg" field.' });
    } else {
      out.alg = alg;
      out.unsigned = alg.toLowerCase() === "none";
    }
  }

  const payload = readSegment(parts[1], "payload");
  if (payload.ok) {
    if (payload.isJson) {
      out.payload = payload.json;
      out.payloadText = prettyJson(payload.text);
      if (isObject(payload.json)) out.claims = analyzeClaims(payload.json, out.warnings);
      else out.warnings.push("The payload is JSON but not an object, so it has no claims.");
    } else {
      out.payloadText = payload.text;
      out.errors.push({ segment: "payload", message: "The payload isn't JSON." });
    }
  } else {
    out.errors.push({ segment: "payload", message: payload.message });
  }

  out.signature = parts[2];
  if (parts[2] !== "" && !base64UrlDecode(parts[2])) {
    out.errors.push({ segment: "signature", message: "The signature isn't valid base64url." });
  } else if (parts[2] === "" && out.alg && !out.unsigned) {
    out.warnings.push(`The header says ${out.alg}, but the token has no signature.`);
  } else if (parts[2] !== "" && out.unsigned) {
    out.warnings.push('The header says "alg": "none", but the token has a signature.');
  }

  if (out.errors.length) out.kind = "invalid";
  return out;
}

/**
 * True when `text` looks like a JWT: three base64url segments separated by
 * dots, the first decoding to a JSON object with an `alg` field. Used to
 * decide whether to offer "Decode JWT".
 */
export function looksLikeJwt(text: string): boolean {
  const token = cleanToken(text);
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1]) return false;
  if (!parts.every((p) => B64URL.test(p))) return false;
  const header = readSegment(parts[0], "header");
  return header.ok && header.isJson && isObject(header.json) && typeof header.json.alg === "string";
}

const CLAIMS: { name: ClaimInfo["name"]; label: string }[] = [
  { name: "iss", label: "Issuer" },
  { name: "sub", label: "Subject" },
  { name: "aud", label: "Audience" },
  { name: "exp", label: "Expires" },
  { name: "nbf", label: "Not before" },
  { name: "iat", label: "Issued" },
  { name: "jti", label: "Token ID" },
];

const TIME_CLAIMS = new Set<string>(["exp", "nbf", "iat"]);

function claimText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(", ");
  return JSON.stringify(v);
}

/** The registered claims present in a payload, in a fixed order. */
export function analyzeClaims(payload: Record<string, unknown>, warnings: string[] = []): ClaimInfo[] {
  const out: ClaimInfo[] = [];
  for (const { name, label } of CLAIMS) {
    if (!(name in payload)) continue;
    const value = payload[name];
    const info: ClaimInfo = { name, label, value, text: claimText(value) };
    if (TIME_CLAIMS.has(name)) {
      if (typeof value === "number" && Number.isFinite(value)) info.seconds = value;
      else warnings.push(`"${name}" should be a number of seconds since 1970, not ${JSON.stringify(value)}.`);
    }
    out.push(info);
  }
  return out;
}

export type TimeStatus = "valid" | "expired" | "notYet" | "neutral";

/** Whether a time claim makes the token unusable at `nowMs` (to the second, no skew allowance). */
export function timeStatus(claim: ClaimInfo, nowMs: number): TimeStatus {
  if (claim.seconds === undefined) return "neutral";
  const now = Math.floor(nowMs / 1000);
  switch (claim.name) {
    case "exp":
      return now >= claim.seconds ? "expired" : "valid";
    case "nbf":
      return now < claim.seconds ? "notYet" : "valid";
    default:
      return "neutral";
  }
}

/** The token as a whole at `nowMs`: expired, not yet valid, or neither (null when there are no such claims). */
export function tokenTimeStatus(claims: ClaimInfo[], nowMs: number): "valid" | "expired" | "notYet" | null {
  let result: "valid" | "expired" | "notYet" | null = null;
  for (const c of claims) {
    const s = timeStatus(c, nowMs);
    if (s === "expired" || s === "notYet") return s;
    if (s === "valid") result = "valid";
  }
  return result;
}

/**
 * Re-indents valid JSON text with two spaces without parsing its values, so
 * numbers keep every digit (a 64-bit id stays exact). Call only on text that
 * `JSON.parse` accepted.
 */
export function prettyJson(text: string): string {
  let out = "";
  let depth = 0;
  const nl = () => "\n" + "  ".repeat(depth);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === close) {
        out += c + close;
        i = j;
      } else {
        depth++;
        out += c + nl();
      }
    } else if (c === "}" || c === "]") {
      depth--;
      out += nl() + c;
    } else if (c === ",") {
      out += "," + nl();
    } else if (c === ":") {
      out += ": ";
    } else if (!/\s/.test(c)) {
      out += c;
    }
  }
  return out;
}

/** "expires in 12 min", "expired 3 h ago", "issued 2 d ago". */
export function claimTimeText(claim: ClaimInfo, now: number): string {
  const rel = relativeTime(claim.seconds! * 1000, now);
  const status = timeStatus(claim, now);
  switch (claim.name) {
    case "exp":
      return status === "expired" ? `expired ${rel}` : `expires ${rel}`;
    case "nbf":
      return status === "notYet" ? `valid ${rel}` : `valid from ${rel}`;
    default:
      return `issued ${rel}`;
  }
}
