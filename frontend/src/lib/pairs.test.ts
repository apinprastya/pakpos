import { bulkToRows, parsePastedPairs, rowsToBulk } from "./pairs";

const kv = (key: string, value: string, enabled = true) => ({ key, value, enabled });

describe("pairs", () => {
  it.each([
    ["", null],
    ["plain value", null],
    ["https://x.dev/a", null],
    ["Accept: application/json", [kv("Accept", "application/json")]],
    ["a=1&b=2&c", [kv("a", "1"), kv("b", "2"), kv("c", "")]],
    ["?a=1&b=2", [kv("a", "1"), kv("b", "2")]],
    ["A: 1\nB=2\n\nC", [kv("A", "1"), kv("B", "2"), kv("C", "")]],
    ["X-Url: http://a=b", [kv("X-Url", "http://a=b")]],
  ])("parsePastedPairs(%j)", (text, want) => {
    expect(parsePastedPairs(text)).toEqual(want);
  });

  it("round-trips bulk text with disabled rows", () => {
    const rows = [kv("A", "1"), kv("B", "two words", false), kv("", "")];
    const text = rowsToBulk(rows);
    expect(text).toBe("A: 1\n//B: two words");
    expect(bulkToRows(text + "\n\n")).toEqual([kv("A", "1"), kv("B", "two words", false)]);
  });
});
