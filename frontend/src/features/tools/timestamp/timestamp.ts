/**
 * The timestamp converter's logic: reads Unix time (s, ms, µs, ns), RFC 3339 /
 * ISO 8601 and RFC 1123 (HTTP dates), and writes every format back. An instant
 * is kept as BigInt nanoseconds since 1970, so microsecond and nanosecond
 * inputs lose nothing. Pure (the clock and locale are passed in); time zones
 * use Intl only.
 */

export type Unit = "s" | "ms" | "us" | "ns";
/** "auto" picks the unit from the number's size. */
export type UnitOverride = "auto" | Unit;
export type InputKind = Unit | "rfc3339" | "rfc1123";

/** A parsed point in time. */
export interface Instant {
  /** Nanoseconds since 1970-01-01T00:00:00Z. */
  ns: bigint;
  kind: InputKind;
  /** Sub-second digits the input carried (0–9); outputs keep that many. */
  precision: number;
  /** For RFC 3339 without an offset: read in the selected zone. */
  zoneAssumed?: boolean;
}

const UNIT_NS: Record<Unit, bigint> = { s: 1_000_000_000n, ms: 1_000_000n, us: 1_000n, ns: 1n };
const UNIT_DIGITS: Record<Unit, number> = { s: 0, ms: 3, us: 6, ns: 9 };
const NS_PER_MS = 1_000_000n;
const NS_PER_S = 1_000_000_000n;

export const UNIT_NAMES: Record<Unit, string> = {
  s: "seconds",
  ms: "milliseconds",
  us: "microseconds",
  ns: "nanoseconds",
};

/** Floor division and modulo for BigInt (BigInt `/` truncates toward zero). */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}
function floorMod(a: bigint, b: bigint): bigint {
  return a - floorDiv(a, b) * b;
}

/** Date.UTC that also works for years 0–99 (which Date.UTC maps to 1900–1999). */
function utcMs(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number {
  const date = new Date(Date.UTC(2000, mo, d, h, mi, s, ms));
  date.setUTCFullYear(y);
  return date.getTime();
}

/** Every output format can show years 0001 to 9999. */
const MIN_MS = utcMs(1, 0, 1);
const MAX_MS = utcMs(9999, 11, 31, 23, 59, 59, 999);

export const OUT_OF_RANGE =
  "This date is outside the years 0001 to 9999. Check the number, or pick its unit by hand.";

export const UNREADABLE =
  "This isn't a time Pakpos can read. Use Unix time (seconds, ms, µs or ns), RFC 3339 like 2026-11-20T12:00:00Z, or an HTTP date like Sun, 06 Nov 1994 08:49:37 GMT.";

/** The unit "auto" picks for a whole number with this many digits (sign excluded). */
export function detectUnit(intDigits: number): Unit {
  if (intDigits <= 11) return "s"; // up to year 5138
  if (intDigits <= 14) return "ms";
  if (intDigits <= 17) return "us";
  return "ns";
}

const NUMBER = /^([+-]?)(\d+)(?:\.(\d+))?$/;

function parseNumber(text: string, override: UnitOverride): Instant | null {
  const m = NUMBER.exec(text);
  if (!m) return null;
  const [, sign, rawInt, frac = ""] = m;
  const int = rawInt.replace(/^0+(?=\d)/, "");
  const unit = override === "auto" ? detectUnit(int.length) : override;
  const fracDigits = 9 - UNIT_DIGITS[unit];
  const fracNs = fracDigits > 0 ? BigInt((frac + "0".repeat(fracDigits)).slice(0, fracDigits)) : 0n;
  let ns = BigInt(int) * UNIT_NS[unit] + fracNs;
  if (sign === "-") ns = -ns;
  return { ns, kind: unit, precision: Math.min(9, UNIT_DIGITS[unit] + (unit === "ns" ? 0 : frac.length)) };
}

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*([Zz]|[+-]\d{2}(?::?\d{2})?)?$/;

class ReadError extends Error {}

function daysInMonth(y: number, mo: number): number {
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
}

function checkFields(y: number, mo: number, d: number, h: number, mi: number, s: number) {
  if (mo < 1 || mo > 12) throw new ReadError(`Month ${mo} doesn't exist; use 01 to 12.`);
  const days = daysInMonth(y, mo);
  if (d < 1 || d > days) throw new ReadError(`Day ${d} doesn't exist in that month; it has ${days} days.`);
  if (h > 23) throw new ReadError(`Hour ${h} doesn't exist; use 00 to 23.`);
  if (mi > 59) throw new ReadError(`Minute ${mi} doesn't exist; use 00 to 59.`);
  if (s > 59) throw new ReadError(`Second ${s} isn't supported; use 00 to 59 (leap seconds can't be shown).`);
}

/** Offset text ("+07:00", "-0500", "+07", "Z") → minutes east of UTC. */
function offsetMinutes(text: string): number {
  if (/^z$/i.test(text)) return 0;
  const sign = text[0] === "-" ? -1 : 1;
  const digits = text.slice(1).replace(":", "");
  const h = Number(digits.slice(0, 2));
  const m = Number(digits.slice(2) || "0");
  if (h > 23 || m > 59) throw new ReadError(`The offset ${text} isn't valid; use something like +07:00.`);
  return sign * (h * 60 + m);
}

function parseRfc3339(text: string, zone: string): Instant | null {
  const m = RFC3339.exec(text);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "", off] = m;
  checkFields(+y, +mo, +d, +h, +mi, +s);
  const wall = utcMs(+y, +mo - 1, +d, +h, +mi, +s);
  const ms = off !== undefined ? wall - offsetMinutes(off) * 60_000 : wallToUtc(wall, zone);
  const fracNs = BigInt((frac + "000000000").slice(0, 9));
  return {
    ns: BigInt(ms) * NS_PER_MS + fracNs,
    kind: "rfc3339",
    precision: Math.min(9, frac.length),
    zoneAssumed: off === undefined,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RFC1123 = new RegExp(
  `^(?:(?:${DAYS.join("|")})[a-z]*,?\\s*)?(\\d{1,2})[\\s-]+(${MONTHS.join("|")})[a-z]*[\\s-]+(\\d{4})\\s+(\\d{2}):(\\d{2})(?::(\\d{2}))?\\s*(GMT|UTC|UT|Z|[+-]\\d{4})?$`,
  "i",
);

function parseRfc1123(text: string): Instant | null {
  const m = RFC1123.exec(text);
  if (!m) return null;
  const [, d, mon, y, h, mi, s = "0", off = "GMT"] = m;
  const mo = MONTHS.findIndex((x) => x.toLowerCase() === mon.toLowerCase()) + 1;
  checkFields(+y, mo, +d, +h, +mi, +s);
  const wall = utcMs(+y, mo - 1, +d, +h, +mi, +s);
  const minutes = /^[+-]/.test(off) ? offsetMinutes(off) : 0;
  return { ns: BigInt(wall - minutes * 60_000) * NS_PER_MS, kind: "rfc1123", precision: 0 };
}

export type ReadResult = { ok: true; instant: Instant } | { ok: false; message: string };

/**
 * Reads `text` as a point in time. `override` forces the unit of a number;
 * `zone` is used for an RFC 3339 time without an offset. Never throws.
 */
export function readTimestamp(text: string, override: UnitOverride, zone: string): ReadResult {
  const t = text.trim();
  if (t.length > 100) return { ok: false, message: "This is too long to be a timestamp." };
  try {
    const instant = parseNumber(t, override) ?? parseRfc3339(t, zone) ?? parseRfc1123(t);
    if (!instant) return { ok: false, message: UNREADABLE };
    const ms = Number(floorDiv(instant.ns, NS_PER_MS));
    if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) return { ok: false, message: OUT_OF_RANGE };
    return { ok: true, instant };
  } catch (e) {
    if (e instanceof ReadError) return { ok: false, message: e.message };
    throw e;
  }
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let f = zoneFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    zoneFormatters.set(zone, f);
  }
  return f;
}

/** The zone's offset from UTC at instant `ms`, in milliseconds (positive east of UTC). */
export function zoneOffsetMs(ms: number, zone: string): number {
  const parts: Record<string, number> = {};
  for (const p of zoneFormatter(zone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const wall = utcMs(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wall - (ms - (((ms % 1000) + 1000) % 1000));
}

/** The instant whose wall-clock time in `zone` is `wall` (read as UTC). */
export function wallToUtc(wall: number, zone: string): number {
  const guess = wall - zoneOffsetMs(wall, zone);
  return wall - zoneOffsetMs(guess, zone);
}

/** The system time zone, or "UTC" when Intl can't tell. */
export function systemZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** `zone` when Intl knows it; otherwise the system zone. "" means the system zone. */
export function validZone(zone: string): string {
  if (!zone) return systemZone();
  try {
    zoneFormatter(zone);
    return zone;
  } catch {
    return systemZone();
  }
}

const FALLBACK_ZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Jakarta",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
];

/** Zones for the select: Intl's list (or a short fallback), with UTC and `include` always present. */
export function timeZones(include: string[] = []): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  let list: string[];
  try {
    list = intl.supportedValuesOf?.("timeZone") ?? FALLBACK_ZONES;
  } catch {
    list = FALLBACK_ZONES;
  }
  const out = new Set(["UTC", ...include.filter(Boolean), ...list]);
  return [...out].sort((a, b) => (a === "UTC" ? -1 : b === "UTC" ? 1 : a.localeCompare(b)));
}

/** `ns` in `unit` as a decimal, keeping `precision` sub-second digits where the unit has room. */
export function unixIn(ns: bigint, unit: Unit, precision: number): string {
  const digits = Math.max(0, precision - UNIT_DIGITS[unit]);
  const neg = ns < 0n;
  const abs = neg ? -ns : ns;
  const q = abs / UNIT_NS[unit];
  const r = abs % UNIT_NS[unit];
  const frac = digits
    ? "." +
      r
        .toString()
        .padStart(9 - UNIT_DIGITS[unit], "0")
        .slice(0, digits)
    : "";
  return (neg && abs !== 0n ? "-" : "") + q.toString() + frac;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** ".123", ".123456" or ".123456789" for the precision (none for 0). */
function fraction(ns: bigint, precision: number): string {
  if (precision <= 0) return "";
  const digits = Math.ceil(precision / 3) * 3;
  return "." + floorMod(ns, NS_PER_S).toString().padStart(9, "0").slice(0, digits);
}

function wallParts(ms: number) {
  const d = new Date(ms);
  return {
    date: `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
    d,
  };
}

/** RFC 3339 in UTC ("Z"), or in `zone` with its offset ("+07:00"). */
export function rfc3339(ns: bigint, precision: number, zone?: string): string {
  const ms = Number(floorDiv(ns, NS_PER_MS));
  const offset = zone ? zoneOffsetMs(ms, zone) : 0;
  const { date, time } = wallParts(ms + offset);
  let suffix = "Z";
  if (zone) {
    const minutes = Math.round(offset / 60_000);
    const abs = Math.abs(minutes);
    suffix = `${minutes < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  }
  return `${date}T${time}${fraction(ns, precision)}${suffix}`;
}

/** The HTTP date format: "Sun, 06 Nov 1994 08:49:37 GMT". */
export function rfc1123(ns: bigint): string {
  const { d, time } = wallParts(Number(floorDiv(ns, NS_PER_MS)));
  return `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCFullYear(), 4)} ${time} GMT`;
}

/** A readable date and time in a zone, in the locale's words. */
export function humanTime(ms: number, zone: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "long", timeZone: zone }).format(
    new Date(ms),
  );
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1000],
];

/** "3 days ago", "in 2 hours", "now". */
export function relative(ms: number, now: number): string {
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const diff = ms - now;
  const abs = Math.abs(diff);
  const found = RELATIVE_UNITS.find(([, size]) => abs >= size);
  if (!found) return rtf.format(0, "second");
  const [unit, size] = found;
  return rtf.format(Math.round(diff / size), unit);
}

export interface OutputRow {
  id: string;
  label: string;
  value: string;
  /** Code-like values (Unix numbers, RFC strings) show in the monospace font. */
  mono: boolean;
}

export type Conversion =
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "ok"; detected: string; rows: OutputRow[]; instant: Instant };

/** What the input was read as, in words. */
export function describeKind(instant: Instant, zone: string, auto: boolean): string {
  switch (instant.kind) {
    case "rfc3339":
      return instant.zoneAssumed
        ? `Read as ISO 8601 without an offset, so as a time in ${zone}`
        : "Read as RFC 3339 / ISO 8601";
    case "rfc1123":
      return "Read as an HTTP date (RFC 1123)";
    default:
      return `Read as Unix ${UNIT_NAMES[instant.kind]}${auto ? " (picked from the number's size)" : ""}`;
  }
}

/** Reads the input and writes it in every format. `now` and `locale` keep it testable. */
export function convertTimestamp(
  text: string,
  opts: { unit: UnitOverride; zone: string; now: number; locale?: string },
): Conversion {
  if (text.trim() === "") return { kind: "empty" };
  const zone = validZone(opts.zone);
  const read = readTimestamp(text, opts.unit, zone);
  if (!read.ok) return { kind: "error", message: read.message };
  const { instant } = read;
  const { ns, precision } = instant;
  const ms = Number(floorDiv(ns, NS_PER_MS));
  const rows: OutputRow[] = [
    { id: "s", label: "Unix seconds", value: unixIn(ns, "s", precision), mono: true },
    { id: "ms", label: "Unix milliseconds", value: unixIn(ns, "ms", precision), mono: true },
    { id: "us", label: "Unix microseconds", value: unixIn(ns, "us", precision), mono: true },
    { id: "ns", label: "Unix nanoseconds", value: unixIn(ns, "ns", precision), mono: true },
    { id: "rfc3339-utc", label: "RFC 3339, UTC", value: rfc3339(ns, precision), mono: true },
    { id: "rfc3339-zone", label: `RFC 3339 in ${zone}`, value: rfc3339(ns, precision, zone), mono: true },
    { id: "rfc1123", label: "HTTP date (RFC 1123)", value: rfc1123(ns), mono: true },
    { id: "local", label: `Local time in ${zone}`, value: humanTime(ms, zone, opts.locale), mono: false },
    { id: "utc", label: "UTC", value: humanTime(ms, "UTC", opts.locale), mono: false },
    { id: "relative", label: "Relative", value: relative(ms, opts.now), mono: false },
  ];
  const isNumber = instant.kind !== "rfc3339" && instant.kind !== "rfc1123";
  return {
    kind: "ok",
    detected: describeKind(instant, zone, isNumber && opts.unit === "auto"),
    rows,
    instant,
  };
}
