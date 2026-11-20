/**
 * The ID generator's logic: UUID v4, UUID v7 and ULID generation on
 * `crypto.getRandomValues`, formatting, and reading a pasted UUID or ULID
 * back (version, variant, embedded time). Randomness and the clock are
 * parameters so tests are deterministic. Pure; nothing here knows about the UI.
 */

export type IdKind = "uuid4" | "uuid7" | "ulid";

/** Fills `bytes` with random values and returns them (crypto.getRandomValues by default). */
export type RandomFill = (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;

export const defaultRandom: RandomFill = (bytes) => crypto.getRandomValues(bytes);

export const MAX_COUNT = 1000;

/** The count field's text as a number, or what's wrong with it. */
export function parseCount(text: string): { ok: true; count: number } | { ok: false; error: string } {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return { ok: false, error: "Enter how many IDs to generate, from 1 to 1,000." };
  const n = Number(t);
  if (n < 1) return { ok: false, error: "Enter at least 1." };
  if (n > MAX_COUNT) return { ok: false, error: "You can generate up to 1,000 IDs at a time." };
  return { ok: true, count: n };
}

const HEX = "0123456789abcdef";

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

/** 32 hex digits → 8-4-4-4-12. */
export function hyphenate(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Sets the version nibble and the RFC 9562 variant bits (10xx). */
function stamp(bytes: Uint8Array, version: number): Uint8Array {
  bytes[6] = (bytes[6] & 0x0f) | (version << 4);
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes;
}

/** A random UUID v4, lower case with hyphens. */
export function uuidV4(random: RandomFill = defaultRandom): string {
  return hyphenate(toHex(stamp(random(new Uint8Array(16)), 4)));
}

/** Writes a 48-bit millisecond time big-endian into the first six bytes. */
function writeTime(bytes: Uint8Array, ms: number): void {
  let t = ms;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256;
    t = Math.floor(t / 256);
  }
}

/** A UUID v7 (RFC 9562): 48-bit Unix time in ms, version 7, variant, random rest. Lower case with hyphens. */
export function uuidV7(ms: number, random: RandomFill = defaultRandom): string {
  const bytes = random(new Uint8Array(16));
  writeTime(bytes, ms);
  return hyphenate(toHex(stamp(bytes, 7)));
}

/** Crockford base32, as ULIDs use it (no I, L, O, U). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Encodes a ULID from a 48-bit millisecond time and 10 bytes of entropy (26 characters, upper case). */
export function encodeUlid(ms: number, entropy: Uint8Array): string {
  let value = BigInt(ms);
  for (const b of entropy) value = (value << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

/** A ULID for `ms` with fresh randomness. */
export function ulid(ms: number, random: RandomFill = defaultRandom): string {
  return encodeUlid(ms, random(new Uint8Array(10)));
}

export interface GenerateOptions {
  kind: IdKind;
  count: number;
}

/**
 * Generates `count` IDs in their canonical form (UUIDs lower case with
 * hyphens, ULIDs upper case). Time-based IDs made in the same millisecond
 * are sorted, so a batch is always in order.
 */
export function generateIds(
  { kind, count }: GenerateOptions,
  now: number = Date.now(),
  random: RandomFill = defaultRandom,
): string[] {
  const n = Math.min(Math.max(Math.floor(count), 0), MAX_COUNT);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(kind === "uuid4" ? uuidV4(random) : kind === "uuid7" ? uuidV7(now, random) : ulid(now, random));
  }
  if (kind !== "uuid4") out.sort();
  return out;
}

export interface FormatOptions {
  upper: boolean;
  /** UUIDs only. */
  hyphens: boolean;
}

/** Writes a canonical ID with the chosen case and, for UUIDs, hyphens. */
export function formatId(id: string, kind: IdKind, { upper, hyphens }: FormatOptions): string {
  const text = kind !== "ulid" && !hyphens ? id.replace(/-/g, "") : id;
  return upper ? text.toUpperCase() : text.toLowerCase();
}

/** What a pasted ID is. */
export interface Inspection {
  type: "UUID" | "ULID";
  /** The canonical form (UUID lower case with hyphens; ULID upper case). */
  canonical: string;
  /** e.g. "Version 7 (Unix time)", "Nil UUID". */
  version: string;
  /** e.g. "RFC 9562"; "" for ULIDs. */
  variant: string;
  /** Embedded time in ms since 1970, for v1, v6, v7 and ULIDs. */
  timeMs?: number;
}

export type InspectResult = { ok: true; info: Inspection } | { ok: false; error: string };

const VERSIONS: Record<number, string> = {
  1: "time-based",
  2: "DCE security",
  3: "name-based, MD5",
  4: "random",
  5: "name-based, SHA-1",
  6: "reordered time",
  7: "Unix time",
  8: "custom",
};

/** 100-ns intervals between 1582-10-15 (the UUID v1 epoch) and 1970-01-01. */
const GREGORIAN_OFFSET = 0x01b21dd213814000n;

function variantOf(nibble: number): string {
  if ((nibble & 0x8) === 0) return "NCS (reserved, old)";
  if ((nibble & 0xc) === 0x8) return "RFC 9562";
  if ((nibble & 0xe) === 0xc) return "Microsoft (reserved)";
  return "Reserved for the future";
}

function inspectUuid(hex: string): InspectResult {
  const canonical = hyphenate(hex);
  if (/^0{32}$/.test(hex))
    return { ok: true, info: { type: "UUID", canonical, version: "Nil UUID", variant: "" } };
  if (/^f{32}$/.test(hex))
    return { ok: true, info: { type: "UUID", canonical, version: "Max UUID", variant: "" } };
  const version = parseInt(hex[12], 16);
  const variant = variantOf(parseInt(hex[16], 16));
  const name = VERSIONS[version];
  const info: Inspection = {
    type: "UUID",
    canonical,
    version: name ? `Version ${version} (${name})` : `Version ${version} (not defined)`,
    variant,
  };
  if (variant === "RFC 9562") {
    if (version === 7) info.timeMs = parseInt(hex.slice(0, 12), 16);
    if (version === 1 || version === 6) {
      const ts =
        version === 1
          ? (BigInt(`0x${hex.slice(13, 16)}`) << 48n) |
            (BigInt(`0x${hex.slice(8, 12)}`) << 32n) |
            BigInt(`0x${hex.slice(0, 8)}`)
          : (BigInt(`0x${hex.slice(0, 8)}`) << 28n) |
            (BigInt(`0x${hex.slice(8, 12)}`) << 12n) |
            BigInt(`0x${hex.slice(13, 16)}`);
      info.timeMs = Number((ts - GREGORIAN_OFFSET) / 10000n);
    }
  }
  return { ok: true, info };
}

function inspectUlid(text: string): InspectResult {
  const upper = text.toUpperCase();
  for (const c of upper) {
    if (!CROCKFORD.includes(c)) {
      return {
        ok: false,
        error: /[ILOU]/.test(c)
          ? `ULIDs use Crockford base32; "${c}" isn't allowed.`
          : `"${c}" can't appear in a ULID; it uses the digits and the letters A to Z without I, L, O and U.`,
      };
    }
  }
  if (upper[0] > "7")
    return { ok: false, error: "A ULID can't start with a character above 7; this one is too large." };
  let value = 0n;
  for (const c of upper) value = (value << 5n) | BigInt(CROCKFORD.indexOf(c));
  return {
    ok: true,
    info: { type: "ULID", canonical: upper, version: "ULID", variant: "", timeMs: Number(value >> 80n) },
  };
}

/** Reads a pasted UUID (hyphens, braces, `urn:uuid:` and any case allowed) or ULID. */
export function inspectId(text: string): InspectResult {
  let t = text.trim();
  if (t === "") return { ok: false, error: "Paste a UUID or a ULID to see what's in it." };
  t = t.replace(/^urn:uuid:/i, "");
  if (t.startsWith("{") && t.endsWith("}")) t = t.slice(1, -1);
  if (t.length === 26 && !t.includes("-")) return inspectUlid(t);
  if (/^[0-9a-f-]+$/i.test(t) || t.includes("-")) {
    const bad = /[^0-9a-f-]/i.exec(t);
    if (bad) return { ok: false, error: `"${bad[0]}" isn't a hex digit, so this isn't a UUID.` };
    const hex = t.replace(/-/g, "").toLowerCase();
    if (hex.length !== 32) return { ok: false, error: `A UUID has 32 hex digits; this has ${hex.length}.` };
    if (t.includes("-") && t.toLowerCase() !== hyphenate(hex)) {
      return { ok: false, error: "The hyphens are in the wrong places; a UUID is written 8-4-4-4-12." };
    }
    return inspectUuid(hex);
  }
  return {
    ok: false,
    error: "This isn't a UUID or a ULID. A UUID has 32 hex digits (8-4-4-4-12); a ULID has 26 characters.",
  };
}
