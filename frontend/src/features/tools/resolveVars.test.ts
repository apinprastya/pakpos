import { makePreviewVar } from "@/test/fixtures";
import { makeScope } from "@/lib/variables";
import { resolveVars } from "./resolveVars";

const scope = makeScope(
  [
    makePreviewVar("token", "abc.def.ghi"),
    makePreviewVar("host", "api"),
    makePreviewVar("url", "https://{{host}}/x"),
    makePreviewVar("loop", "{{loop2}}"),
    makePreviewVar("loop2", "{{loop}}"),
    makePreviewVar("access_token", "", { secret: true, set: true, scope: "environment", scopeId: "e1" }),
    makePreviewVar("unset_secret", "", { secret: true, set: false }),
    makePreviewVar("empty", "", { set: false }),
    makePreviewVar("wrapped", "Bearer {{access_token}}"),
    ...Array.from({ length: 12 }, (_, i) => makePreviewVar(`d${i}`, `{{d${i + 1}}}`)),
  ],
  { id: "e1", name: "Dev" },
  true,
);

describe("resolveVars", () => {
  it.each<[string, Record<string, string>, unknown]>([
    ["plain.text", {}, { kind: "resolved", value: "plain.text", hasVars: false, secrets: [] }],
    ["{{token}}", {}, { kind: "resolved", value: "abc.def.ghi", hasVars: true, secrets: [] }],
    ["{{ url }}", {}, { kind: "resolved", value: "https://api/x", hasVars: true, secrets: [] }],
    [
      "{{wrapped}}",
      { access_token: "s.e.c" },
      { kind: "resolved", value: "Bearer s.e.c", hasVars: true, secrets: ["access_token"] },
    ],
  ])("resolves %j", (text, revealed, want) => {
    expect(resolveVars(text, scope, revealed)).toEqual(want);
  });

  it("asks for an unrevealed secret, even nested", () => {
    for (const text of ["{{access_token}}", "{{wrapped}}"]) {
      const r = resolveVars(text, scope, {});
      expect(r.kind).toBe("secret");
      expect(r.kind === "secret" && r.variable.key).toBe("access_token");
    }
  });

  it.each([
    ["{{missing}}", "{{missing}} isn't defined in any active scope. Check the selected environment."],
    ["{{$guid}}", "{{$guid}} is a dynamic variable"],
    ["{{unset_secret}}", "{{unset_secret}} is a secret that isn't set on this machine."],
    ["{{empty}}", "{{empty}} has no value."],
    ["{{loop}}", "{{loop}} refers to itself in a loop (loop -> loop2 -> loop)."],
    ["{{d0}}", "Variables are nested more than 10 levels deep."],
  ])("explains %j", (text, message) => {
    const r = resolveVars(text, scope, {});
    expect(r.kind).toBe("error");
    expect(r.kind === "error" && r.message).toContain(message);
  });

  it("waits for variables while they load, and needs a workspace to resolve any", () => {
    expect(resolveVars("{{token}}", makeScope([], null, true, false), {})).toEqual({ kind: "pending" });
    const none = resolveVars("{{token}}", makeScope([], null, false), {});
    expect(none.kind === "error" && none.message).toBe(
      "{{token}} can't be resolved without a workspace. Open one, or paste the token itself.",
    );
  });
});
