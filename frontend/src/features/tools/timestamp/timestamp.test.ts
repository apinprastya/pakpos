import {
  OUT_OF_RANGE,
  UNREADABLE,
  convertTimestamp,
  detectUnit,
  readTimestamp,
  relative,
  rfc1123,
  rfc3339,
  systemZone,
  timeZones,
  unixIn,
  validZone,
  wallToUtc,
  zoneOffsetMs,
  type UnitOverride,
} from "./timestamp";

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"], now: NOW }));
afterEach(() => vi.useRealTimers());

function read(text: string, unit: UnitOverride = "auto", zone = "UTC") {
  const r = readTimestamp(text, unit, zone);
  if (!r.ok) throw new Error(r.message);
  return r.instant;
}

describe("reading Unix time", () => {
  it.each<[string, UnitOverride, bigint, string, number]>([
    ["0", "auto", 0n, "s", 0],
    ["1700000000", "auto", 1_700_000_000_000_000_000n, "s", 0],
    ["1700000000.5", "auto", 1_700_000_000_500_000_000n, "s", 1],
    ["1700000000123", "auto", 1_700_000_000_123_000_000n, "ms", 3],
    ["1700000000123456", "auto", 1_700_000_000_123_456_000n, "us", 6],
    ["1700000000123456789", "auto", 1_700_000_000_123_456_789n, "ns", 9],
    ["-86400", "auto", -86_400_000_000_000n, "s", 0],
    ["+60", "auto", 60_000_000_000n, "s", 0],
    ["000001700000000", "auto", 1_700_000_000_000_000_000n, "s", 0],
    ["1700000000", "ms", 1_700_000_000_000_000n, "ms", 3],
    ["1700000000.1234", "ms", 1_700_000_000_123_400n, "ms", 7],
    ["17", "ns", 17n, "ns", 9],
    ["1.9", "ns", 1n, "ns", 9],
    ["  42  ", "us", 42_000n, "us", 6],
  ])("%j as %s", (text, unit, ns, kind, precision) => {
    expect(read(text, unit)).toEqual({ ns, kind, precision });
  });

  it.each<[number, string]>([
    [1, "s"],
    [11, "s"],
    [12, "ms"],
    [14, "ms"],
    [15, "us"],
    [17, "us"],
    [18, "ns"],
    [25, "ns"],
  ])("%d digits read as %s", (digits, unit) => {
    expect(detectUnit(digits)).toBe(unit);
  });
});

describe("reading dates", () => {
  it.each<[string, number, number, boolean | undefined]>([
    ["2026-11-20T12:00:00Z", NOW, 0, false],
    ["2026-11-20t12:00:00z", NOW, 0, false],
    ["2026-11-20 19:00:00+07:00", NOW, 0, false],
    ["2026-11-20T07:00:00-0500", NOW, 0, false],
    ["2026-11-20T13:00+01", NOW, 0, false],
    ["2026-11-20T12:00:00.123Z", NOW + 123, 3, false],
    ["2026-11-20T12:00:00,5Z", NOW + 500, 1, false],
    ["2026-11-20T12:00:00Z", NOW, 0, false],
    ["2026-11-20", Date.UTC(2026, 10, 20), 0, true],
    ["2026-11-20T12:00", NOW, 0, true],
    ["1969-07-20T20:17:40Z", Date.UTC(1969, 6, 20, 20, 17, 40), 0, false],
  ])("%j", (text, ms, precision, zoneAssumed) => {
    const i = read(text);
    expect(i.kind).toBe("rfc3339");
    expect(i.ns / 1_000_000n).toBe(BigInt(ms));
    expect(i.precision).toBe(precision);
    expect(i.zoneAssumed).toBe(zoneAssumed);
  });

  it("keeps nanoseconds from a fractional RFC 3339 time", () => {
    expect(read("1970-01-01T00:00:00.123456789Z").ns).toBe(123_456_789n);
    expect(read("1970-01-01T00:00:00.1234567891Z").ns).toBe(123_456_789n);
  });

  it("reads a time without an offset in the selected zone, across DST", () => {
    // New York is UTC-5 in winter and UTC-4 in summer.
    expect(read("2026-01-15T09:00:00", "auto", "America/New_York").ns / 1_000_000n).toBe(
      BigInt(Date.UTC(2026, 0, 15, 14)),
    );
    expect(read("2026-07-15T09:00:00", "auto", "America/New_York").ns / 1_000_000n).toBe(
      BigInt(Date.UTC(2026, 6, 15, 13)),
    );
    expect(read("2026-11-20", "auto", "Asia/Jakarta").ns / 1_000_000n).toBe(
      BigInt(Date.UTC(2026, 10, 19, 17)),
    );
  });

  it.each<[string, number]>([
    ["Sun, 06 Nov 1994 08:49:37 GMT", Date.UTC(1994, 10, 6, 8, 49, 37)],
    ["sunday, 6 nov 1994 08:49:37 utc", Date.UTC(1994, 10, 6, 8, 49, 37)],
    ["06 Nov 1994 08:49 GMT", Date.UTC(1994, 10, 6, 8, 49)],
    ["Sunday, 06-Nov-1994 08:49:37 GMT", Date.UTC(1994, 10, 6, 8, 49, 37)],
    ["Sun, 06 Nov 1994 15:49:37 +0700", Date.UTC(1994, 10, 6, 8, 49, 37)],
    ["Sun, 06 Nov 1994 08:49:37", Date.UTC(1994, 10, 6, 8, 49, 37)],
  ])("HTTP date %j", (text, ms) => {
    const i = read(text);
    expect(i.kind).toBe("rfc1123");
    expect(i.ns).toBe(BigInt(ms) * 1_000_000n);
  });

  it.each<[string, string]>([
    ["", UNREADABLE],
    ["tomorrow", UNREADABLE],
    ["{{now}}", UNREADABLE],
    ["1e9", UNREADABLE],
    ["2026-13-01", "Month 13 doesn't exist; use 01 to 12."],
    ["2026-02-30", "Day 30 doesn't exist in that month; it has 28 days."],
    ["2024-02-30", "Day 30 doesn't exist in that month; it has 29 days."],
    ["2026-11-20T24:00:00Z", "Hour 24 doesn't exist; use 00 to 23."],
    ["2026-11-20T12:60:00Z", "Minute 60 doesn't exist; use 00 to 59."],
    ["2026-12-31T23:59:60Z", "Second 60 isn't supported; use 00 to 59 (leap seconds can't be shown)."],
    ["2026-11-20T12:00:00+25:00", "The offset +25:00 isn't valid; use something like +07:00."],
    ["32 Nov 1994 08:49:37 GMT", "Day 32 doesn't exist in that month; it has 30 days."],
    ["0000-01-01T00:00:00Z", OUT_OF_RANGE],
    ["9".repeat(25), OUT_OF_RANGE],
    ["-" + "9".repeat(25), OUT_OF_RANGE],
    ["1900-02-29", "Day 29 doesn't exist in that month; it has 28 days."],
    ["1".repeat(101), "This is too long to be a timestamp."],
  ])("explains %j", (text, message) => {
    expect(readTimestamp(text, "auto", "UTC")).toEqual({ ok: false, message });
  });

  it("accepts the edges of the range", () => {
    expect(read("0001-01-01T00:00:00Z").ns).toBe(-62_135_596_800_000_000_000n);
    expect(read("9999-12-31T23:59:59.999999999Z").ns).toBe(253_402_300_799_999_999_999n);
    expect(readTimestamp("1", "ms", "UTC").ok).toBe(true);
    expect(readTimestamp("2000-02-29", "auto", "UTC").ok).toBe(true);
    expect(readTimestamp("99999999999", "auto", "UTC").ok).toBe(true);
  });
});

describe("writing", () => {
  it.each<[bigint, "s" | "ms" | "us" | "ns", number, string]>([
    [1_700_000_000_123_456_789n, "s", 9, "1700000000.123456789"],
    [1_700_000_000_123_456_789n, "ms", 9, "1700000000123.456789"],
    [1_700_000_000_123_456_789n, "us", 9, "1700000000123456.789"],
    [1_700_000_000_123_456_789n, "ns", 9, "1700000000123456789"],
    [1_700_000_000_000_000_000n, "s", 0, "1700000000"],
    [1_700_000_000_000_000_000n, "ms", 0, "1700000000000"],
    [1_700_000_000_500_000_000n, "s", 1, "1700000000.5"],
    [-1_500_000_000n, "s", 1, "-1.5"],
    [-86_400_000_000_000n, "s", 0, "-86400"],
    [0n, "s", 3, "0.000"],
  ])("unixIn(%s, %s, %d)", (ns, unit, precision, want) => {
    expect(unixIn(ns, unit, precision)).toBe(want);
  });

  it("writes RFC 3339 in UTC and in a zone, with the input's precision", () => {
    const ns = BigInt(NOW) * 1_000_000n + 123_456n;
    expect(rfc3339(ns, 0)).toBe("2026-11-20T12:00:00Z");
    expect(rfc3339(ns, 6)).toBe("2026-11-20T12:00:00.000123Z");
    expect(rfc3339(ns, 4)).toBe("2026-11-20T12:00:00.000123Z");
    expect(rfc3339(ns, 9, "Asia/Jakarta")).toBe("2026-11-20T19:00:00.000123456+07:00");
    expect(rfc3339(ns, 0, "America/New_York")).toBe("2026-11-20T07:00:00-05:00");
    expect(rfc3339(BigInt(Date.UTC(2026, 6, 1)) * 1_000_000n, 0, "America/New_York")).toBe(
      "2026-06-30T20:00:00-04:00",
    );
    expect(rfc3339(BigInt(NOW) * 1_000_000n, 0, "Asia/Kolkata")).toBe("2026-11-20T17:30:00+05:30");
    expect(rfc3339(-1n, 9)).toBe("1969-12-31T23:59:59.999999999Z");
    expect(rfc3339(-62_135_596_800_000_000_000n, 0)).toBe("0001-01-01T00:00:00Z");
  });

  it("writes HTTP dates", () => {
    expect(rfc1123(BigInt(Date.UTC(1994, 10, 6, 8, 49, 37)) * 1_000_000n)).toBe(
      "Sun, 06 Nov 1994 08:49:37 GMT",
    );
    expect(rfc1123(-62_135_596_800_000_000_000n)).toBe("Mon, 01 Jan 0001 00:00:00 GMT");
  });

  it.each<[number, string]>([
    [0, "now"],
    [-500, "now"],
    [-45_000, "45 seconds ago"],
    [-3 * 60_000, "3 minutes ago"],
    [2 * 3_600_000, "in 2 hours"],
    [-3 * 86_400_000, "3 days ago"],
    [-86_400_000, "yesterday"],
    [14 * 86_400_000, "in 2 weeks"],
    [-60 * 86_400_000, "2 months ago"],
    [-2 * 365 * 86_400_000, "2 years ago"],
  ])("relative(%d)", (diff, want) => {
    expect(relative(NOW + diff, NOW)).toBe(want);
  });
});

describe("zones", () => {
  it("computes offsets and wall times, including DST", () => {
    expect(zoneOffsetMs(NOW, "UTC")).toBe(0);
    expect(zoneOffsetMs(NOW, "Asia/Jakarta")).toBe(7 * 3_600_000);
    expect(zoneOffsetMs(NOW, "America/New_York")).toBe(-5 * 3_600_000);
    expect(zoneOffsetMs(Date.UTC(2026, 6, 1), "America/New_York")).toBe(-4 * 3_600_000);
    expect(zoneOffsetMs(NOW + 999, "Asia/Jakarta")).toBe(7 * 3_600_000);
    expect(wallToUtc(Date.UTC(2026, 10, 20, 19), "Asia/Jakarta")).toBe(NOW);
  });

  it("falls back to the system zone for unknown or empty zones", () => {
    expect(validZone("Asia/Jakarta")).toBe("Asia/Jakarta");
    expect(validZone("")).toBe(systemZone());
    expect(validZone("Mars/Olympus")).toBe(systemZone());
  });

  it("lists zones with UTC first and always includes the given ones", () => {
    const list = timeZones(["Custom/Zone", ""]);
    expect(list[0]).toBe("UTC");
    expect(list).toContain("Asia/Jakarta");
    expect(list).toContain("Custom/Zone");
    expect(new Set(list).size).toBe(list.length);
  });

  it("uses a short list when Intl has none", () => {
    const intl = Intl as unknown as { supportedValuesOf?: unknown };
    const original = intl.supportedValuesOf;
    try {
      intl.supportedValuesOf = undefined;
      expect(timeZones()).toContain("Europe/London");
      intl.supportedValuesOf = () => {
        throw new Error("no");
      };
      expect(timeZones()).toContain("Asia/Tokyo");
    } finally {
      intl.supportedValuesOf = original;
    }
  });

  it("system zone falls back to UTC when Intl can't tell", () => {
    const spy = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => {
      throw new Error("no");
    });
    expect(systemZone()).toBe("UTC");
    spy.mockRestore();
  });
});

describe("convertTimestamp", () => {
  const opts = { unit: "auto" as const, zone: "Asia/Jakarta", now: NOW, locale: "en-US" };

  it("writes every format and says how the input was read", () => {
    const r = convertTimestamp("1700000000123", opts);
    if (r.kind !== "ok") throw new Error(r.kind);
    expect(r.detected).toBe("Read as Unix milliseconds (picked from the number's size)");
    expect(Object.fromEntries(r.rows.map((row) => [row.id, row.value]))).toEqual({
      s: "1700000000.123",
      ms: "1700000000123",
      us: "1700000000123000",
      ns: "1700000000123000000",
      "rfc3339-utc": "2023-11-14T22:13:20.123Z",
      "rfc3339-zone": "2023-11-15T05:13:20.123+07:00",
      rfc1123: "Tue, 14 Nov 2023 22:13:20 GMT",
      local: "Wednesday, November 15, 2023 at 5:13:20 AM GMT+7",
      utc: "Tuesday, November 14, 2023 at 10:13:20 PM UTC",
      relative: "3 years ago",
    });
    expect(r.rows.find((row) => row.id === "rfc3339-zone")!.label).toBe("RFC 3339 in Asia/Jakarta");
  });

  it.each<[string, UnitOverride, string]>([
    ["1700000000", "s", "Read as Unix seconds"],
    ["2026-11-20T12:00:00Z", "auto", "Read as RFC 3339 / ISO 8601"],
    ["2026-11-20T12:00:00Z", "ms", "Read as RFC 3339 / ISO 8601"],
    ["2026-11-20", "auto", "Read as ISO 8601 without an offset, so as a time in Asia/Jakarta"],
    ["Sun, 06 Nov 1994 08:49:37 GMT", "auto", "Read as an HTTP date (RFC 1123)"],
  ])("describes %j (%s)", (text, unit, detected) => {
    const r = convertTimestamp(text, { ...opts, unit });
    expect(r.kind === "ok" && r.detected).toBe(detected);
  });

  it("reports empty and bad input", () => {
    expect(convertTimestamp("  ", opts)).toEqual({ kind: "empty" });
    expect(convertTimestamp("nope", opts)).toEqual({ kind: "error", message: UNREADABLE });
  });

  it("uses the system zone for an unknown zone", () => {
    const r = convertTimestamp("0", { ...opts, zone: "Nowhere/Here" });
    expect(r.kind === "ok" && r.rows.find((row) => row.id === "local")!.label).toBe(
      `Local time in ${systemZone()}`,
    );
  });
});
