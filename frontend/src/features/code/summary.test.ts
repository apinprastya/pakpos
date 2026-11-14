import { emptyAuth, emptyRequest, type Body } from "@/lib/model";
import { addedHeadersNote, authSummary, bodySummary, codeNotes, looksLikeCurl } from "./summary";

const body = (patch: Partial<Body>): Body => ({ ...emptyRequest().body, ...patch });

describe("looksLikeCurl", () => {
  it.each([
    ["curl https://a.com", true],
    ["  \n curl -X POST x", true],
    ['CURL.exe ^"x^"', true],
    ["curl\thttps://a", true],
    ["curly https://a", false],
    ["https://curl.se", false],
    ["curl", false],
  ])("%j → %s", (text, want) => expect(looksLikeCurl(text)).toBe(want));
});

describe("summaries", () => {
  it("describes bodies", () => {
    expect(bodySummary(body({ type: "none" }))).toBe("No body");
    expect(bodySummary(body({ type: "raw", language: "json", raw: "{}" }))).toBe("JSON · 2 characters");
    expect(bodySummary(body({ type: "raw", language: "yaml" as never, raw: "a" }))).toBe(
      "Text · 1 character",
    );
    const kv = { key: "a", value: "1", enabled: true };
    expect(bodySummary(body({ type: "urlencoded", urlEncoded: [kv, kv] }))).toBe(
      "URL-encoded form · 2 fields",
    );
    const text = { key: "a", kind: "text" as const, value: "", filePath: "", contentType: "", enabled: true };
    expect(bodySummary(body({ type: "form-data", formData: [text] }))).toBe("Multipart form · 1 field");
    expect(bodySummary(body({ type: "form-data", formData: [text, { ...text, kind: "file" }] }))).toBe(
      "Multipart form · 2 fields, 1 file",
    );
    expect(bodySummary(body({ type: "binary", binaryPath: "/a.bin" }))).toBe("File · /a.bin");
  });

  it("describes auth", () => {
    const a = emptyAuth();
    expect(authSummary(a)).toBe("None");
    expect(authSummary({ ...a, type: "basic", username: "jane" })).toBe("Basic auth as jane");
    expect(authSummary({ ...a, type: "basic" })).toBe("Basic auth");
    expect(authSummary({ ...a, type: "bearer", token: "t" })).toBe("Bearer token");
    expect(authSummary({ ...a, type: "apikey", apiKey: "X-Key" })).toBe("API key X-Key");
  });

  it("notes masked secrets, locked secrets and unresolved names", () => {
    expect(codeNotes({ masked: [], unresolved: [], secretsLocked: false })).toEqual([]);
    expect(codeNotes({ masked: ["token", "key"], unresolved: ["a"], secretsLocked: true })).toEqual([
      "Secrets are shown as {{token}}, {{key}}.",
      "Secrets are locked, so secret variables are left as written.",
      "No value for {{a}}, so it's left as written.",
    ]);
    expect(codeNotes({ masked: [], unresolved: ["a", "b"], secretsLocked: false })).toEqual([
      "No value for {{a}}, {{b}}, so they're left as written.",
    ]);
  });
});

describe("addedHeadersNote", () => {
  it("is worded for curl and for libraries", () => {
    expect(addedHeadersNote("curl")).toContain("curl's defaults");
    expect(addedHeadersNote("python-requests")).toBe(
      "Pakpos also sends User-Agent and Accept-Encoding; the generated code uses the library's defaults.",
    );
  });
});
