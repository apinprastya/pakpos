import { normalizeHashResult } from "@/lib/toolModel";
import { byteCount, fileName, hashRequest, isInsecure } from "./hash";
import { hashInitialState, hashWithInput, restoreHashState } from "./state";

describe("hash tool logic", () => {
  it.each([
    ["md5", true],
    ["sha1", true],
    ["sha256", false],
    ["sha512", false],
  ] as const)("%s insecure: %s", (id, want) => {
    expect(isInsecure(id)).toBe(want);
  });

  it.each([
    ["/home/a/file.iso", "file.iso"],
    ["C:\\Users\\a\\data.bin", "data.bin"],
    ["plain", "plain"],
    ["/dir/", "/dir/"],
  ])("fileName(%j)", (path, want) => {
    expect(fileName(path)).toBe(want);
  });

  it.each([
    [0, "0 bytes"],
    [1, "1 byte"],
    [2048, "2,048 bytes"],
  ])("byteCount(%d)", (n, want) => {
    expect(byteCount(n)).toBe(want);
  });

  it("builds the request for text or a file, sending the key only with HMAC", () => {
    const s = { ...hashInitialState("abc"), filePath: "/f", key: "{{k}}", keyFormat: "hex" as const };
    expect(hashRequest(s, "resolved")).toEqual({
      algorithm: "sha256",
      text: "abc",
      filePath: "",
      hmac: false,
      key: "",
      keyFormat: "hex",
    });
    expect(hashRequest({ ...s, source: "file", hmac: true, algorithm: "md5" }, "resolved")).toEqual({
      algorithm: "md5",
      text: "",
      filePath: "/f",
      hmac: true,
      key: "resolved",
      keyFormat: "hex",
    });
  });

  it("starts empty, takes input as text, and never restores anything", () => {
    const s = { ...hashInitialState(), source: "file" as const, hmac: true };
    expect(hashWithInput(s, "x")).toEqual({ ...s, source: "text", text: "x" });
    expect(restoreHashState()).toEqual(hashInitialState());
  });

  it("normalizes results from Go", () => {
    expect(normalizeHashResult(null)).toEqual({ hex: "", base64: "", bytes: 0 });
    expect(normalizeHashResult({ hex: "ab", base64: "qw==", bytes: 1 })).toEqual({
      hex: "ab",
      base64: "qw==",
      bytes: 1,
    });
  });
});
