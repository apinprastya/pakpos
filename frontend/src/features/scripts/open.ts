import type { ScriptEvent, ScriptSource } from "@/lib/model";
import { useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";

/** Shows a request tab's Scripts section on the given script. */
export function openRequestScripts(tabId: string, event: ScriptEvent): void {
  const tabs = useTabsStore.getState();
  tabs.activate(tabId);
  tabs.setSection(tabId, "request", "scripts");
  tabs.setSection(tabId, "scripts", event);
}

/** Opens a collection's or folder's settings tab on its Scripts section. */
export function openContainerScripts(
  level: { kind: "collection" | "folder"; id: string; name: string },
  event: ScriptEvent,
): void {
  const workspaceId = useWorkspaceStore.getState().workspace?.id ?? "";
  const tabs = useTabsStore.getState();
  const tabId = tabs.openDoc(level.kind, level.id, level.name, workspaceId);
  tabs.setSection(tabId, "settings", "scripts");
  tabs.setSection(tabId, "scripts", event);
}

/** Opens the script a result came from: the request's own (in `tabId`) or a collection's or folder's. */
export function openScriptSource(tabId: string, source: ScriptSource): void {
  if (source.kind === "request") openRequestScripts(tabId, source.event);
  else openContainerScripts({ kind: source.kind, id: source.id, name: source.name }, source.event);
}
