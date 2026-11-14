import { DEFAULT_SETTINGS, normalizeSettings } from "@/lib/model";
import { fromDraft, lowersRetention, parseWhole, toDraft } from "./settingsForm";

describe("settingsForm", () => {
  it("round-trips settings through a draft", () => {
    const s = {
      ...DEFAULT_SETTINGS,
      timeoutMs: 45_000,
      theme: "dark" as const,
      layout: "horizontal" as const,
    };
    const d = toDraft(s);
    expect(d.timeoutSeconds).toBe("45");
    expect(fromDraft(d, s)).toEqual({ settings: s, errors: null });
  });

  it("shows sub-second timeouts with one decimal", () => {
    expect(toDraft({ ...DEFAULT_SETTINGS, timeoutMs: 1500 }).timeoutSeconds).toBe("1.5");
  });

  it.each([
    ["10", 0, 600, 10],
    [" 0 ", 0, 600, 0],
    ["600", 0, 600, 600],
    ["601", 0, 600, null],
    ["-1", 0, 600, null],
    ["1.5", 0, 600, null],
    ["", 0, 600, null],
    ["abc", 0, 600, null],
  ])("parseWhole(%j) = %s", (text, min, max, want) => {
    expect(parseWhole(text, min, max)).toBe(want);
  });

  it("reports every invalid field", () => {
    const d = {
      ...toDraft(DEFAULT_SETTINGS),
      timeoutSeconds: "x",
      maxRedirects: "0",
      historyRetention: "-5",
    };
    const r = fromDraft(d, DEFAULT_SETTINGS);
    expect(r.settings).toBeNull();
    expect(r.errors).toEqual({
      timeoutSeconds: "Enter whole seconds from 0 to 600.",
      maxRedirects: "Enter a number from 1 to 50.",
      historyRetention: "Enter a number from 0 to 100,000.",
    });
  });

  it("ignores an invalid max redirects while redirects are off", () => {
    const base = { ...DEFAULT_SETTINGS, maxRedirects: 7 };
    const d = { ...toDraft(base), followRedirects: false, maxRedirects: "" };
    const r = fromDraft(d, base);
    expect(r.errors).toBeNull();
    expect(r.settings?.maxRedirects).toBe(7);
    expect(r.settings?.followRedirects).toBe(false);
  });

  it.each([
    [500, "100", true],
    [500, "500", false],
    [500, "900", false],
    [500, "0", false],
    [0, "100", true],
    [500, "oops", false],
  ])("lowersRetention(saved=%i, draft=%j) = %s", (saved, draft, want) => {
    const s = { ...DEFAULT_SETTINGS, historyRetention: saved };
    expect(lowersRetention({ ...toDraft(s), historyRetention: draft }, s)).toBe(want);
  });

  it("normalizeSettings fills zero-value enums and missing fields from defaults", () => {
    expect(
      normalizeSettings({ theme: "" as never, layout: "" as never, timeoutMs: 0 }, DEFAULT_SETTINGS),
    ).toEqual({
      ...DEFAULT_SETTINGS,
      timeoutMs: 0,
    });
    expect(normalizeSettings(null, DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    const full = {
      theme: "light" as const,
      layout: "horizontal" as const,
      timeoutMs: 1,
      followRedirects: false,
      maxRedirects: 2,
      verifyTls: false,
      historyRetention: 3,
    };
    expect(normalizeSettings(full, DEFAULT_SETTINGS)).toEqual(full);
  });
});
