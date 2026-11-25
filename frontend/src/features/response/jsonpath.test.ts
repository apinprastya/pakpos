import { stringifyJson, parseJson } from "@/features/tools/json/json";
import { evaluateJsonPath, filterJson, parseBody, parseJsonPath, JsonPathError } from "./jsonpath";

const STORE = `{ "store": {
  "book": [
    { "category": "reference", "author": "Nigel Rees", "title": "Sayings of the Century", "price": 8.95 },
    { "category": "fiction", "author": "Evelyn Waugh", "title": "Sword of Honour", "price": 12.99 },
    { "category": "fiction", "author": "Herman Melville", "title": "Moby Dick", "isbn": "0-553-21311-3", "price": 8.99 },
    { "category": "fiction", "author": "J. R. R. Tolkien", "title": "The Lord of the Rings", "isbn": "0-395-19395-8", "price": 22.99 }
  ],
  "bicycle": { "color": "red", "price": 399 }
} }`;

/** The matches of expr in doc, as minified JSON. */
function run(expr: string, doc = STORE): string[] {
  return evaluateJsonPath(parseJsonPath(expr), parseJson(doc)).map((n) => stringifyJson(n, null));
}

describe("JSONPath (RFC 9535 examples)", () => {
  it.each([
    ["$.store.book[*].author", ['"Nigel Rees"', '"Evelyn Waugh"', '"Herman Melville"', '"J. R. R. Tolkien"']],
    ["$..author", ['"Nigel Rees"', '"Evelyn Waugh"', '"Herman Melville"', '"J. R. R. Tolkien"']],
    ["$.store..price", ["8.95", "12.99", "8.99", "22.99", "399"]],
    ["$..book[2].author", ['"Herman Melville"']],
    ["$..book[2].publisher", []],
    ["$..book[-1].title", ['"The Lord of the Rings"']],
    ["$..book[0,1].price", ["8.95", "12.99"]],
    ["$..book[:2].price", ["8.95", "12.99"]],
    ["$..book[?@.isbn].title", ['"Moby Dick"', '"The Lord of the Rings"']],
    ["$..book[?@.price<10].title", ['"Sayings of the Century"', '"Moby Dick"']],
    ["$..book[?(@.price < 10)].title", ['"Sayings of the Century"', '"Moby Dick"']],
    ["$.store['bicycle'][\"color\"]", ['"red"']],
    ["$.store.*.color", ['"red"']],
  ])("%s", (expr, want) => {
    expect(run(expr)).toEqual(want);
  });

  it("counts every node under $..*", () => {
    expect(run("$..*")).toHaveLength(27);
  });

  it("slices with steps, negatives and bounds", () => {
    const a = `["a","b","c","d","e","f","g"]`;
    expect(run("$[1:3]", a)).toEqual(['"b"', '"c"']);
    expect(run("$[5:]", a)).toEqual(['"f"', '"g"']);
    expect(run("$[1:5:2]", a)).toEqual(['"b"', '"d"']);
    expect(run("$[5:1:-2]", a)).toEqual(['"f"', '"d"']);
    expect(run("$[::-1]", a)).toEqual(['"g"', '"f"', '"e"', '"d"', '"c"', '"b"', '"a"']);
    expect(run("$[-2:]", a)).toEqual(['"f"', '"g"']);
    expect(run("$[0:10:0]", a)).toEqual([]);
    expect(run("$[-10]", a)).toEqual([]);
    expect(run("$[0]", `{"0": 1}`)).toEqual([]);
    expect(run("$[1:2]", `{"a": 1}`)).toEqual([]);
  });

  it("compares like the RFC", () => {
    const doc = `{"a": [3, 5, 1, 2, 4, 6, {"b": "j"}, {"b": "k"}, {"b": {}}, {"b": "kilo"}, {"c": [1, 2]}]}`;
    expect(run("$.a[?@.b == 'kilo']", doc)).toEqual(['{"b":"kilo"}']);
    expect(run("$.a[?@>3.5]", doc)).toEqual(["5", "4", "6"]);
    expect(run("$.a[?@.b]", doc)).toEqual(['{"b":"j"}', '{"b":"k"}', '{"b":{}}', '{"b":"kilo"}']);
    expect(run('$.a[?@<2 || @.b == "k"]', doc)).toEqual(["1", '{"b":"k"}']);
    expect(run("$.a[?@.b >= 'k' && @.b <= 'kilo']", doc)).toEqual(['{"b":"k"}', '{"b":"kilo"}']);
    expect(run("$.a[?!@.b && @ != 3]", doc)).toHaveLength(6);
    expect(run("$.a[?!(@ < 5)]", doc)).toHaveLength(7);
    expect(run("$.a[?@.c == $.a[10].c]", doc)).toEqual(['{"c":[1,2]}']);
    expect(run("$.a[?@.missing == @.other]", doc)).toHaveLength(11);
    expect(run("$.a[?@ == 1.0]", doc)).toEqual(["1"]);
    expect(run("$.a[?@ != null]", doc)).toHaveLength(11);
    expect(run("$[?@ == true]", "[true, false, null]")).toEqual(["true"]);
    expect(run("$[?@ < true]", "[true, false]")).toEqual([]);
    expect(run("$[?@ >= $[0]]", '[{"a":1}, {"a":1}]')).toEqual(['{"a":1}', '{"a":1}']);
    expect(run("$[?@ == $[1]]", '[{"a":1}, {"a":2}, {"b":1}, [1], {"a":1,"b":2}]')).toEqual(['{"a":2}']);
    expect(run("$[?@ == [1]]".replace("[1]", "$[3]"), "[[1,2],[1],[2],[1]]")).toEqual(["[1]", "[1]"]);
  });

  it("keeps numbers exactly as written", () => {
    expect(run("$.id", `{"id": 12345678901234567890}`)).toEqual(["12345678901234567890"]);
  });

  it("calls the functions", () => {
    const doc = `[{"n":"abc","t":[1,2,3]},{"n":"b","t":[]},{"n":"bcd","t":{"x":1}},{"n":5}]`;
    expect(run("$[?length(@.n) == 3].n", doc)).toEqual(['"abc"', '"bcd"']);
    expect(run("$[?length(@.t) >= 1].n", doc)).toEqual(['"abc"', '"bcd"']);
    expect(run("$[?length(@.n) == 1].n", doc)).toEqual(['"b"']);
    expect(run("$[?count(@.t[*]) == 3].n", doc)).toEqual(['"abc"']);
    expect(run("$[?match(@.n, 'b.*')].n", doc)).toEqual(['"b"', '"bcd"']);
    expect(run("$[?search(@.n, 'c')].n", doc)).toEqual(['"abc"', '"bcd"']);
    expect(run("$[?match(@.n, '[')].n", doc)).toEqual([]);
    expect(run("$[?match(@.n, 5)]", doc)).toEqual([]);
    expect(run("$[?value(@..x) == 1].n", doc)).toEqual(['"bcd"']);
    expect(run("$[?length(@.missing) == 1]", doc)).toEqual([]);
    expect(run("$[?length(@.n)]", `[{"n": true}]`)).toEqual([]);
    expect(run("$[?count(@.t[*])].n", doc)).toEqual(['"abc"', '"b"', '"bcd"', "5"]);
    expect(run("$[?value(@.t)].n", doc)).toEqual(['"abc"', '"b"', '"bcd"']);
    expect(run("$[?count(@.t[*]) == value(@.t[0])]", `[{"t":[1]}]`)).toHaveLength(1);
    expect(run("$[?match(@.n, 'b') == true]", doc)).toEqual([]);
  });

  it("reads strings with escapes and non-ASCII names", () => {
    expect(run(`$['a\\'b', "c\\"d", 'e\\u0041\\n']`, `{"a'b": 1, "c\\"d": 2, "eA\\n": 3}`)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(run("$.café", `{"café": 1}`)).toEqual(["1"]);
    expect(run("$..[0]", `[[1], {"a": [2]}]`)).toEqual(["[1]", "1", "2"]);
  });
});

describe("JSONPath errors", () => {
  it.each([
    ["", "starts with $"],
    ["store", "starts with $"],
    ["@.a", "starts with $"],
    ["$.", "Expected a member name"],
    ["$[", "Expected a name, an index"],
    ["$[1", 'Expected "," or "]"'],
    ["$['a", "no closing quote"],
    ["$['\\q']", "Unknown escape"],
    ["$ x", "Unexpected"],
    ["$[?1]", "needs a test or a comparison"],
    ["$[?@.a == ]", "Expected a value"],
    ["$[?@.* == 1]", "picks one value"],
    ["$[?foo(@)]", "Unknown function foo()"],
    ["$[?length(@, 1)]", "takes 1 argument"],
    ["$[?match(@)]", "takes 2 arguments"],
    ["$[?length(@.a]", '"," or ")"'],
    ["$[?!1]", "! needs a query"],
    ["$[?(@.a]", 'Expected ")"'],
  ])("%s", (expr, message) => {
    let err: unknown;
    try {
      parseJsonPath(expr);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JsonPathError);
    expect((err as Error).message).toContain(message);
  });
});

describe("filterJson", () => {
  it("returns matches, or a sentence", () => {
    const body = parseBody(`{"a": [1, 2]}`);
    expect(filterJson(body, "$.a[*]")).toMatchObject({ ok: true, matches: [{ text: "1" }, { text: "2" }] });
    expect(filterJson(body, "$.a[")).toMatchObject({ ok: false, offset: 4 });
    expect(filterJson(parseBody("{"), "$")).toEqual({
      ok: false,
      error: "The body isn't valid JSON, so it can't be filtered.",
      badBody: true,
    });
    expect(filterJson(body, "$[?@ == 1]")).toMatchObject({ ok: true, matches: [] });
    expect(filterJson(body, "$.a[?@ == 1]")).toMatchObject({ ok: true, matches: [{ text: "1" }] });
  });
});
