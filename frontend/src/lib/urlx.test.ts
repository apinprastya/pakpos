import {
  buildQuery,
  hostOf,
  mergeQuery,
  parseQuery,
  pathParamNames,
  splitURL,
  syncPathParams,
  withQuery,
} from "./urlx";

const kv = (key: string, value: string, enabled = true) => ({ key, value, enabled });

describe("urlx", () => {
  it.each([
    ["https://a.dev/x?y=1#f", { base: "https://a.dev/x", query: "y=1", fragment: "f", hasQuery: true }],
    ["a.dev", { base: "a.dev", query: "", fragment: "", hasQuery: false }],
    ["a.dev?", { base: "a.dev", query: "", fragment: "", hasQuery: true }],
    ["a#b?c", { base: "a", query: "", fragment: "b?c", hasQuery: false }],
  ])("splitURL(%s)", (raw, want) => {
    expect(splitURL(raw)).toEqual(want);
  });

  it("parses query keeping order, duplicates and decoding", () => {
    expect(parseQuery("a=1&&b&a=2&c=hello+world&d=%E2%9C%93&e=%zz")).toEqual([
      kv("a", "1"),
      kv("b", ""),
      kv("a", "2"),
      kv("c", "hello world"),
      kv("d", "✓"),
      kv("e", "%zz"),
    ]);
  });

  it("builds a readable query from enabled rows", () => {
    expect(
      buildQuery([kv("q", "a b&c"), kv("off", "x", false), kv("", ""), kv("flag", ""), kv("v", "{{id}}:/✓")]),
    ).toBe("q=a%20b%26c&flag&v={{id}}:/%E2%9C%93");
  });

  it("replaces the query and keeps the fragment", () => {
    expect(withQuery("http://x/p?old=1#top", [kv("a", "1")])).toBe("http://x/p?a=1#top");
    expect(withQuery("http://x/p?old=1", [kv("a", "1", false)])).toBe("http://x/p");
  });

  it("merges URL rows with previous disabled rows", () => {
    expect(mergeQuery("x?a=1", [kv("a", "0"), kv("b", "2", false)])).toEqual([
      kv("a", "1"),
      kv("b", "2", false),
    ]);
  });

  it("detects path params in the path only", () => {
    expect(pathParamNames("http://localhost:8080/users/:id/posts/:postId/:id?x=:no")).toEqual([
      "id",
      "postId",
    ]);
    expect(pathParamNames("localhost:3000/:a/:9bad/x:y")).toEqual(["a"]);
    expect(pathParamNames("")).toEqual([]);
  });

  it("syncs path params keeping old values", () => {
    expect(syncPathParams("x/:a/:b", [kv("a", "1"), kv("z", "9")])).toEqual([kv("a", "1"), kv("b", "")]);
  });

  it.each([
    ["https://api.dev:8443/x?y", "api.dev:8443"],
    ["user:pw@host.dev/a", "host.dev"],
    ["host.dev", "host.dev"],
    ["{{base}}/x", ""],
    ["", ""],
  ])("hostOf(%s) = %s", (raw, host) => {
    expect(hostOf(raw)).toBe(host);
  });
});
