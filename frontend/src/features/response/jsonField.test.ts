import { formatPath, jsonFieldAt } from "./jsonField";

const doc = `{
  "id": 42,
  "name": "Ada \\"L\\"",
  "tags": ["a", "b"],
  "user": {
    "email": "ada@x.io",
    "odd key": null
  },
  "ok": true
}`;

const at = (needle: string, delta = 1) => jsonFieldAt(doc, doc.indexOf(needle) + delta);

describe("jsonFieldAt", () => {
  it.each([
    ["42", "42", "id", "id"],
    ['"Ada', 'Ada "L"', "name", "name"],
    ['"b"', "b", undefined, "tags[1]"],
    ['"ada@', "ada@x.io", "email", "user.email"],
    ["null", "null", "odd key", 'user["odd key"]'],
    ["true", "true", "ok", "ok"],
  ])("finds the value at %s", (needle, value, key, path) => {
    const f = at(needle)!;
    expect(f.value).toBe(value);
    expect(f.key).toBe(key);
    expect(formatPath(f.path)).toBe(path);
  });

  it("finds a property from its key", () => {
    expect(at('"email"')).toMatchObject({ value: "ada@x.io", key: "email" });
  });

  it("copies a nested object without its indentation", () => {
    const f = at('"user"', 9)!; // on the opening brace
    expect(f.path).toEqual(["user"]);
    expect(f.value).toBe('{\n  "email": "ada@x.io",\n  "odd key": null\n}');
  });

  it("returns the containing value between fields", () => {
    expect(at('["a"', 0)!.path).toEqual(["tags"]);
    expect(jsonFieldAt(doc, doc.indexOf("\n  }") + 1)!.path).toEqual(["user"]);
  });

  it("returns the root, and handles empty containers and flat documents", () => {
    expect(jsonFieldAt(doc, 0)!.path).toEqual([]);
    expect(jsonFieldAt('{"a":{},"b":[]}', 6)).toMatchObject({ path: ["a"], value: "{}" });
    expect(jsonFieldAt('{"a":{},"b":[]}', 13)).toMatchObject({ path: ["b"], value: "[]" });
    expect(jsonFieldAt('[1,{"x":-2.5e3}]', 9)).toMatchObject({ path: [1, "x"], value: "-2.5e3", key: "x" });
  });

  it("uses the complete fields of truncated or invalid JSON", () => {
    expect(jsonFieldAt('{"a": "one", "b": "tw', 8)).toMatchObject({ value: "one" });
    expect(jsonFieldAt('{"a": "one", "b": "tw', 19)).toBeNull();
    expect(jsonFieldAt('{"a" 1}', 2)).toBeNull();
    expect(jsonFieldAt('{"a": 1 2}', 6)).toMatchObject({ value: "1" });
    expect(jsonFieldAt("[1 2]", 1)).toMatchObject({ value: "1" });
    expect(jsonFieldAt("nope", 1)).toBeNull();
    expect(jsonFieldAt("", 0)).toBeNull();
  });
});

describe("formatPath", () => {
  it("formats identifiers, indexes and quoted keys", () => {
    expect(formatPath([])).toBe("");
    expect(formatPath([0, "a"])).toBe("[0].a");
    expect(formatPath(["$x", "a-b", 2])).toBe('$x["a-b"][2]');
  });
});
