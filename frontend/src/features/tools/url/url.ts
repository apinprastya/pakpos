/**
 * The URL tool's logic: percent-encoding and decoding in three flavours, and
 * a URL broken into parts with `lib/urlx` (the request editor's own reading).
 * Pure; never throws on bad input, returns an error with a position instead.
 */
import { hostOf, queryFromURL, splitURL } from "@/lib/urlx";
import type { KeyValue } from "@/lib/model";
import { varTokens } from "@/lib/varTokens";

/**
 * - component: `encodeURIComponent` rules (a query value or path segment);
 * - form: `application/x-www-form-urlencoded` (space is `+`);
 * - full: a whole URL; only what can't appear in a URL is encoded.
 */
export type UrlMode = "component" | "form" | "full";
export type Direction = "encode" | "decode";

/** "escape": a % without two hex digits; "utf8": escapes whose bytes aren't UTF-8 text. */
export type UrlProblem = "escape" | "utf8";

export type UrlResult = { ok: true; output: string } | { ok: false; problem: UrlProblem; offset: number };

const ALNUM = /[A-Za-z0-9]/;
/** Left as is besides letters and digits, per mode. */
const SAFE: Record<UrlMode, Set<string>> = {
  component: new Set("-_.!~*'()"),
  form: new Set("*-._"),
  // RFC 3986 unreserved and reserved characters: they keep their meaning in a URL.
  full: new Set("-_.~:/?#[]@!$&'()*+,;="),
};
/** Reserved characters a full-URL decode leaves escaped, so the URL's structure can't change (like `decodeURI`). */
const KEEP_ESCAPED = new Set(";/?:@&=+$,#");

const encoder = new TextEncoder();
const hex = (b: number) => "%" + b.toString(16).toUpperCase().padStart(2, "0");
const isHex = (c: string | undefined) => c !== undefined && /^[0-9A-Fa-f]$/.test(c);

function encodePart(text: string, mode: UrlMode): string {
  const safe = SAFE[mode];
  let out = "";
  for (const ch of text) {
    if (ch.length === 1 && (ALNUM.test(ch) || safe.has(ch))) out += ch;
    else if (mode === "form" && ch === " ") out += "+";
    // A lone surrogate becomes U+FFFD (TextEncoder's rule) instead of throwing like encodeURIComponent.
    else for (const b of encoder.encode(ch)) out += hex(b);
  }
  return out;
}

/** Percent-encodes text. */
export function encodeUrl(text: string, mode: UrlMode): string {
  if (mode !== "full") return encodePart(text, mode);
  // A full URL can be one from a request, so `{{variable}}` references stay as
  // written (Pakpos resolves them at send time), and existing %XX escapes
  // aren't encoded a second time. Everything else follows the rules above.
  let out = "";
  let pos = 0;
  const plain = (s: string) => {
    let i = 0;
    while (i < s.length) {
      const pct = s.indexOf("%", i);
      const end = pct < 0 ? s.length : pct;
      out += encodePart(s.slice(i, end), "full");
      if (pct < 0) break;
      out += isHex(s[pct + 1]) && isHex(s[pct + 2]) ? s.slice(pct, pct + 3) : "%25";
      i = pct + (isHex(s[pct + 1]) && isHex(s[pct + 2]) ? 3 : 1);
    }
  };
  for (const t of varTokens(text)) {
    plain(text.slice(pos, t.from));
    out += text.slice(t.from, t.to);
    pos = t.to;
  }
  plain(text.slice(pos));
  return out;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Decodes percent-escapes; `+` is a space in form mode. Errors name the offset of the bad escape. */
export function decodeUrl(text: string, mode: UrlMode): UrlResult {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "+" && mode === "form") {
      out += " ";
      i++;
      continue;
    }
    if (c !== "%") {
      out += c;
      i++;
      continue;
    }
    // A run of escapes is decoded together: a UTF-8 character spans several.
    const start = i;
    const bytes: number[] = [];
    while (text[i] === "%") {
      if (!isHex(text[i + 1]) || !isHex(text[i + 2])) {
        return { ok: false, problem: "escape", offset: i };
      }
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 3;
    }
    let decoded: string;
    try {
      decoded = utf8.decode(new Uint8Array(bytes));
    } catch {
      return { ok: false, problem: "utf8", offset: start };
    }
    if (mode !== "full") {
      out += decoded;
      continue;
    }
    // Keep reserved characters escaped; decode the rest. Offsets per character follow its bytes.
    let at = start;
    for (const ch of decoded) {
      const len = encoder.encode(ch).length * 3;
      out += KEEP_ESCAPED.has(ch) ? text.slice(at, at + len) : ch;
      at += len;
    }
  }
  return { ok: true, output: out };
}

/** Line and column (from 1) of an offset. */
export function position(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const nl = before.lastIndexOf("\n");
  return { line: before.split("\n").length, column: offset - nl };
}

/** Runs the tool. Empty input gives empty output. */
export function transformUrl(text: string, mode: UrlMode, direction: Direction): UrlResult {
  if (text === "") return { ok: true, output: "" };
  if (direction === "encode") return { ok: true, output: encodeUrl(text, mode) };
  return decodeUrl(text, mode);
}

/** The error as a sentence that names where it is. */
export function errorText(text: string, offset: number, problem: UrlProblem): string {
  const { line, column } = position(text, offset);
  const where = text.includes("\n") ? `line ${line}, column ${column}` : `column ${column}`;
  return problem === "escape"
    ? `The %-escape at ${where} isn't valid: % must be followed by two hex digits (write a literal % as %25).`
    : `The %-escapes at ${where} aren't valid UTF-8 text.`;
}

export interface UrlParts {
  /** The URL that was read (trimmed). */
  source: string;
  scheme: string;
  host: string;
  port: string;
  path: string;
  query: KeyValue[];
  fragment: string;
}

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;

/**
 * A URL's parts, read with `lib/urlx` like the request editor reads the URL
 * bar (so the query table matches its Params). Null when the text has no
 * `scheme://` start, or is more than one line.
 */
export function parseUrl(raw: string): UrlParts | null {
  const text = raw.trim();
  if (text.includes("\n")) return null;
  const m = SCHEME.exec(text);
  if (!m) return null;
  const { base, fragment } = splitURL(text);
  const hostPort = hostOf(text);
  const afterScheme = base.slice(m[0].length);
  const slash = afterScheme.indexOf("/");
  const path = slash >= 0 ? afterScheme.slice(slash) : "";
  // The port follows the last ":" unless it's inside an IPv6 literal ([::1]).
  const colon = hostPort.lastIndexOf(":");
  const hasPort = colon >= 0 && colon > hostPort.lastIndexOf("]") && /^\d*$/.test(hostPort.slice(colon + 1));
  return {
    source: text,
    scheme: m[1].toLowerCase(),
    host: hasPort ? hostPort.slice(0, colon) : hostPort,
    port: hasPort ? hostPort.slice(colon + 1) : "",
    path,
    query: queryFromURL(text),
    fragment,
  };
}
