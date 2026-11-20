import {
  MAX_COUNT,
  defaultRandom,
  encodeUlid,
  formatId,
  generateIds,
  hyphenate,
  inspectId,
  parseCount,
  ulid,
  uuidV4,
  uuidV7,
  type RandomFill,
} from "./ids";

/** Randomness that fills every byte with `b`. */
const fill =
  (b: number): RandomFill =>
  (bytes) =>
    bytes.fill(b);

/** Randomness counting up from `start` (one value per call), so batches differ. */
function counting(start = 0): RandomFill {
  let n = start;
  return (bytes) => bytes.fill(n++ % 256);
}

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));

describe("ULID", () => {
  // Printed by github.com/oklog/ulid/v2 v2.1.2 (the Go module Pakpos uses):
  // ulid.ULID{}.SetTime(ms) + SetEntropy(bytes), then String().
  it.each<[number, string, string]>([
    [0, "00000000000000000000", "00000000000000000000000000"],
    [1469918176385, "798d114c4f4380a2421a", "01ARYZ6S41F66H2K2F8E0A4GGT"],
    [1763640000000, "0102030405060708090a", "01KAGJ5FG0041061050R3GG28A"],
    [281474976710655, "ffffffffffffffffffff", "7ZZZZZZZZZZZZZZZZZZZZZZZZZ"],
  ])("matches Go for %d / %s", (ms, entropy, want) => {
    expect(encodeUlid(ms, hex(entropy))).toBe(want);
    const back = inspectId(want);
    expect(back.ok && back.info.timeMs).toBe(ms);
  });

  it("uses fresh randomness", () => {
    expect(ulid(1469918176385, () => hex("798d114c4f4380a2421a"))).toBe("01ARYZ6S41F66H2K2F8E0A4GGT");
    expect(ulid(0)).toMatch(/^0{10}[0-9A-HJKMNP-TV-Z]{16}$/);
  });
});

describe("UUIDs", () => {
  it("v4 sets the version and variant bits", () => {
    expect(uuidV4(fill(0xff))).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(uuidV4(fill(0))).toBe("00000000-0000-4000-8000-000000000000");
    expect(uuidV4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("v7 starts with the time in milliseconds", () => {
    // RFC 9562 appendix A.6: 2022-02-22T19:22:22Z is 0x017F22E279B0.
    expect(uuidV7(0x017f22e279b0, fill(0))).toBe("017f22e2-79b0-7000-8000-000000000000");
    expect(uuidV7(0x017f22e279b0, fill(0xff))).toBe("017f22e2-79b0-7fff-bfff-ffffffffffff");
  });

  it("formats with case and hyphens; ULIDs never get hyphens removed or added", () => {
    const id = "017f22e2-79b0-7cc3-98c4-dc0c0c07398f";
    expect(formatId(id, "uuid7", { upper: false, hyphens: true })).toBe(id);
    expect(formatId(id, "uuid7", { upper: true, hyphens: false })).toBe("017F22E279B07CC398C4DC0C0C07398F");
    expect(formatId("01ARYZ6S41F66H2K2F8E0A4GGT", "ulid", { upper: false, hyphens: false })).toBe(
      "01aryz6s41f66h2k2f8e0a4ggt",
    );
    expect(hyphenate("0123456789abcdef0123456789abcdef")).toBe("01234567-89ab-cdef-0123-456789abcdef");
  });
});

describe("generateIds", () => {
  const now = 0x017f22e279b0;

  it.each<["uuid4" | "uuid7" | "ulid", RegExp]>([
    ["uuid4", /^[0-9a-f-]{36}$/],
    ["uuid7", /^017f22e2-79b0-7/],
    ["ulid", /^01FWHE4YDG/],
  ])("makes %s batches", (kind, pattern) => {
    const ids = generateIds({ kind, count: 5 }, now, counting());
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    for (const id of ids) expect(id).toMatch(pattern);
  });

  it("sorts time-based batches so they're in order", () => {
    const ids = generateIds({ kind: "ulid", count: 50 }, now, counting(200));
    expect(ids).toEqual([...ids].sort());
    const v7 = generateIds({ kind: "uuid7", count: 50 }, now, counting(200));
    expect(v7).toEqual([...v7].sort());
  });

  it("clamps the count", () => {
    expect(generateIds({ kind: "uuid4", count: 0 })).toEqual([]);
    expect(generateIds({ kind: "uuid4", count: 5000 })).toHaveLength(MAX_COUNT);
    expect(generateIds({ kind: "ulid", count: 2.7 })).toHaveLength(2);
  });

  it("uses crypto randomness by default", () => {
    const a = defaultRandom(new Uint8Array(16));
    const b = defaultRandom(new Uint8Array(16));
    expect(a).not.toEqual(b);
  });
});

describe("parseCount", () => {
  it.each<[string, number | string]>([
    ["1", 1],
    [" 1000 ", 1000],
    ["0", "Enter at least 1."],
    ["1001", "You can generate up to 1,000 IDs at a time."],
    ["", "Enter how many IDs to generate, from 1 to 1,000."],
    ["2.5", "Enter how many IDs to generate, from 1 to 1,000."],
    ["-3", "Enter how many IDs to generate, from 1 to 1,000."],
    ["abc", "Enter how many IDs to generate, from 1 to 1,000."],
  ])("%j", (text, want) => {
    const r = parseCount(text);
    expect(r.ok ? r.count : r.error).toBe(want);
  });
});

describe("inspectId", () => {
  // Times from RFC 9562 appendix A: all three encode 2022-02-22T19:22:22Z.
  const T = Date.UTC(2022, 1, 22, 19, 22, 22);

  it.each<
    [string, Partial<{ type: string; canonical: string; version: string; variant: string; timeMs: number }>]
  >([
    [
      "C232AB00-9414-11EC-B3C8-9F6BDECED846",
      { type: "UUID", version: "Version 1 (time-based)", variant: "RFC 9562", timeMs: T },
    ],
    ["1EC9414C-232A-6B00-B3C8-9F6BDECED846", { version: "Version 6 (reordered time)", timeMs: T }],
    ["017F22E2-79B0-7CC3-98C4-DC0C0C07398F", { version: "Version 7 (Unix time)", timeMs: T }],
    [
      "{urn:uuid:919108f7-52d1-4320-9bac-f847db4148a8}".replace("{urn:uuid:", "urn:uuid:{"),
      { version: "Version 4 (random)", canonical: "919108f7-52d1-4320-9bac-f847db4148a8" },
    ],
    ["{919108F752D143209BACF847DB4148A8}", { canonical: "919108f7-52d1-4320-9bac-f847db4148a8" }],
    ["5df41881-3aed-3515-88a7-2f4a814cf09e", { version: "Version 3 (name-based, MD5)" }],
    ["00000000-0000-0000-0000-000000000000", { version: "Nil UUID", variant: "" }],
    ["FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", { version: "Max UUID" }],
    ["919108f7-52d1-9320-9bac-f847db4148a8", { version: "Version 9 (not defined)" }],
    ["919108f7-52d1-4320-1bac-f847db4148a8", { variant: "NCS (reserved, old)" }],
    ["919108f7-52d1-4320-cbac-f847db4148a8", { variant: "Microsoft (reserved)" }],
    ["919108f7-52d1-4320-ebac-f847db4148a8", { variant: "Reserved for the future" }],
    [
      "01aryz6s41f66h2k2f8e0a4ggt",
      { type: "ULID", canonical: "01ARYZ6S41F66H2K2F8E0A4GGT", timeMs: 1469918176385 },
    ],
  ])("reads %s", (text, want) => {
    const r = inspectId(text);
    if (!r.ok) throw new Error(r.error);
    expect(r.info).toMatchObject(want);
  });

  it("gives no time for non-RFC variants", () => {
    const r = inspectId("017F22E2-79B0-7CC3-18C4-DC0C0C07398F");
    expect(r.ok && r.info.timeMs).toBeUndefined();
  });

  it.each([
    ["", "Paste a UUID or a ULID to see what's in it."],
    ["919108f7-52d1-4320-9bac-f847db4148a", "A UUID has 32 hex digits; this has 31."],
    ["919108f752d143209bacf847db4148a8aa", "A UUID has 32 hex digits; this has 34."],
    [
      "919108f-752d1-4320-9bac-f847db4148a8",
      "The hyphens are in the wrong places; a UUID is written 8-4-4-4-12.",
    ],
    ["919108g7-52d1-4320-9bac-f847db4148a8", "\"g\" isn't a hex digit, so this isn't a UUID."],
    ["01ARYZ6S41F66H2K2F8E0A4GGU", 'ULIDs use Crockford base32; "U" isn\'t allowed.'],
    [
      "01ARYZ6S41F66H2K2F8E0A4GG!",
      '"!" can\'t appear in a ULID; it uses the digits and the letters A to Z without I, L, O and U.',
    ],
    ["8ZZZZZZZZZZZZZZZZZZZZZZZZZ", "A ULID can't start with a character above 7; this one is too large."],
    [
      "hello",
      "This isn't a UUID or a ULID. A UUID has 32 hex digits (8-4-4-4-12); a ULID has 26 characters.",
    ],
  ])("explains %j", (text, error) => {
    const r = inspectId(text);
    expect(r.ok ? "ok" : r.error).toBe(error);
  });
});
