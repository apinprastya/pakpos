import type { CollectionNode, ContainerNode, RequestSummary } from "@/lib/model";
import type { RunConfig } from "@/lib/runModel";
import { findContainer } from "@/lib/tree";
import { useTabsStore, type RunnerSettings } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";

/** A request in run order, with the folders between the target and it. */
export interface RunOrderItem {
  request: RequestSummary;
  folders: string[];
}

/** The requests of a collection or folder in run order: depth-first, in tree order. */
export function runOrder(target: ContainerNode): RunOrderItem[] {
  const out: RunOrderItem[] = [];
  const visit = (node: ContainerNode, folders: string[]) => {
    for (const c of node.children) {
      if (c.kind === "request") out.push({ request: c, folders });
      else visit(c, [...folders, c.name]);
    }
  };
  visit(target, []);
  return out;
}

/** Names from the collection down to a container ("" ids give []). */
export function containerPath(collections: CollectionNode[], id: string): string[] {
  const walk = (node: ContainerNode, trail: string[]): string[] | null => {
    const here = [...trail, node.name];
    if (node.id === id) return here;
    for (const c of node.children) {
      if (c.kind === "folder") {
        const found = walk(c, here);
        if (found) return found;
      }
    }
    return null;
  };
  for (const c of collections) {
    const found = walk(c, []);
    if (found) return found;
  }
  return [];
}

/** Opens (or focuses) the runner tab of a collection or folder in the open workspace. */
export function openRunnerFor(id: string): string | null {
  const ws = useWorkspaceStore.getState();
  const node = findContainer(ws.collections, id);
  if (!node || !ws.workspace) return null;
  return useTabsStore.getState().openRunner(node.kind, id, node.name, ws.workspace.id);
}

/** The ids of the selected requests, in run order. */
export function selectedIds(order: RunOrderItem[], settings: RunnerSettings): string[] {
  const excluded = new Set(settings.excludedIds);
  return order.map((o) => o.request.id).filter((id) => !excluded.has(id));
}

/** What to send to Go for a runner tab. */
export function toRunConfig(
  targetId: string,
  order: RunOrderItem[],
  settings: RunnerSettings,
  selectedEnvironment: string,
): RunConfig {
  const ids = selectedIds(order, settings);
  return {
    targetId,
    // Everything selected: send none, so requests added since still run in Go's order.
    requestIds: ids.length === order.length ? [] : ids,
    environmentId: settings.environmentId ?? selectedEnvironment,
    iterations: settings.dataFile ? 0 : settings.iterations,
    delayMs: settings.delayMs,
    dataFile: settings.dataFile,
    stopOnFailure: settings.stopOnFailure,
    keepVariables: settings.keepVariables,
    saveResponses: settings.saveResponses,
    recordHistory: settings.recordHistory,
  };
}
