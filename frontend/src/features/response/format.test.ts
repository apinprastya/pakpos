import { makeResponse } from "@/test/fixtures";
import {
  PRETTY_LIMIT,
  bodyText,
  editorLanguage,
  errorCopy,
  formatBytes,
  formatDuration,
  prettyBody,
  statusTextClass,
} from "./format";

describe("response format", () => {
  it.each([
    [0, "0 B"],
    [1023, "1023 B"],
    [1536, "1.5 KB"],
    [20 * 1024, "20 KB"],
    [5 * 1024 * 1024, "5.0 MB"],
    [3 * 1024 ** 3, "3.0 GB"],
    [5000 * 1024 ** 3, "5000 GB"],
  ])("formatBytes(%d) = %s", (n, s) => expect(formatBytes(n)).toBe(s));

  it("formats durations", () => {
    expect(formatDuration(12.4)).toBe("12 ms");
    expect(formatDuration(1234)).toBe("1.23 s");
  });

  it.each([
    [100, "text-muted-foreground"],
    [204, "text-status-ok"],
    [301, "text-status-redirect"],
    [404, "text-status-client"],
    [503, "text-status-server"],
  ])("statusTextClass(%d)", (code, cls) => expect(statusTextClass(code)).toBe(cls));

  it("decodes base64 bodies", () => {
    expect(bodyText({ body: btoa("héllo".replace("é", "e")), encoding: "base64" })).toBe("hello");
    expect(bodyText({ body: "plain", encoding: "utf8" })).toBe("plain");
    expect(bodyText({ body: "%%%", encoding: "base64" })).toBe("%%%");
  });

  it("pretty prints JSON and XML, falls back for invalid or large", () => {
    expect(prettyBody(makeResponse({ kind: "json", body: '{"a":1}' }))).toEqual({
      text: '{\n  "a": 1\n}',
      note: null,
    });
    expect(prettyBody(makeResponse({ kind: "xml", body: "<a><b>1</b></a>" })).text).toBe(
      "<a>\n  <b>1</b>\n</a>",
    );
    expect(prettyBody(makeResponse({ kind: "json", body: "{bad" })).note).toMatch(/isn't valid JSON/);
    expect(prettyBody(makeResponse({ kind: "html", body: "<p>" }))).toEqual({ text: "<p>", note: null });
    const big = "x".repeat(PRETTY_LIMIT + 1);
    expect(prettyBody(makeResponse({ kind: "json", body: big })).note).toMatch(/too large/);
  });

  it("maps kinds to editor languages", () => {
    expect(editorLanguage("json")).toBe("json");
    expect(editorLanguage("image")).toBe("text");
  });

  it("has copy for every error kind and a fallback", () => {
    expect(errorCopy("dns").title).toBe("Couldn't find the server");
    expect(errorCopy("weird")).toEqual(errorCopy("network"));
  });
});
