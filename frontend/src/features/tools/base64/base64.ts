/**
 * The Base64 tool's logic: encode UTF-8 text (standard or URL-safe alphabet,
 * with or without padding) and decode leniently (either alphabet, missing
 * padding, whitespace and line breaks). Errors carry a position and never
 * throw. Pure; nothing here knows about the UI.
 */

export type Alphabet = "standard" | "url";
export type Direction = "encode" | "decode";

export interface EncodeOptions {
  alphabet: Alphabet;
  padding: boolean;
}

export type DecodeResult = { ok: true; bytes: Uint8Array } | { ok: false; message: string; offset: number };

const VALID = /[A-Za-z0-9+/_-]/;
const WS = /\s/;

/** Bytes → standard Base64 (chunked, so large inputs don't overflow the call stack). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** UTF-8 text → Base64 in the chosen alphabet, with or without padding. */
export function encodeBase64(text: string, opts: EncodeOptions): string {
  let out = bytesToBase64(new TextEncoder().encode(text));
  if (opts.alphabet === "url") out = out.replace(/\+/g, "-").replace(/\//g, "_");
  if (!opts.padding) out = out.replace(/=+$/, "");
  return out;
}

function describe(c: string): string {
  if (c === "\n") return "a line break";
  return `"${c}"`;
}

/**
 * Base64 → bytes. Accepts the standard and URL-safe alphabets (even mixed),
 * missing padding, and whitespace anywhere. Errors name the character
 * (1-based) where the input stops being Base64.
 */
export function decodeBase64(text: string): DecodeResult {
  let clean = "";
  let pad = 0;
  let padAt = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (WS.test(c)) continue;
    if (c === "=") {
      if (pad === 0) padAt = i;
      pad++;
      if (pad > 2) {
        return {
          ok: false,
          offset: i,
          message: `Character ${i + 1}: Base64 has at most two "=" at the end.`,
        };
      }
      continue;
    }
    if (pad > 0) {
      return {
        ok: false,
        offset: padAt,
        message: `Character ${padAt + 1}: "=" can only come at the end of Base64.`,
      };
    }
    if (!VALID.test(c)) {
      return { ok: false, offset: i, message: `Character ${i + 1} isn't valid Base64: ${describe(c)}.` };
    }
    clean += c;
  }
  if (clean.length % 4 === 1) {
    return {
      ok: false,
      offset: text.length,
      message: `${clean.length} Base64 characters can't be decoded: the input is cut off or has an extra character.`,
    };
  }
  if (pad > 0 && (clean.length + pad) % 4 !== 0) {
    return {
      ok: false,
      offset: padAt,
      message: `Character ${padAt + 1}: the "=" padding doesn't match the length. Remove it, or check for a missing character.`,
    };
  }
  const std = clean.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { ok: true, bytes };
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The bytes as UTF-8 text, or null when they aren't valid UTF-8 (binary data). */
export function bytesToText(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

/** At most this many bytes are shown as hex; the rest can be saved to a file. */
export const MAX_HEX_BYTES = 64 * 1024;

/** A hex dump: 16 bytes per line, space separated, up to `max` bytes. */
export function toHex(bytes: Uint8Array, max = MAX_HEX_BYTES): string {
  const n = Math.min(bytes.length, max);
  const lines: string[] = [];
  for (let i = 0; i < n; i += 16) {
    const row: string[] = [];
    for (let j = i; j < Math.min(i + 16, n); j++) row.push(bytes[j].toString(16).padStart(2, "0"));
    lines.push(row.join(" "));
  }
  return lines.join("\n");
}

/**
 * True when a selection looks like Base64 worth offering "Decode Base64":
 * only Base64 or URL-safe characters and whitespace, at most two "=" at the
 * end, and at least 4 characters once whitespace is removed.
 */
export function looksLikeBase64(text: string): boolean {
  const clean = text.replace(/\s+/g, "");
  return clean.length >= 4 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(clean) && decodeBase64(clean).ok;
}

export type Base64Output =
  | { kind: "text"; text: string }
  | { kind: "binary"; bytes: Uint8Array; hex: string }
  | { kind: "error"; message: string };

/** Runs the tool on `input`. Empty input gives empty text. */
export function transformBase64(input: string, direction: Direction, opts: EncodeOptions): Base64Output {
  if (direction === "encode") return { kind: "text", text: input ? encodeBase64(input, opts) : "" };
  const r = decodeBase64(input);
  if (!r.ok) return { kind: "error", message: r.message };
  const text = bytesToText(r.bytes);
  return text === null ? { kind: "binary", bytes: r.bytes, hex: toHex(r.bytes) } : { kind: "text", text };
}
