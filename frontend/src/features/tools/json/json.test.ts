import { lineColumn, parseJson, stringifyJson, transformJson, type JsonOptions } from "./json";

const opts = (patch: Partial<JsonOptions> = {}): JsonOptions => ({
  mode: "format",
  indent: "2",
  sortKeys: false,
  ...patch,
});

function ok(input: string, patch: Partial<JsonOptions> = {}): string {
  const r = transformJson(input, opts(patch));
  if (!r.ok) throw new Error(`unexpected error: ${r.error.message}`);
  return r.output;
}

function err(input: string, patch: Partial<JsonOptions> = {}) {
  const r = transformJson(input, opts(patch));
  if (r.ok) throw new Error(`expected an error, got ${r.output}`);
  return r.error;
}

describe("format and minify", () => {
  it.each<[string, Partial<JsonOptions>, string]>([
    ['{"a":1,"b":[true,null,"x"]}', {}, '{\n  "a": 1,\n  "b": [\n    true,\n    null,\n    "x"\n  ]\n}'],
    ['{"a":{"b":1}}', { indent: "4" }, '{\n    "a": {\n        "b": 1\n    }\n}'],
    ['{"a":[1]}', { indent: "tab" }, '{\n\t"a": [\n\t\t1\n\t]\n}'],
    ['  { "a" : [ 1 , 2 ] , "e" : { } , "f" : [ ] }  ', { mode: "minify" }, '{"a":[1,2],"e":{},"f":[]}'],
    ["{}", {}, "{}"],
    ["[]", {}, "[]"],
    ['"just a string"', {}, '"just a string"'],
    ["-0.5e+10", { mode: "minify" }, "-0.5e+10"],
    ["", {}, ""],
    ["   \n ", { mode: "minify" }, ""],
  ])("%j with %j", (input, patch, want) => {
    expect(ok(input, patch)).toBe(want);
  });

  it("keeps numbers and strings exactly as written", () => {
    const input = '{"big":12345678901234567890,"f":1.50,"e":1E400,"s":"caf\\u00e9 \\/ 東京 🚀"}';
    expect(ok(input, { mode: "minify" })).toBe(input);
    expect(ok(input)).toContain('"big": 12345678901234567890');
    expect(ok(input)).toContain('"s": "caf\\u00e9 \\/ 東京 🚀"');
  });

  it("sorts keys at every level, by their decoded text, keeping duplicates in order", () => {
    const input = '{"b":1,"\\u0061":{"z":1,"y":[{"d":1,"c":2}]},"B":2,"b":3}';
    expect(ok(input, { mode: "minify", sortKeys: true })).toBe(
      '{"B":2,"\\u0061":{"y":[{"c":2,"d":1}],"z":1},"b":1,"b":3}',
    );
    // Without sorting, the order is kept.
    expect(ok(input, { mode: "minify" })).toBe(input);
  });

  it("handles deep nesting and large input without recursion", () => {
    const depth = 20_000;
    const deep = "[".repeat(depth) + "]".repeat(depth);
    expect(ok(deep, { mode: "minify" })).toBe(deep);
    const wide = JSON.stringify(Array.from({ length: 50_000 }, (_, i) => ({ id: i, name: `n${i}` })));
    expect(ok(wide, { mode: "minify" })).toBe(wide);
    expect(ok(wide)).toBe(JSON.stringify(JSON.parse(wide), null, 2));
  });
});

describe("errors", () => {
  it.each<[string, string, number, number]>([
    ['{"a":1,}', "Remove the comma before }: JSON has no trailing commas.", 1, 8],
    ["[1,2,]", "Remove the comma before ]: JSON has no trailing commas.", 1, 6],
    ['{\n  "a": 1\n  "b": 2\n}', 'Expected "," or "}", found """.', 3, 3],
    ["[1 2]", 'Expected "," or "]", found "2".', 1, 4],
    ["{a:1}", 'Expected a key in double quotes, found "a".', 1, 2],
    ['{"a" 1}', 'Expected ":" after the key, found "1".', 1, 6],
    ["{'a':1}", 'Expected a key in double quotes, found "\'".', 1, 2],
    ["['a']", "JSON strings use double quotes.", 1, 2],
    ['{"a":', "Expected a value, found the end of the text.", 1, 6],
    ["[", "Expected a value, found the end of the text.", 1, 2],
    ["{", "Expected a key in double quotes, found the end of the text.", 1, 2],
    ['"abc', "This string has no closing quote.", 1, 1],
    ['"a\\x"', '"\\x" isn\'t a valid escape in a JSON string.', 1, 3],
    ['"\\u12G4"', '"\\u" must be followed by four hex digits.', 1, 2],
    ['"a\nb"', "Strings can't span lines; write the line break as \\n.", 1, 3],
    ['"a\tb"', "Strings can't hold control characters; escape them.", 1, 3],
    ["01", 'Unexpected "1" after the JSON value.', 1, 2],
    ["1.", 'Unexpected "." after the JSON value.', 1, 2],
    ["-", "This number isn't valid JSON.", 1, 1],
    ["tru", 'Expected a value, found "t".', 1, 1],
    ["{} {}", 'Unexpected "{" after the JSON value.', 1, 4],
    ["[1,\n2,\n", "Expected a value, found the end of the text.", 3, 1],
    ['{"a":1\n', 'Expected "," or "}", found the end of the text.', 2, 1],
    ["[1\n x]", 'Expected "," or "]", found "x".', 2, 2],
    ["[1,\n]", "Remove the comma before ]: JSON has no trailing commas.", 2, 1],
    ['["a"\n', 'Expected "," or "]", found the end of the text.', 2, 1],
    ["[1}", 'Expected "," or "]", found "}".', 1, 3],
    ["x", 'Expected a value, found "x".', 1, 1],
  ])("%j", (input, message, line, column) => {
    expect(err(input)).toMatchObject({ message, line, column });
  });

  it("names a line break as the thing found", () => {
    expect(err('{"a":1\n"b":2}').message).toBe('Expected "," or "}", found """.');
    expect(err("[1,\n\n").message).toBe("Expected a value, found the end of the text.");
    expect(err('{"a"\n:1 "b"}').message).toBe('Expected "," or "}", found """.');
  });

  it("reports the offset of the problem", () => {
    expect(err("[1 2]").offset).toBe(3);
  });

  it("parseJson throws on whitespace only", () => {
    expect(() => parseJson("  ")).toThrow("There's no JSON to read.");
  });
});

describe("escape and unescape", () => {
  it.each<[string, string]>([
    ['{"id": 1}', '"{\\"id\\": 1}"'],
    ["line 1\nline 2\ttab", '"line 1\\nline 2\\ttab"'],
    ["Zoë 🚀", '"Zoë 🚀"'],
  ])("escapes %j", (input, want) => {
    expect(ok(input, { mode: "escape" })).toBe(want);
  });

  it.each<[string, string]>([
    ['"{\\"id\\": 1}"', '{"id": 1}'],
    ['  "a\\nb"  ', "a\nb"],
    ['{\\"id\\": 1}', '{"id": 1}'],
    ['"\\u00e9"', "é"],
  ])("unescapes %j", (input, want) => {
    expect(ok(input, { mode: "unescape" })).toBe(want);
  });

  it("round-trips any text", () => {
    const text = '{\n  "a": "quote \\" and \\\\ slash"\n}';
    expect(ok(ok(text, { mode: "escape" }), { mode: "unescape" })).toBe(text);
  });

  it.each<[string, string, number]>([
    ['"a\\qb"', '"\\q" isn\'t a valid escape in a JSON string.', 3],
    ['say "hi"', 'Escape the quote as \\" inside the string.', 5],
    ['"abc', "This string has no closing quote.", 1],
    ["  a\\", "This string has no closing quote.", 3],
    ['"a" and "b"', 'Text follows the closing quote. Escape quotes inside the string as \\".', 5],
  ])("explains a bad string %j", (input, message, column) => {
    expect(err(input, { mode: "unescape" })).toMatchObject({ message, line: 1, column });
  });
});

describe("helpers", () => {
  it.each<[string, number, number, number]>([
    ["abc", 0, 1, 1],
    ["abc", 2, 1, 3],
    ["a\nbc", 3, 2, 2],
    ["a\n", 2, 2, 1],
  ])("lineColumn(%j, %d)", (text, offset, line, column) => {
    expect(lineColumn(text, offset)).toEqual({ line, column });
  });

  it("stringifyJson writes a parsed tree back", () => {
    expect(stringifyJson(parseJson('[{"a":[]}]'), null)).toBe('[{"a":[]}]');
  });
});
