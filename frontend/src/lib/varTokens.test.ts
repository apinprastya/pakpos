import { splitVars, tokenAt, varTokens } from "./varTokens";

const names = (text: string) => varTokens(text).map((t) => t.name);
const spans = (text: string) => varTokens(text).map((t) => text.slice(t.from, t.to));

describe("varTokens", () => {
  // Mirrors Go's TestResolve cases (internal/core/vars), plus editor-only ones.
  it.each([
    ["plain text", "plain text", []],
    ["simple", "{{host}}", ["host"]],
    ["whitespace inside braces", "{{  shadow\t}}", ["shadow"]],
    ["two refs", "a {{ missing }} b {{missing}}", ["missing", "missing"]],
    ["empty braces are literal", "{{}} {{  }}", []],
    ["unterminated", "x {{host", []],
    ["unterminated after a ref", "{{a}} {{b", ["a"]],
    ["only an opening", "{{", []],
    ["only a closing", "}} a }}", []],
    ["extra open braces: the last {{ starts the ref", "{{{{host}}", ["host"]],
    ["triple braces are literal, like in Go", "{{{host}}}", []],
    ["multiline is not a name", "{{a\nb}}", []],
    ["carriage return is not a name", "{{a\rb}}", []],
    ["adjacent", "{{host}}{{path}}", ["host", "path"]],
    ["dynamic", "{{$guid}}-{{ $timestamp }}", ["$guid", "$timestamp"]],
    ["a stray brace inside", "{{a}b}} {{c}}", ["c"]],
    ["an open brace inside", "{{a{b}} {{c}}", ["c"]],
    ["extra closing braces", "{{a}}}", ["a"]],
    ["unicode names", "{{café}} {{名前}} {{😀}}", ["café", "名前", "😀"]],
    ["names with dots and dashes", "{{user.id}}{{x-api-key}}", ["user.id", "x-api-key"]],
    ["escaped-looking input stays a ref", "\\{{a}}", ["a"]],
    ["inside JSON", '{"id": "{{id}}", "n": {{count}}}', ["id", "count"]],
    ["unclosed then a later ref", "{{a {{b}}", ["b"]],
    ["unclosed across lines then a ref", "{{a\n{{b}}", ["b"]],
    ["a broken ref is skipped up to its }}", "{{a\nb}}{{c}}", ["c"]],
  ])("%s", (_, text, want) => {
    expect(names(text)).toEqual(want);
  });

  it("reports exact offsets, plus an offset", () => {
    expect(varTokens("x {{ a }} y")).toEqual([{ from: 2, to: 9, name: "a" }]);
    expect(varTokens("{{a}}", 10)).toEqual([{ from: 10, to: 15, name: "a" }]);
    expect(spans("{{{{host}}")).toEqual(["{{host}}"]);
    expect(spans("😀{{b}}")).toEqual(["{{b}}"]);
  });
});

describe("tokenAt", () => {
  it("finds the ref covering a position, inclusive at both ends", () => {
    const text = "a {{b}} c";
    expect(tokenAt(text, 1)).toBeNull();
    expect(tokenAt(text, 2)?.name).toBe("b");
    expect(tokenAt(text, 5)?.name).toBe("b");
    expect(tokenAt(text, 7)?.name).toBe("b");
    expect(tokenAt(text, 8)).toBeNull();
    expect(tokenAt("{{x}}", 12, 10)?.from).toBe(10);
  });
});

describe("splitVars", () => {
  it("covers the whole text in order", () => {
    const parts = splitVars("a{{b}}c{{d}}");
    expect(parts.map((p) => p.text)).toEqual(["a", "{{b}}", "c", "{{d}}"]);
    expect(parts.map((p) => p.token?.name ?? null)).toEqual([null, "b", null, "d"]);
    expect(splitVars("")).toEqual([]);
    expect(splitVars("{{a}}")).toHaveLength(1);
    expect(splitVars("plain {{")).toEqual([{ text: "plain {{", token: null }]);
  });
});
