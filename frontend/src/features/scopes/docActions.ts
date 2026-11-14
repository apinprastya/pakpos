import { toast } from "sonner";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import {
  emptyAuth,
  type CollectionSettings,
  type Environment,
  type FolderSettings,
  type ScopeRef,
  type SecretRename,
  type Variable,
} from "@/lib/model";
import { useSecretsStore } from "@/stores/secrets";
import { findNode } from "@/lib/tree";
import { useEnvironmentsStore } from "@/stores/environments";
import {
  compactDraft,
  draftsEqual,
  isDirty,
  tabTitle,
  useTabsStore,
  type DocDraft,
  type DocState,
  type Tab,
} from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";

export function variablesDraft(variables: Variable[]): DocDraft {
  return { auth: emptyAuth(), headers: [], variables };
}

export function collectionDraft(c: CollectionSettings): DocDraft {
  return { auth: c.auth, headers: c.headers, variables: c.variables };
}

export function folderDraft(f: FolderSettings): DocDraft {
  return { auth: f.auth, headers: f.headers, variables: [] };
}

/**
 * Secret rows whose key changed since they were saved: `from` (the saved key)
 * → `to`. Go moves their stored values when the save writes the new keys.
 */
export function secretRenames(draft: Variable[], saved: Variable[]): SecretRename[] {
  const savedSecrets = new Set(saved.filter((v) => v.secret).map((v) => v.key));
  return draft
    .filter((v) => v.secret && v.origin && v.origin !== v.key && v.key.trim() && savedSecrets.has(v.origin))
    .map((v) => ({ from: v.origin!, to: v.key }));
}

/** The variable scope a doc tab edits, or null for a folder (folders have no variables). */
export function docScope(doc: Pick<DocState, "kind" | "targetId">): ScopeRef | null {
  switch (doc.kind) {
    case "environment":
      return { kind: "environment", id: doc.targetId };
    case "globals":
      return { kind: "global", id: "" };
    case "collection":
      return { kind: "collection", id: doc.targetId };
    default:
      return null;
  }
}

function currentWorkspaceId(): string {
  return useWorkspaceStore.getState().workspace?.id ?? "";
}

function findTab(tabId: string): Tab | undefined {
  return useTabsStore.getState().tabs.find((t) => t.id === tabId);
}

/** Reads what a doc tab edits from Go, with its current name. */
async function readDoc(doc: DocState): Promise<{ draft: DocDraft; name: string }> {
  switch (doc.kind) {
    case "environment": {
      const e = await api.getEnvironment(doc.targetId);
      return { draft: variablesDraft(e.variables), name: e.name };
    }
    case "globals": {
      const g = await api.getGlobals();
      return { draft: variablesDraft(g.variables), name: "Globals" };
    }
    case "collection": {
      const c = await api.getCollection(doc.targetId);
      return { draft: collectionDraft(c), name: c.name };
    }
    case "folder": {
      const f = await api.getFolder(doc.targetId);
      return { draft: folderDraft(f), name: f.name };
    }
  }
}

/** Loads a doc tab that has no draft yet. Rejects with Go's error so the editor can show it. */
export async function loadDocTab(tabId: string): Promise<void> {
  const tab = findTab(tabId);
  if (!tab?.doc) return;
  const { draft, name } = await readDoc(tab.doc);
  useTabsStore.getState().markDocSaved(tabId, draft, name);
}

/** Saves an environment, globals, collection or folder settings tab. Resolves true on success. */
export async function saveDocTab(tabId: string, closeAfter = false): Promise<boolean> {
  const tab = findTab(tabId);
  const doc = tab?.doc;
  if (!tab || !doc?.draft) return false;
  if (doc.missing) {
    toast.error(`Couldn't save ${tabTitle(tab)}`, {
      description: "It was deleted outside the app. Copy your changes elsewhere, then close the tab.",
    });
    return false;
  }
  const renames = secretRenames(doc.draft.variables, doc.saved?.variables ?? []);
  // Moving a renamed secret's value needs the store; unlock first rather than lose it.
  if (renames.length > 0 && !(await useSecretsStore.getState().ensureReady())) return false;
  const d = compactDraft(doc.draft);
  try {
    let saved: DocDraft;
    switch (doc.kind) {
      case "environment":
        saved = variablesDraft(
          await api.saveVariables({ kind: "environment", id: doc.targetId }, d.variables, renames),
        );
        break;
      case "globals":
        saved = variablesDraft((await api.saveGlobals(d.variables, renames)).variables);
        break;
      case "collection":
        saved = collectionDraft(await api.saveCollection(doc.targetId, d, renames));
        break;
      case "folder":
        saved = folderDraft(await api.saveFolder(doc.targetId, { auth: d.auth, headers: d.headers }));
        break;
    }
    useTabsStore.getState().markDocSaved(tabId, saved);
    if (closeAfter) useTabsStore.getState().close(tabId);
    toast.success(`${tabTitle(tab)} saved`);
    // The app's own writes don't fire workspace:changed: refresh what depends on them.
    if (doc.kind === "environment" || doc.kind === "globals") void useEnvironmentsStore.getState().load();
    else useEnvironmentsStore.getState().touch();
    return true;
  } catch (e) {
    toast.error(`Couldn't save ${tabTitle(tab)}`, { description: errorMessage(e) });
    return false;
  }
}

/** Opens the settings tab of a collection or folder in the open workspace. */
export function openContainerSettings(id: string): void {
  const node = findNode(useWorkspaceStore.getState().collections, id);
  if (!node || node.kind === "request") return;
  useTabsStore.getState().openDoc(node.kind, id, node.name, currentWorkspaceId());
}

/** Open doc tabs that belong to the open workspace and match `kinds`. */
function docTabs(kinds: DocState["kind"][]): Tab[] {
  const ws = currentWorkspaceId();
  if (!ws) return [];
  return useTabsStore
    .getState()
    .tabs.filter((t) => t.doc && kinds.includes(t.doc.kind) && t.workspaceId === ws);
}

/** A doc tab's target is gone: close it, or keep it (marked) when it has edits. */
function targetGone(tab: Tab) {
  if (isDirty(tab)) {
    if (!tab.doc?.missing) {
      useTabsStore.getState().patchDoc(tab.id, { missing: true });
      toast.warning(`"${tabTitle(tab)}" was deleted`, {
        description: "Your unsaved edits are kept in the tab so you can copy them. It can't be saved.",
      });
    }
  } else {
    useTabsStore.getState().close(tab.id);
  }
}

/** Applies a version read from disk; tells the user when it changed under their edits. */
function applyDisk(tab: Tab, disk: DocDraft) {
  const doc = tab.doc;
  if (!doc?.saved || draftsEqual(disk, doc.saved)) return;
  if (isDirty(tab)) {
    toast.info(`"${tabTitle(tab)}" changed on disk`, {
      description: "Your unsaved edits are kept. Saving replaces the file with your version.",
    });
  }
  useTabsStore.getState().applyDocDisk(tab.id, disk);
}

/**
 * Brings environment and globals tabs in line with the environments store
 * (which always holds what's on disk): names, deletions and external edits.
 */
export function syncEnvironmentTabs(): void {
  const env = useEnvironmentsStore.getState();
  if (env.status !== "ready" || env.workspaceId !== currentWorkspaceId()) return;
  const byId = new Map<string, Environment>(env.environments.map((e) => [e.id, e]));
  for (const tab of docTabs(["environment", "globals"])) {
    const doc = tab.doc!;
    if (doc.kind === "globals") {
      if (env.globals) applyDisk(tab, variablesDraft(env.globals.variables));
      continue;
    }
    const e = byId.get(doc.targetId);
    if (!e) {
      targetGone(tab);
      continue;
    }
    if (e.name !== doc.name) useTabsStore.getState().patchDoc(tab.id, { name: e.name });
    applyDisk(tab, variablesDraft(e.variables));
  }
}

/** Keeps collection and folder settings tabs in step with the tree: names and deletions. */
export function syncContainerTabs(): void {
  const ws = useWorkspaceStore.getState();
  if (ws.status !== "ready" || !ws.treeLoaded) return;
  for (const tab of docTabs(["collection", "folder"])) {
    const node = findNode(ws.collections, tab.doc!.targetId);
    if (!node || node.kind !== tab.doc!.kind) {
      targetGone(tab);
      continue;
    }
    if (node.name !== tab.doc!.name) useTabsStore.getState().patchDoc(tab.id, { name: node.name });
  }
}

/** Re-reads open collection and folder settings tabs from disk (after an external change). */
export async function reloadContainerTabs(): Promise<void> {
  for (const tab of docTabs(["collection", "folder"])) {
    if (!tab.doc?.saved) continue;
    try {
      const { draft } = await readDoc(tab.doc);
      const current = findTab(tab.id);
      if (current) applyDisk(current, draft);
    } catch {
      // Deleted (syncContainerTabs handles it) or mid-write; the next change retries.
    }
  }
}
