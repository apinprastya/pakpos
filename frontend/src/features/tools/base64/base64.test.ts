import {
  bytesToBase64,
  bytesToText,
  decodeBase64,
  encodeBase64,
  looksLikeBase64,
  MAX_HEX_BYTES,
  toHex,
  transformBase64,
  type EncodeOptions,
} from "./base64";

const STD: EncodeOptions = { alphabet: "standard", padding: true };
const text = (r: ReturnType<typeof decodeBase64>) => (r.ok ? bytesToText(r.bytes) : `error: ${r.message}`);

describe("encodeBase64", () => {
  it.each<[string, EncodeOptions, string]>([
    ["", STD, ""],
    ["f", STD, "Zg=="],
    ["fo", STD, "Zm8="],
    ["foo", STD, "Zm9v"],
    ["f", { alphabet: "standard", padding: false }, "Zg"],
    ["Zoë 🚀", STD, "Wm/DqyDwn5qA"],
    ["Zoë 🚀", { alphabet: "url", padding: true }, "Wm_DqyDwn5qA"],
    ["??>", STD, "Pz8+"],
    ["??>", { alphabet: "url", padding: false }, "Pz8-"],
    ["ÿþ?", { alphabet: "url", padding: false }, "w7_Dvj8"],
  ])("%j with %j", (input, opts, want) => {
    expect(encodeBase64(input, opts)).toBe(want);
  });
});

describe("decodeBase64", () => {
  it.each<[string, string]>([
    ["", ""],
    ["Zg==", "f"],
    ["Zg", "f"],
    ["Zm8", "fo"],
    ["Wm/DqyDwn5qA", "Zoë 🚀"],
    ["Wm_DqyDwn5qA", "Zoë 🚀"],
    ["Pz8+Pz8-", "??>??>"],
    ["  Zm9v\nYmFy\r\n  ", "foobar"],
    ["Zm9v YmFy", "foobar"],
    ["Zg= =", "f"],
    ["Zm9=", "fo"],
  ])("%j", (input, want) => {
    expect(text(decodeBase64(input))).toBe(want);
  });

  it.each<[string, string, number]>([
    ["Zm9v#", 'Character 5 isn\'t valid Base64: "#".', 4],
    ["Zm\n.9v", 'Character 4 isn\'t valid Base64: ".".', 3],
    ["Zg===", 'Character 5: Base64 has at most two "=" at the end.', 4],
    ["Zg==Zg", 'Character 3: "=" can only come at the end of Base64.', 2],
    [
      "Zg=",
      'Character 3: the "=" padding doesn\'t match the length. Remove it, or check for a missing character.',
      2,
    ],
    ["Zm9vY", "5 Base64 characters can't be decoded: the input is cut off or has an extra character.", 5],
    ["Zé", 'Character 2 isn\'t valid Base64: "é".', 1],
  ])("explains %j", (input, message, offset) => {
    expect(decodeBase64(input)).toEqual({ ok: false, message, offset });
  });

  it("decodes binary and round-trips large input", () => {
    const r = decodeBase64("AAH/");
    expect(r.ok && Array.from(r.bytes)).toEqual([0, 1, 255]);
    expect(r.ok && bytesToText(r.bytes)).toBeNull();
    const big = "x".repeat(3_000_001);
    const enc = encodeBase64(big, STD);
    expect(enc.length).toBe(4_000_004);
    expect(text(decodeBase64(enc))).toBe(big);
  });
});

describe("helpers", () => {
  it("writes bytes as standard Base64 and as hex", () => {
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff]))).toBe("+/8=");
    const bytes = new Uint8Array(20).map((_, i) => i * 13);
    expect(toHex(bytes)).toBe("00 0d 1a 27 34 41 4e 5b 68 75 82 8f 9c a9 b6 c3\nd0 dd ea f7");
    expect(toHex(bytes, 3)).toBe("00 0d 1a");
    expect(toHex(new Uint8Array())).toBe("");
  });

  it.each<[string, boolean]>([
    ["Zm9vYmFy", true],
    ["  Zm9v\nYmFy  ", true],
    ["Zg==", true],
    ["Wm_DqyDwn5qA", true],
    ["Zg=", false],
    ["Zm9=", true],
    ["abc", false],
    ["Zm9vY", false],
    ["Zm9v#", false],
    ["Zg===", false],
    ["Zg==Zg", false],
    ["", false],
  ])("looksLikeBase64(%j) is %s", (input, want) => {
    expect(looksLikeBase64(input)).toBe(want);
  });

  it("transforms text, binary and errors", () => {
    expect(transformBase64("hi", "encode", STD)).toEqual({ kind: "text", text: "aGk=" });
    expect(transformBase64("", "encode", STD)).toEqual({ kind: "text", text: "" });
    expect(transformBase64("aGk", "decode", STD)).toEqual({ kind: "text", text: "hi" });
    expect(transformBase64("AAH/", "decode", STD)).toMatchObject({ kind: "binary", hex: "00 01 ff" });
    expect(transformBase64("#", "decode", STD)).toEqual({
      kind: "error",
      message: 'Character 1 isn\'t valid Base64: "#".',
    });
    const big = transformBase64(bytesToBase64(new Uint8Array(MAX_HEX_BYTES + 10).fill(255)), "decode", STD);
    expect(big.kind === "binary" && big.hex.split(/\s+/).length).toBe(MAX_HEX_BYTES);
  });
});
