import { api } from "@/lib/api";
import type { ScopeRef, Variable } from "@/lib/model";
import { findNode } from "@/lib/tree";
import { useEnvironmentsStore } from "@/stores/environments";
import { useSecretsStore } from "@/stores/secrets";
import { isDirty, tabTitle, useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";
import { reloadContainerTabs } from "./docActions";

export interface ScopeOption {
  value: "environment" | "collection" | "global";
  scope: ScopeRef;
  label: string;
}

/** Where a secret can go: the selected environment, the collection, the globals (in that order). */
export function scopeOptions(collectionId: string): ScopeOption[] {
  const env = useEnvironmentsStore.getState();
  const selected = env.environments.find((e) => e.id === env.selectedId);
  const collection = collectionId
    ? findNode(useWorkspaceStore.getState().collections, collectionId)
    : undefined;
  const out: ScopeOption[] = [];
  if (selected) {
    out.push({
      value: "environment",
      scope: { kind: "environment", id: selected.id },
      label: `Environment: ${selected.name}`,
    });
  }
  if (collection?.kind === "collection") {
    out.push({
      value: "collection",
      scope: { kind: "collection", id: collection.id },
      label: `Collection: ${collection.name}`,
    });
  }
  out.push({ value: "global", scope: { kind: "global", id: "" }, label: "Globals" });
  return out;
}

/** Checks a new variable name; returns the problem or null. */
export function variableNameError(name: string): string | null {
  if (!name) return "Enter a variable name.";
  if (/[\s{}]/.test(name)) return "Use a name without spaces or braces, like apiToken.";
  if (name.startsWith("$")) return "Names starting with $ are reserved for dynamic variables.";
  return null;
}

async function scopeVariables(scope: ScopeRef): Promise<Variable[]> {
  if (scope.kind === "environment") return (await api.getEnvironment(scope.id)).variables;
  if (scope.kind === "collection") return (await api.getCollection(scope.id)).variables;
  return (await api.getGlobals()).variables;
}

/** An open tab with unsaved edits to the scope; saving it later would drop the new variable. */
function dirtyScopeTab(scope: ScopeRef) {
  const kind = scope.kind === "global" ? "globals" : scope.kind;
  return useTabsStore
    .getState()
    .tabs.find(
      (t) => t.doc?.kind === kind && (kind === "globals" || t.doc.targetId === scope.id) && isDirty(t),
    );
}

/**
 * Stores `value` as a new secret variable `name` in `scope`. Rejects with a
 * message for the user (name taken, unsaved edits to the scope, store errors).
 * Resolves false when the user cancels unlocking.
 */
export async function moveToSecret(
  scope: ScopeRef,
  label: string,
  name: string,
  value: string,
): Promise<boolean> {
  const dirty = dirtyScopeTab(scope);
  if (dirty) throw new Error(`Save or discard your changes in "${tabTitle(dirty)}" first.`);
  const vars = await scopeVariables(scope);
  if (vars.some((v) => v.key === name)) {
    throw new Error(`${label} already has a variable named ${name}. Choose another name.`);
  }
  if (!(await useSecretsStore.getState().ensureReady())) return false;
  await api.setSecret(scope, name, value);
  await api.saveVariables(scope, [...vars, { key: name, value: "", enabled: true, secret: true }]);
  // The app's own writes don't fire workspace:changed: refresh what shows variables.
  await useEnvironmentsStore.getState().load();
  if (scope.kind === "collection") await reloadContainerTabs();
  return true;
}
