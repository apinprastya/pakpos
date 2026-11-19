import { decodeUrl, encodeUrl, errorText, parseUrl, position, transformUrl, type UrlMode } from "./url";

describe("encodeUrl", () => {
  it.each<[UrlMode, string, string]>([
    ["component", "a b&c=d/e?f", "a%20b%26c%3Dd%2Fe%3Ff"],
    ["component", "-_.!~*'()", "-_.!~*'()"],
    ["component", "café 🚀", "caf%C3%A9%20%F0%9F%9A%80"],
    ["component", "100%", "100%25"],
    ["component", "{{token}}", "%7B%7Btoken%7D%7D"],
    ["form", "a b+c&d", "a+b%2Bc%26d"],
    ["form", "*-._!~'()", "*-._%21%7E%27%28%29"],
    ["form", "é", "%C3%A9"],
    ["full", "https://x.dev/a b/ü?q=1 2&r=#frag", "https://x.dev/a%20b/%C3%BC?q=1%202&r=#frag"],
    ["full", "https://x.dev/already%20done?x=%2F", "https://x.dev/already%20done?x=%2F"],
    ["full", "https://x.dev/100%", "https://x.dev/100%25"],
    ["full", "https://x.dev/%zz", "https://x.dev/%25zz"],
    ["full", "{{baseUrl}}/users/{{id}}?q={{ term }}", "{{baseUrl}}/users/{{id}}?q={{ term }}"],
    ["full", 'https://x.dev/{a}|"<>`^\\', "https://x.dev/%7Ba%7D%7C%22%3C%3E%60%5E%5C"],
    ["full", "[::1]:8080/@!$'()*+,;=", "[::1]:8080/@!$'()*+,;="],
    ["component", "", ""],
  ])("%s: %j", (mode, input, want) => {
    expect(encodeUrl(input, mode)).toBe(want);
  });

  it("matches encodeURIComponent for component mode", () => {
    const text = 'Zoë & "東京" <tag> {x} 🚀 ~!*\'()';
    expect(encodeUrl(text, "component")).toBe(encodeURIComponent(text));
  });

  it("turns a lone surrogate into U+FFFD instead of throwing", () => {
    expect(encodeUrl("a\ud800b", "component")).toBe("a%EF%BF%BDb");
  });
});

describe("decodeUrl", () => {
  it.each<[UrlMode, string, string]>([
    ["component", "a%20b%26c", "a b&c"],
    ["component", "a+b", "a+b"],
    ["component", "caf%C3%A9%20%F0%9F%9A%80", "café 🚀"],
    ["component", "%e2%82%ac", "€"],
    ["form", "a+b%2Bc", "a b+c"],
    ["full", "https://x.dev/a%20b?x=%2F%3F%26%3D&y=%C3%BC#%23", "https://x.dev/a b?x=%2F%3F%26%3D&y=ü#%23"],
    ["full", "%E2%82%AC%2F", "€%2F"],
    ["component", "no escapes", "no escapes"],
  ])("%s: %j", (mode, input, want) => {
    expect(decodeUrl(input, mode)).toEqual({ ok: true, output: want });
  });

  it.each<[string, "escape" | "utf8", number]>([
    ["abcd%zz", "escape", 4],
    ["%2", "escape", 0],
    ["a%", "escape", 1],
    ["ok%20%2", "escape", 5],
    ["x%C3", "utf8", 1],
    ["%FF%FE", "utf8", 0],
  ])("reports %j", (input, problem, offset) => {
    expect(decodeUrl(input, "component")).toEqual({ ok: false, problem, offset });
  });

  it("round-trips unicode in every mode", () => {
    const text = "Zoë & 東京 = 🚀 + 100% / ?";
    for (const mode of ["component", "form"] as const) {
      expect(decodeUrl(encodeUrl(text, mode), mode)).toEqual({ ok: true, output: text });
    }
  });

  it("handles very large input", () => {
    const text = "a b/é".repeat(200_000);
    const encoded = encodeUrl(text, "component");
    expect(encoded).toBe("a%20b%2F%C3%A9".repeat(200_000));
    expect(decodeUrl(encoded, "component")).toEqual({ ok: true, output: text });
  });
});

describe("transformUrl and errorText", () => {
  it("gives empty output for empty input and dispatches by direction", () => {
    expect(transformUrl("", "full", "decode")).toEqual({ ok: true, output: "" });
    expect(transformUrl("a b", "form", "encode")).toEqual({ ok: true, output: "a+b" });
    expect(transformUrl("a+b", "form", "decode")).toEqual({ ok: true, output: "a b" });
  });

  it.each<[string, number, "escape" | "utf8", string]>([
    [
      "abcd%zz",
      4,
      "escape",
      "The %-escape at column 5 isn't valid: % must be followed by two hex digits (write a literal % as %25).",
    ],
    ["a\nb%C3", 3, "utf8", "The %-escapes at line 2, column 2 aren't valid UTF-8 text."],
  ])("describes %j", (text, offset, problem, want) => {
    expect(errorText(text, offset, problem)).toBe(want);
  });

  it("finds line and column", () => {
    expect(position("abc", 0)).toEqual({ line: 1, column: 1 });
    expect(position("a\nbc", 3)).toEqual({ line: 2, column: 2 });
  });
});

describe("parseUrl", () => {
  it("reads the parts like the request editor", () => {
    expect(parseUrl("  https://user@API.dev:8443/v1/users?q=a%20b&tag=x+y&flag#top  ")).toEqual({
      source: "https://user@API.dev:8443/v1/users?q=a%20b&tag=x+y&flag#top",
      scheme: "https",
      host: "API.dev",
      port: "8443",
      path: "/v1/users",
      query: [
        { key: "q", value: "a b", enabled: true },
        { key: "tag", value: "x y", enabled: true },
        { key: "flag", value: "", enabled: true },
      ],
      fragment: "top",
    });
  });

  it.each<[string, Partial<ReturnType<typeof parseUrl>>]>([
    ["HTTP://x.dev", { scheme: "http", host: "x.dev", port: "", path: "" }],
    ["http://[::1]:9000/a", { host: "[::1]", port: "9000", path: "/a" }],
    ["http://[::1]/a", { host: "[::1]", port: "" }],
    ["ftp://files.dev/a/b?", { scheme: "ftp", path: "/a/b", query: [] }],
  ])("%j", (input, want) => {
    expect(parseUrl(input)).toMatchObject(want!);
  });

  it.each(["", "x.dev/a", "{{baseUrl}}/a", "https://a.dev\nhttps://b.dev", "mailto:a@b.dev"])(
    "isn't a URL: %j",
    (input) => {
      expect(parseUrl(input)).toBeNull();
    },
  );
});
