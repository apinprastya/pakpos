import { MAX_RECENT, pushRecent, readRecent } from "./recent";

describe("palette recent list", () => {
  it("keeps the newest first, without duplicates, per workspace", () => {
    expect(readRecent("w1")).toEqual([]);
    pushRecent("w1", "request:a");
    pushRecent("w1", "request:b");
    expect(pushRecent("w1", "request:a")).toEqual(["request:a", "request:b"]);
    expect(readRecent("w1")).toEqual(["request:a", "request:b"]);
    expect(readRecent("w2")).toEqual([]);
    pushRecent("", "action:x");
    expect(readRecent("")).toEqual(["action:x"]);
    expect(localStorage.getItem("pakpos-palette-recent:none")).toBe('["action:x"]');
  });

  it("caps the list", () => {
    for (let i = 0; i < MAX_RECENT + 5; i++) pushRecent("w1", `request:${i}`);
    expect(readRecent("w1")).toHaveLength(MAX_RECENT);
    expect(readRecent("w1")[0]).toBe(`request:${MAX_RECENT + 4}`);
  });

  it("survives bad data and unavailable storage", () => {
    localStorage.setItem("pakpos-palette-recent:w1", "{not json");
    expect(readRecent("w1")).toEqual([]);
    localStorage.setItem("pakpos-palette-recent:w1", JSON.stringify({ a: 1 }));
    expect(readRecent("w1")).toEqual([]);
    localStorage.setItem("pakpos-palette-recent:w1", JSON.stringify(["ok", 3]));
    expect(readRecent("w1")).toEqual(["ok"]);

    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(pushRecent("w1", "x")).toEqual(["x", "ok"]);
    set.mockRestore();
  });
});
