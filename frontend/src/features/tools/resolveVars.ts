import type { PreviewVariable } from "@/lib/model";
import { DYNAMIC_VARIABLES, MAX_DEPTH, type VarScope } from "@/lib/variables";
import { varTokens } from "@/lib/varTokens";

/** How a tool input with `{{variables}}` resolves. */
export type Resolution =
  /** Every reference resolved (or there were none). `secrets` lists the revealed secrets used. */
  | { kind: "resolved"; value: string; hasVars: boolean; secrets: string[] }
  /** Variables are still loading. */
  | { kind: "pending" }
  /** A secret is used and hasn't been revealed in this tab. */
  | { kind: "secret"; variable: PreviewVariable }
  | { kind: "error"; message: string };

const DYNAMIC = new Set(DYNAMIC_VARIABLES.map((d) => d.name));

class Stop {
  constructor(readonly result: Exclude<Resolution, { kind: "resolved" }>) {}
}

/**
 * Resolves `{{variables}}` in a tool's input with the variables visible from
 * the active environment (the same values the send pipeline uses; nested
 * references are followed like Go's resolver). Secret values never come from
 * Go here: a secret resolves only once the user revealed it (`revealed`,
 * by name); until then the result asks for it.
 */
export function resolveVars(text: string, scope: VarScope, revealed: Record<string, string>): Resolution {
  const secrets = new Set<string>();

  const expand = (input: string, stack: string[]): string => {
    let out = "";
    let pos = 0;
    for (const t of varTokens(input)) {
      out += input.slice(pos, t.from) + valueOf(t.name, stack);
      pos = t.to;
    }
    return out + input.slice(pos);
  };

  const valueOf = (name: string, stack: string[]): string => {
    if (DYNAMIC.has(name)) {
      throw new Stop({
        kind: "error",
        message: `{{${name}}} is a dynamic variable, which gets a new value on every send. Use a variable that holds the token.`,
      });
    }
    const v = scope.variables.get(name);
    if (!v) {
      if (!scope.ready) throw new Stop({ kind: "pending" });
      throw new Stop({
        kind: "error",
        message: scope.hasWorkspace
          ? `{{${name}}} isn't defined in any active scope. Check the selected environment.`
          : `{{${name}}} can't be resolved without a workspace. Open one, or paste the token itself.`,
      });
    }
    if (stack.includes(name)) {
      throw new Stop({
        kind: "error",
        message: `{{${name}}} refers to itself in a loop (${[...stack, name].join(" -> ")}).`,
      });
    }
    if (stack.length >= MAX_DEPTH) {
      throw new Stop({ kind: "error", message: `Variables are nested more than ${MAX_DEPTH} levels deep.` });
    }
    let value: string;
    if (v.secret) {
      if (!v.set) {
        throw new Stop({
          kind: "error",
          message: `{{${name}}} is a secret that isn't set on this machine. Set its value in ${v.scopeName || "its scope"}.`,
        });
      }
      if (!(name in revealed)) throw new Stop({ kind: "secret", variable: v });
      secrets.add(name);
      value = revealed[name];
    } else {
      if (!v.set) {
        throw new Stop({ kind: "error", message: `{{${name}}} has no value.` });
      }
      value = v.value;
    }
    return expand(value, [...stack, name]);
  };

  try {
    const value = expand(text, []);
    return { kind: "resolved", value, hasVars: varTokens(text).length > 0, secrets: [...secrets] };
  } catch (e) {
    if (e instanceof Stop) return e.result;
    throw e;
  }
}
