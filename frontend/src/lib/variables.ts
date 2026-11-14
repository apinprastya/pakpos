import type { EnvRef, PreviewVariable, ScopeKind, Variable } from "@/lib/model";
import { varTokens } from "@/lib/varTokens";

/**
 * What editors know about variables: the visible ones (winning definitions,
 * secret values always ""), the selected environment, and whether a
 * workspace is open. Built once per tab and shared by every editor in it.
 */
export interface VarScope {
  variables: ReadonlyMap<string, PreviewVariable>;
  environment: EnvRef | null;
  hasWorkspace: boolean;
  /** False until the first answer from Go: names aren't marked unresolved yet. */
  ready: boolean;
}

export const EMPTY_SCOPE: VarScope = {
  variables: new Map(),
  environment: null,
  hasWorkspace: false,
  ready: true,
};

export function makeScope(
  variables: readonly PreviewVariable[],
  environment: EnvRef | null,
  hasWorkspace: boolean,
  ready = true,
): VarScope {
  return { variables: new Map(variables.map((v) => [v.key, v])), environment, hasWorkspace, ready };
}

/** Dynamic variables (Go `vars.DynamicNames`), with what each one produces. */
export const DYNAMIC_VARIABLES: readonly { name: string; description: string }[] = [
  { name: "$guid", description: "A random UUID v4, new for each use." },
  { name: "$randomUUID", description: "A random UUID v4, new for each use. Same as $guid." },
  { name: "$timestamp", description: "The current Unix time in seconds." },
  {
    name: "$isoTimestamp",
    description: "The current time in UTC as ISO 8601 with milliseconds, e.g. 2026-01-31T09:30:00.000Z.",
  },
  { name: "$randomInt", description: "A random whole number from 0 to 1000, new for each use." },
];

const DYNAMIC = new Map(DYNAMIC_VARIABLES.map((d) => [d.name, d.description]));

/** Shown instead of a secret's value: the value never reaches the UI here. */
export const MASK = "••••••••";

/**
 * "pending": variables are still loading, so the name isn't judged yet.
 * "warn": the name is defined, but its value uses one that isn't (or loops).
 */
export type VarKind = "resolved" | "unresolved" | "dynamic" | "pending" | "warn";

/** Same limit as Go's `vars.MaxDepth`. */
export const MAX_DEPTH = 10;

/** Why a defined variable's value won't resolve fully. */
export type NestedProblem =
  | { kind: "missing"; name: string; unset: boolean }
  | { kind: "cycle"; chain: string[] }
  | { kind: "tooDeep"; chain: string[] };

const nestedCache = new WeakMap<VarScope, Map<string, NestedProblem | null>>();

/**
 * Follows the references inside a defined variable's value, like Go's
 * resolver: the first undefined (or unset secret) name it uses, or a loop,
 * or nesting deeper than MAX_DEPTH. Secrets are opaque (their values never
 * reach the UI), so they're never flagged. Null when everything resolves,
 * and for names that aren't defined or are dynamic.
 */
export function nestedProblem(name: string, scope: VarScope): NestedProblem | null {
  let cache = nestedCache.get(scope);
  if (!cache) nestedCache.set(scope, (cache = new Map()));
  if (!cache.has(name)) cache.set(name, walk(name, [], scope));
  return cache.get(name)!;
}

function walk(name: string, stack: string[], scope: VarScope): NestedProblem | null {
  const v = scope.variables.get(name);
  if (!v || !v.set || v.secret) return null;
  let missing: NestedProblem | null = null;
  const inner = [...stack, name];
  for (const t of varTokens(v.value)) {
    if (DYNAMIC.has(t.name)) continue;
    const ref = scope.variables.get(t.name);
    if (!ref || !ref.set) {
      missing ??= { kind: "missing", name: t.name, unset: Boolean(ref) };
      continue;
    }
    const at = inner.indexOf(t.name);
    if (at >= 0) return { kind: "cycle", chain: [...inner.slice(at), t.name] };
    if (inner.length >= MAX_DEPTH) return { kind: "tooDeep", chain: [...inner, t.name] };
    const deeper = walk(t.name, inner, scope);
    if (deeper && deeper.kind !== "missing") return deeper;
    missing ??= deeper;
  }
  return missing;
}

/** The problem in words, for the tooltip. */
export function problemText(p: NestedProblem): string {
  switch (p.kind) {
    case "missing":
      return p.unset
        ? `Uses {{${p.name}}}, a secret that is not set on this machine`
        : `Uses {{${p.name}}}, which is not defined in any active scope`;
    case "cycle":
      return `Refers to itself in a loop (${p.chain.join(" -> ")}). Change one of them so the loop ends.`;
    default:
      return `Nested more than ${MAX_DEPTH} levels deep (${p.chain.join(" -> ")}). Simplify the references.`;
  }
}

/** How a reference resolves. Dynamic names win over scopes, like in Go. */
export function varKind(name: string, scope: VarScope): VarKind {
  if (DYNAMIC.has(name)) return "dynamic";
  const v = scope.variables.get(name);
  if (v) {
    if (!v.set) return "unresolved";
    return scope.ready && nestedProblem(name, scope) ? "warn" : "resolved";
  }
  return scope.ready ? "unresolved" : "pending";
}

/** Where a variable comes from, e.g. "Environment: Development". */
export function scopeLabel(kind: ScopeKind, name: string): string {
  switch (kind) {
    case "global":
      return "Globals";
    case "environment":
      return `Environment: ${name}`;
    case "collection":
      return `Collection: ${name}`;
    default:
      return "Local";
  }
}

/** Everything a hover or keyboard tooltip shows for one reference. */
export interface VarInfo {
  kind: VarKind;
  name: string;
  /** The value to show (masked for secrets), or null with `note` instead. */
  value: string | null;
  /** Shown when there's no value to show, e.g. "Not set on this machine". */
  note: string;
  /** Where it comes from, or "" (dynamic and undefined names). */
  source: string;
  /** What to do next (undefined names), or a dynamic variable's description. */
  hint: string;
}

export function describeVar(name: string, scope: VarScope): VarInfo {
  const description = DYNAMIC.get(name);
  if (description !== undefined) {
    return { kind: "dynamic", name, value: null, note: "", source: "Dynamic variable", hint: description };
  }
  const v = scope.variables.get(name);
  if (!v && !scope.ready) {
    return { kind: "pending", name, value: null, note: "Loading variables…", source: "", hint: "" };
  }
  if (!v) {
    let hint: string;
    if (!scope.hasWorkspace) hint = "Open a workspace to define variables.";
    else if (scope.environment)
      hint = `Add it to ${scope.environment.name}, the collection or globals, or check the spelling.`;
    else hint = "Select an environment, or add the variable to the collection or globals.";
    return {
      kind: "unresolved",
      name,
      value: null,
      note: "Not defined in any active scope",
      source: "",
      hint,
    };
  }
  const source = scopeLabel(v.scope, v.scopeName);
  if (v.secret) {
    return v.set
      ? { kind: "resolved", name, value: MASK, note: "", source: `${source} · secret`, hint: "" }
      : {
          kind: "unresolved",
          name,
          value: null,
          note: "Not set on this machine",
          source: `${source} · secret`,
          hint: "Set its value in the variables editor, or unlock the secret store.",
        };
  }
  const problem = scope.ready ? nestedProblem(name, scope) : null;
  return {
    kind: problem ? "warn" : "resolved",
    name,
    value: v.value,
    note: problem ? problemText(problem) : v.value === "" ? "Empty value" : "",
    source,
    hint: "",
  };
}

const RANK: Record<ScopeKind, number> = { global: 0, collection: 1, environment: 2, local: 3 };

/**
 * Applies the unsaved rows of the scope being edited (an environment,
 * globals or a collection's variables tab) over the variables Go sees on
 * disk, so references between new rows highlight before saving. A row loses
 * to a higher scope's definition of the same name. Secret rows never carry
 * a value; their `set` flag is kept from disk (false for new ones). Rows
 * removed from the draft disappear, even if a lower scope defines the name.
 */
export function overlayDraft(
  visible: readonly PreviewVariable[],
  target: { kind: ScopeKind; id: string; name: string },
  draft: readonly Variable[],
): PreviewVariable[] {
  const byKey = new Map<string, PreviewVariable>();
  const ownSaved = new Map<string, PreviewVariable>();
  for (const v of visible) {
    // There is one globals scope; its id may not be known to the editor ("").
    if (v.scope === target.kind && (target.kind === "global" || v.scopeId === target.id))
      ownSaved.set(v.key, v);
    else byKey.set(v.key, v);
  }
  for (const row of draft) {
    const key = row.key.trim();
    if (!row.enabled || !key) continue;
    const other = byKey.get(key);
    if (other && RANK[other.scope] > RANK[target.kind]) continue;
    const saved = ownSaved.get(key);
    byKey.set(key, {
      key,
      value: row.secret ? "" : row.value,
      secret: row.secret,
      scope: target.kind,
      scopeId: target.id,
      scopeName: target.name,
      set: row.secret ? Boolean(saved?.secret && saved.set) : true,
    });
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** A stable string for a scope's content, to memoize on. */
export function scopeSignature(
  variables: readonly PreviewVariable[],
  environment: EnvRef | null,
  hasWorkspace: boolean,
  ready: boolean,
): string {
  return JSON.stringify([hasWorkspace, ready, environment?.id ?? "", environment?.name ?? "", variables]);
}
