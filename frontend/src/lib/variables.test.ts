import { makePreviewVar, makeVar } from "@/test/fixtures";
import {
  DYNAMIC_VARIABLES,
  EMPTY_SCOPE,
  MASK,
  MAX_DEPTH,
  nestedProblem,
  problemText,
  describeVar,
  makeScope,
  overlayDraft,
  scopeLabel,
  scopeSignature,
  varKind,
} from "./variables";

const env = { id: "e1", name: "Dev" };
const scope = makeScope(
  [
    makePreviewVar("host", "dev.example"),
    makePreviewVar("empty", ""),
    makePreviewVar("token", "", { secret: true, scope: "collection", scopeId: "c1", scopeName: "Users API" }),
    makePreviewVar("apiKey", "", { secret: true, set: false }),
    makePreviewVar("g", "1", { scope: "global", scopeId: "g", scopeName: "Globals" }),
  ],
  env,
  true,
);

describe("varKind", () => {
  it("classifies names", () => {
    expect(varKind("host", scope)).toBe("resolved");
    expect(varKind("token", scope)).toBe("resolved");
    expect(varKind("apiKey", scope)).toBe("unresolved");
    expect(varKind("nope", scope)).toBe("unresolved");
    expect(varKind("$guid", scope)).toBe("dynamic");
    // An unknown $name is looked up like any other name.
    expect(varKind("$nope", scope)).toBe("unresolved");
    expect(varKind("nope", makeScope([], null, true, false))).toBe("pending");
    expect(varKind("$timestamp", makeScope([], null, true, false))).toBe("dynamic");
  });
});

describe("scopeLabel", () => {
  it("names each scope", () => {
    expect(scopeLabel("global", "Globals")).toBe("Globals");
    expect(scopeLabel("environment", "Development")).toBe("Environment: Development");
    expect(scopeLabel("collection", "Users API")).toBe("Collection: Users API");
    expect(scopeLabel("local", "")).toBe("Local");
  });
});

describe("describeVar", () => {
  it("shows plain values with their scope", () => {
    expect(describeVar("host", scope)).toEqual({
      kind: "resolved",
      name: "host",
      value: "dev.example",
      note: "",
      source: "Environment: Dev",
      hint: "",
    });
    expect(describeVar("empty", scope)).toMatchObject({ value: "", note: "Empty value" });
    expect(describeVar("g", scope).source).toBe("Globals");
  });

  it("masks secrets and says when one isn't set", () => {
    expect(describeVar("token", scope)).toMatchObject({
      value: MASK,
      source: "Collection: Users API · secret",
    });
    expect(describeVar("apiKey", scope)).toMatchObject({
      kind: "unresolved",
      value: null,
      note: "Not set on this machine",
    });
  });

  it("explains undefined names and what to do", () => {
    expect(describeVar("nope", scope)).toMatchObject({
      kind: "unresolved",
      note: "Not defined in any active scope",
      hint: expect.stringContaining("Add it to Dev"),
    });
    expect(describeVar("nope", makeScope([], null, true)).hint).toMatch(/^Select an environment/);
    expect(describeVar("nope", EMPTY_SCOPE).hint).toMatch(/Open a workspace/);
    expect(describeVar("nope", makeScope([], null, true, false))).toMatchObject({
      kind: "pending",
      note: "Loading variables…",
    });
  });

  it("describes every dynamic variable", () => {
    for (const d of DYNAMIC_VARIABLES) {
      expect(describeVar(d.name, scope)).toMatchObject({ kind: "dynamic", hint: d.description });
    }
    expect(describeVar("$guid", scope).hint).toBe("A random UUID v4, new for each use.");
  });
});

describe("overlayDraft", () => {
  const target = { kind: "environment" as const, id: "e1", name: "Dev" };

  it("replaces the edited scope's saved rows with the draft", () => {
    const visible = [
      makePreviewVar("host", "old"),
      makePreviewVar("gone", "x"),
      makePreviewVar("g", "1", { scope: "global", scopeId: "g" }),
      makePreviewVar("pw", "", { secret: true, set: true }),
    ];
    const out = overlayDraft(visible, target, [
      makeVar("host", "new"),
      makeVar("added", "{{host}}"),
      makeVar("off", "x", { enabled: false }),
      makeVar("  ", "blank key"),
      makeVar("g", "env wins over globals"),
      makeVar("pw", "", { secret: true }),
      makeVar("newSecret", "", { secret: true }),
    ]);
    const byKey = Object.fromEntries(out.map((v) => [v.key, v]));
    expect(out.map((v) => v.key)).toEqual(["added", "g", "host", "newSecret", "pw"]);
    expect(byKey.host).toMatchObject({ value: "new", scope: "environment", scopeName: "Dev" });
    expect(byKey.g).toMatchObject({ value: "env wins over globals", scope: "environment" });
    expect(byKey.pw).toMatchObject({ secret: true, set: true, value: "" });
    expect(byKey.newSecret).toMatchObject({ secret: true, set: false });
  });

  it("keeps a higher scope's definition", () => {
    const out = overlayDraft([makePreviewVar("host", "env")], { kind: "global", id: "", name: "Globals" }, [
      makeVar("host", "global"),
      makeVar("x", "1"),
    ]);
    expect(out.find((v) => v.key === "host")).toMatchObject({ value: "env", scope: "environment" });
    expect(out.find((v) => v.key === "x")).toMatchObject({ scope: "global", scopeName: "Globals" });
  });

  it("matches the globals scope whatever its id", () => {
    const out = overlayDraft(
      [makePreviewVar("old", "1", { scope: "global", scopeId: "g-id" })],
      { kind: "global", id: "", name: "Globals" },
      [],
    );
    expect(out).toEqual([]);
  });
});

describe("scopeSignature", () => {
  it("changes with the content only", () => {
    const a = scopeSignature([makePreviewVar("a", "1")], env, true, true);
    expect(scopeSignature([makePreviewVar("a", "1")], { ...env }, true, true)).toBe(a);
    expect(scopeSignature([makePreviewVar("a", "2")], env, true, true)).not.toBe(a);
    expect(scopeSignature([makePreviewVar("a", "1")], null, true, true)).not.toBe(a);
    expect(scopeSignature([makePreviewVar("a", "1")], env, true, false)).not.toBe(a);
  });
});

describe("nested references", () => {
  const vars = (...v: ReturnType<typeof makePreviewVar>[]) => makeScope(v, env, true);

  it("flags a defined variable whose value uses an undefined one, transitively", () => {
    const s = vars(
      makePreviewVar("url", "{{base}}/users"),
      makePreviewVar("base", "https://{{host}}/{{$guid}}"),
      makePreviewVar("ok", "{{plain}}-{{$timestamp}}"),
      makePreviewVar("plain", "x"),
    );
    expect(nestedProblem("url", s)).toEqual({ kind: "missing", name: "host", unset: false });
    expect(nestedProblem("base", s)).toEqual({ kind: "missing", name: "host", unset: false });
    expect(nestedProblem("ok", s)).toBeNull();
    expect(nestedProblem("nope", s)).toBeNull();
    expect(varKind("url", s)).toBe("warn");
    expect(varKind("ok", s)).toBe("resolved");
    expect(describeVar("url", s)).toMatchObject({
      kind: "warn",
      value: "{{base}}/users",
      note: "Uses {{host}}, which is not defined in any active scope",
    });
  });

  it("names an unset secret, and treats secrets as opaque", () => {
    const s = vars(
      makePreviewVar("auth", "Bearer {{token}}"),
      makePreviewVar("token", "", { secret: true, set: false }),
      makePreviewVar("key", "", { secret: true }),
      makePreviewVar("useKey", "{{key}}"),
    );
    expect(describeVar("auth", s).note).toBe("Uses {{token}}, a secret that is not set on this machine");
    expect(nestedProblem("useKey", s)).toBeNull();
    expect(nestedProblem("key", s)).toBeNull();
  });

  it("reports loops, ahead of a missing name", () => {
    const s = vars(
      makePreviewVar("a", "{{missing}}{{b}}"),
      makePreviewVar("b", "{{a}}"),
      makePreviewVar("self", "x{{self}}"),
    );
    expect(nestedProblem("a", s)).toEqual({ kind: "cycle", chain: ["a", "b", "a"] });
    expect(nestedProblem("self", s)).toEqual({ kind: "cycle", chain: ["self", "self"] });
    expect(describeVar("b", s).note).toMatch(/^Refers to itself in a loop \(b -> a -> b\)/);
  });

  it("stops at Go's depth limit", () => {
    const chain = Array.from({ length: MAX_DEPTH + 2 }, (_, i) =>
      makePreviewVar(`v${i}`, i === MAX_DEPTH + 1 ? "end" : `{{v${i + 1}}}`),
    );
    const s = vars(...chain);
    const p = nestedProblem("v0", s)!;
    expect(p.kind).toBe("tooDeep");
    expect(problemText(p)).toMatch(/^Nested more than 10 levels deep \(v0 -> v1 .* -> v10\)/);
    // Exactly MAX_DEPTH levels is fine.
    expect(nestedProblem("v2", s)).toBeNull();
  });

  it("isn't judged while loading, and is cached per scope", () => {
    const loading = makeScope([makePreviewVar("a", "{{b}}")], null, true, false);
    expect(varKind("a", loading)).toBe("resolved");
    expect(describeVar("a", loading).kind).toBe("resolved");
    const s = vars(makePreviewVar("a", "{{b}}"));
    expect(nestedProblem("a", s)).toBe(nestedProblem("a", s));
  });
});
