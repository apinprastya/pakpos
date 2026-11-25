import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { GLOBALS, membersAt, pathBefore, pmCompletions, TYPES } from "./pmApi";
import { snippetInsert, SNIPPETS } from "./snippets";

/** Completions at the end of `text` (or at `|`). */
function complete(text: string, event: "prerequest" | "test" = "test", explicit = false) {
  const pos = text.includes("|") ? text.indexOf("|") : text.length;
  const doc = text.replace("|", "");
  const state = EditorState.create({ doc });
  const result = pmCompletions(event)(new CompletionContext(state, pos, explicit));
  if (!result || result instanceof Promise) return null;
  return { from: result.from, labels: result.options.map((o) => o.label), options: result.options };
}

describe("pathBefore", () => {
  it.each([
    ["pm.", ["pm"]],
    ["pm.environment.", ["pm", "environment"]],
    ["x = pm.expect(a.b(1)).to.", ["pm", "expect()", "to"]],
    ["pm.response.json().", ["pm", "response", "json()"]],
  ])("reads %s", (text, want) => {
    const path = pathBefore(text, text.length - 1);
    expect(path?.map((s) => s.name + (s.call ? "()" : ""))).toEqual(want);
  });

  it("gives up on an unbalanced call or a non-name", () => {
    expect(pathBefore("a).", 2)).toBeNull();
    expect(pathBefore("'x'.", 3)).toBeNull();
  });
});

describe("membersAt", () => {
  it("walks properties and calls", () => {
    expect(membersAt([{ name: "pm", call: false }], "test")!.map((e) => e.name)).toContain("response");
    expect(membersAt([{ name: "pm", call: false }], "prerequest")!.map((e) => e.name)).not.toContain(
      "response",
    );
    expect(
      membersAt(
        [
          { name: "pm", call: false },
          { name: "expect", call: true },
        ],
        "test",
      ),
    ).toEqual(TYPES.assertion);
  });

  it("is null for unknown names, members without members, and call mismatches", () => {
    expect(membersAt([{ name: "nope", call: false }], "test")).toBeNull();
    expect(
      membersAt(
        [
          { name: "pm", call: false },
          { name: "info", call: false },
          { name: "eventName", call: false },
        ],
        "test",
      ),
    ).toBeNull();
    // pm.expect without a call has no members; pm.environment() isn't a function.
    expect(
      membersAt(
        [
          { name: "pm", call: false },
          { name: "expect", call: false },
        ],
        "test",
      ),
    ).toBeNull();
    expect(
      membersAt(
        [
          { name: "pm", call: false },
          { name: "environment", call: true },
        ],
        "test",
      ),
    ).toBeNull();
  });
});

describe("pmCompletions", () => {
  it("offers pm members after pm.", () => {
    const r = complete("pm.");
    expect(r?.from).toBe(3);
    expect(r?.labels).toEqual(expect.arrayContaining(["environment", "test", "expect", "response"]));
    const env = r!.options.find((o) => o.label === "environment")!;
    expect(env.info).toMatch(/selected environment/);
    expect(r!.options.find((o) => o.label === "test")).toMatchObject({
      type: "method",
      detail: "(name, fn)",
    });
  });

  it("filters by the script it's in", () => {
    expect(complete("pm.", "prerequest")?.labels).not.toContain("response");
    expect(complete("pm.response.", "prerequest")).toBeNull();
    expect(complete("pm.request.headers.", "test")?.labels).not.toContain("upsert");
    expect(complete("pm.request.headers.", "prerequest")?.labels).toContain("upsert");
    expect(complete("pm.execution.", "prerequest")?.labels).toContain("skipRequest");
    expect(complete("pm.execution.", "test")?.labels).not.toContain("skipRequest");
  });

  it("completes scopes, the partial word, and assertion chains", () => {
    expect(complete("pm.environment.")?.labels).toEqual(
      expect.arrayContaining(["get", "set", "unset", "has", "toObject", "replaceIn", "name"]),
    );
    const partial = complete("pm.globals.se");
    expect(partial?.from).toBe("pm.globals.".length);
    expect(partial?.labels).toContain("set");
    expect(complete("pm.response.to.have.")?.labels).toEqual(
      expect.arrayContaining(["status", "header", "jsonBody", "body"]),
    );
    expect(complete("pm.expect(pm.response.code).to.be.")?.labels).toEqual(
      expect.arrayContaining(["equal", "above", "ok", "not"]),
    );
    expect(complete("console.")?.labels).toEqual(["log", "info", "warn", "error", "debug"]);
  });

  it("offers globals for a bare name, not inside strings or for nothing typed", () => {
    expect(complete("p")?.labels).toEqual(GLOBALS.map((g) => g.name));
    expect(complete("const a = ")).toBeNull();
    expect(complete("const a = ", "test", true)?.labels).toContain("pm");
    expect(complete('"p')).toBeNull();
    expect(complete("foo.")).toBeNull();
    expect(complete("pm.info.eventName.")).toBeNull();
  });
});

describe("jsonSchema", () => {
  it("completes on responses and expectations", () => {
    expect(complete("pm.response.to.have.")!.labels).toContain("jsonSchema");
    expect(complete("pm.expect(body).to.have.")!.labels).toContain("jsonSchema");
  });
});

describe("pm.sendRequest and pm.cookies", () => {
  it("completes them in both scripts", () => {
    for (const event of ["prerequest", "test"] as const) {
      expect(complete("pm.", event)!.labels).toEqual(expect.arrayContaining(["sendRequest", "cookies"]));
    }
    expect(complete("pm.cookies.")!.labels).toEqual([
      "get",
      "has",
      "all",
      "count",
      "each",
      "toObject",
      "jar",
    ]);
    expect(complete("pm.cookies.jar().")!.labels).toEqual(["get", "getAll", "set", "unset", "clear"]);
    // sendRequest returns a promise, not a response: no members.
    expect(complete("pm.sendRequest(url).")).toBeNull();
  });
});

describe("snippets", () => {
  it("inserts on a line of its own", () => {
    expect(snippetInsert("", 0, "x\n")).toBe("x\n");
    expect(snippetInsert("a\n", 2, "x\n")).toBe("x\n");
    expect(snippetInsert("abc", 3, "x\n")).toBe("\nx\n");
  });

  it("covers the common cases", () => {
    const labels = SNIPPETS.map((s) => s.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "Status code is 200",
        "Response time is below 500 ms",
        "JSON body has a property",
        "Set an environment variable from the JSON response",
        "Set a request header",
        "Log the response",
        "Get a token with pm.sendRequest",
        "Response set a cookie",
        "Response matches a JSON schema",
      ]),
    );
  });
});
