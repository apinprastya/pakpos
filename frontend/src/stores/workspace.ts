import { create } from "zustand";
import { toast } from "sonner";
import { api, type WorkspaceChange } from "@/lib/api";
import { errorMessage, plural } from "@/lib/errors";
import {
  emptyRequest,
  requestsEqual,
  type CollectionNode,
  type Problem,
  type RecentWorkspace,
  type WorkspaceInfo,
} from "@/lib/model";
import { isDirty, tabTitle, useTabsStore } from "@/stores/tabs";

export type WorkspaceStatus = "loading" | "none" | "ready";

interface WorkspaceState {
  status: WorkspaceStatus;
  workspace: WorkspaceInfo | null;
  collections: CollectionNode[];
  problems: Problem[];
  recent: RecentWorkspace[];
  /** Tree item that should start in rename mode (just created). */
  renameTarget: string | null;

  init: () => Promise<void>;
  /** Reloads the tree. `fromDisk` also re-reads open requests to pick up external edits. */
  refresh: (opts?: { fromDisk?: boolean }) => Promise<void>;
  loadRecent: () => Promise<void>;
  handleChange: (change: WorkspaceChange) => Promise<void>;
  openPath: (path: string) => Promise<boolean>;
  /** Opens the folder as a workspace, creating one there if it isn't one yet. */
  openOrCreate: (path: string) => Promise<void>;
  openFolder: () => Promise<void>;
  createInFolder: () => Promise<void>;
  close: () => Promise<void>;
  removeRecent: (path: string) => Promise<void>;
  setRenameTarget: (id: string | null) => void;

  createCollection: (name?: string) => Promise<string | null>;
  renameCollection: (id: string, name: string) => Promise<void>;
  deleteCollection: (id: string) => Promise<void>;
  reorderCollections: (ids: string[]) => Promise<void>;

  openRequest: (id: string) => Promise<void>;
  newRequest: (collectionId: string) => Promise<void>;
  renameRequest: (id: string, name: string) => Promise<void>;
  duplicateRequest: (id: string) => Promise<void>;
  deleteRequest: (id: string) => Promise<void>;
  /** Moves a request to another collection at `index`, or reorders within its own. */
  moveRequest: (id: string, toCollectionId: string, index: number) => Promise<void>;
}

const NOT_WORKSPACE = "not a pakpos workspace";
const ALREADY_EXISTS = "a workspace already exists here";

function fail(title: string, e: unknown) {
  toast.error(title, { description: errorMessage(e) });
}

function collectionOf(collections: CollectionNode[], requestId: string): CollectionNode | undefined {
  return collections.find((c) => c.requests.some((r) => r.id === requestId));
}

/**
 * Tabs saved in another workspace can't stay linked once a different one is open:
 * clean ones close, ones with edits stay open as unsaved requests.
 */
function releaseForeignTabs(workspaceId: string | null) {
  const tabs = useTabsStore.getState();
  let kept = 0;
  for (const tab of tabs.tabs) {
    if (!tab.saved || !tab.workspaceId || tab.workspaceId === workspaceId) continue;
    if (isDirty(tab)) {
      tabs.detach(tab.id);
      kept += 1;
    } else {
      useTabsStore.getState().close(tab.id);
    }
  }
  if (kept) {
    toast.info(`${plural(kept, "request")} with unsaved edits kept open`, {
      description: "They're no longer linked to a file. Save them to add them to this workspace.",
    });
  }
}

/** Brings open tabs in line with the tree (and, with `fromDisk`, with file contents). */
async function syncTabs(workspaceId: string, collections: CollectionNode[], fromDisk: boolean) {
  const location = new Map<string, string>();
  for (const c of collections) for (const r of c.requests) location.set(r.id, c.id);

  const deleted: string[] = [];
  const changedWithEdits: string[] = [];
  const candidates = useTabsStore
    .getState()
    .tabs.filter((t) => t.saved && (t.workspaceId === workspaceId || t.workspaceId === ""));

  for (const candidate of candidates) {
    const id = candidate.saved!.id;
    const collectionId = location.get(id);
    if (!collectionId) {
      deleted.push(tabTitle(candidate));
      useTabsStore.getState().detach(candidate.id);
      continue;
    }
    if (fromDisk) {
      try {
        const disk = await api.getRequest(id);
        const tab = useTabsStore.getState().tabs.find((t) => t.id === candidate.id);
        if (tab?.saved && !requestsEqual(disk, tab.saved)) {
          if (isDirty(tab)) changedWithEdits.push(tabTitle(tab));
          useTabsStore.getState().applyDiskVersion(tab.id, disk, collectionId);
        }
      } catch {
        // Unreadable right now (e.g. mid-write); the next change event retries.
      }
    }
    useTabsStore.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === candidate.id ? { ...t, collectionId, workspaceId } : t)),
    }));
  }

  if (deleted.length === 1) {
    toast.warning(`"${deleted[0]}" was deleted from the workspace`, {
      description: "It's still open as an unsaved request. Save it to keep it.",
    });
  } else if (deleted.length > 1) {
    toast.warning(`${plural(deleted.length, "open request")} were deleted from the workspace`, {
      description: "They're still open as unsaved requests. Save them to keep them.",
    });
  }
  for (const name of changedWithEdits) {
    toast.info(`"${name}" changed on disk`, {
      description: "Your unsaved edits are kept. Saving replaces the file with your version.",
    });
  }
}

export const useWorkspaceStore = create<WorkspaceState>()((set, get) => {
  /** Makes `ws` the open workspace in the UI. */
  async function activate(ws: WorkspaceInfo) {
    set({ status: "ready", workspace: ws, collections: [], problems: [] });
    releaseForeignTabs(ws.id);
    await get().refresh({ fromDisk: true });
    void get().loadRecent();
  }

  return {
    status: "loading",
    workspace: null,
    collections: [],
    problems: [],
    recent: [],
    renameTarget: null,

    init: async () => {
      set({ status: "loading" });
      try {
        let ws = await api.currentWorkspace();
        await get().loadRecent();
        if (!ws) {
          const last = get().recent[0];
          if (last) ws = await api.openWorkspace(last.path).catch(() => null);
        }
        if (ws) {
          await activate(ws);
          return;
        }
      } catch (e) {
        fail("Couldn't load the workspace", e);
      }
      set({ status: "none", workspace: null, collections: [], problems: [] });
      releaseForeignTabs(null);
    },

    refresh: async ({ fromDisk = false } = {}) => {
      const ws = get().workspace;
      if (!ws) return;
      try {
        const tree = await api.tree();
        if (get().workspace?.id !== ws.id) return;
        set({ collections: tree.collections, problems: tree.problems });
        await syncTabs(ws.id, tree.collections, fromDisk);
      } catch (e) {
        fail("Couldn't load the workspace", e);
      }
    },

    loadRecent: async () => {
      try {
        set({ recent: await api.recentWorkspaces() });
      } catch {
        set({ recent: [] });
      }
    },

    handleChange: async (change) => {
      if (change.workspaceId !== get().workspace?.id) return;
      set({ problems: change.problems });
      await get().refresh({ fromDisk: true });
    },

    openPath: async (path) => {
      try {
        await activate(await api.openWorkspace(path));
        return true;
      } catch (e) {
        const msg = errorMessage(e);
        if (msg.includes(NOT_WORKSPACE)) {
          toast.error("This folder isn't a workspace yet", {
            description: path,
            action: {
              label: "Create workspace here",
              onClick: () => void createAt(path),
            },
          });
        } else {
          fail("Couldn't open the workspace", e);
        }
        void get().loadRecent();
        return false;
      }
    },

    openOrCreate: async (path) => {
      try {
        await activate(await api.openWorkspace(path));
      } catch (e) {
        if (errorMessage(e).includes(NOT_WORKSPACE)) await createAt(path);
        else fail("Couldn't open the workspace", e);
      }
    },

    openFolder: async () => {
      try {
        const path = await api.pickFolder();
        if (path) await get().openPath(path);
      } catch (e) {
        fail("Couldn't open the folder picker", e);
      }
    },

    createInFolder: async () => {
      try {
        const path = await api.pickFolder();
        if (path) await createAt(path);
      } catch (e) {
        fail("Couldn't open the folder picker", e);
      }
    },

    close: async () => {
      try {
        await api.closeWorkspace();
      } catch (e) {
        fail("Couldn't close the workspace", e);
        return;
      }
      set({ status: "none", workspace: null, collections: [], problems: [] });
      releaseForeignTabs(null);
      void get().loadRecent();
    },

    removeRecent: async (path) => {
      try {
        await api.removeRecent(path);
        set((s) => ({ recent: s.recent.filter((r) => r.path !== path) }));
      } catch (e) {
        fail("Couldn't remove it from recent workspaces", e);
      }
    },

    setRenameTarget: (id) => set({ renameTarget: id }),

    createCollection: async (name = "New collection") => {
      try {
        const c = await api.createCollection(name);
        await get().refresh();
        set({ renameTarget: c.id });
        return c.id;
      } catch (e) {
        fail("Couldn't create the collection", e);
        return null;
      }
    },

    renameCollection: async (id, name) => {
      const trimmed = name.trim();
      const current = get().collections.find((c) => c.id === id);
      if (!trimmed || !current || current.name === trimmed) return;
      try {
        await api.renameCollection(id, trimmed);
      } catch (e) {
        fail("Couldn't rename the collection", e);
      }
      await get().refresh();
    },

    deleteCollection: async (id) => {
      const col = get().collections.find((c) => c.id === id);
      try {
        await api.deleteCollection(id);
      } catch (e) {
        fail("Couldn't delete the collection", e);
        return;
      }
      for (const r of col?.requests ?? []) closeOrDetach(r.id);
      await get().refresh();
      toast.success("Collection deleted");
    },

    reorderCollections: async (ids) => {
      const byId = new Map(get().collections.map((c) => [c.id, c]));
      set({ collections: ids.map((id) => byId.get(id)).filter((c): c is CollectionNode => !!c) });
      try {
        await api.reorderCollections(ids);
      } catch (e) {
        fail("Couldn't reorder collections", e);
      }
      await get().refresh();
    },

    openRequest: async (id) => {
      const ws = get().workspace;
      const existing = useTabsStore.getState().tabs.find((t) => t.saved?.id === id);
      if (existing) {
        useTabsStore.getState().activate(existing.id);
        return;
      }
      try {
        const req = await api.getRequest(id);
        const col = collectionOf(get().collections, id);
        useTabsStore.getState().openSaved(req, col?.id ?? "", ws?.id ?? "");
      } catch (e) {
        fail("Couldn't open the request", e);
      }
    },

    newRequest: async (collectionId) => {
      try {
        const req = await api.saveAs(collectionId, "New request", { ...emptyRequest(), name: "New request" });
        await get().refresh();
        useTabsStore.getState().openSaved(req, collectionId, get().workspace?.id ?? "");
        set({ renameTarget: req.id });
      } catch (e) {
        fail("Couldn't create the request", e);
      }
    },

    renameRequest: async (id, name) => {
      const trimmed = name.trim();
      const summary = get()
        .collections.flatMap((c) => c.requests)
        .find((r) => r.id === id);
      if (!trimmed || !summary || summary.name === trimmed) return;
      try {
        await api.renameRequest(id, trimmed);
        const tab = useTabsStore.getState().tabs.find((t) => t.saved?.id === id);
        if (tab) useTabsStore.getState().renameSaved(tab.id, trimmed);
      } catch (e) {
        fail("Couldn't rename the request", e);
      }
      await get().refresh();
    },

    duplicateRequest: async (id) => {
      try {
        const copy = await api.duplicateRequest(id);
        await get().refresh();
        set({ renameTarget: copy.id });
      } catch (e) {
        fail("Couldn't duplicate the request", e);
      }
    },

    deleteRequest: async (id) => {
      try {
        await api.deleteRequest(id);
      } catch (e) {
        fail("Couldn't delete the request", e);
        return;
      }
      closeOrDetach(id);
      await get().refresh();
      toast.success("Request deleted");
    },

    moveRequest: async (id, toCollectionId, index) => {
      const collections = get().collections;
      const from = collectionOf(collections, id);
      const to = collections.find((c) => c.id === toCollectionId);
      if (!from || !to) return;
      const moving = from.requests.find((r) => r.id === id)!;
      const target = to.requests.filter((r) => r.id !== id);
      const at = Math.max(0, Math.min(index, target.length));
      target.splice(at, 0, moving);
      const ids = target.map((r) => r.id);
      if (from.id === to.id && ids.join() === from.requests.map((r) => r.id).join()) return;

      // Optimistic: show the new order right away.
      set({
        collections: collections.map((c) => {
          if (c.id === to.id) return { ...c, requests: target };
          if (c.id === from.id) return { ...c, requests: c.requests.filter((r) => r.id !== id) };
          return c;
        }),
      });
      try {
        if (from.id !== to.id) await api.moveRequest(id, to.id);
        await api.reorderRequests(to.id, ids);
      } catch (e) {
        fail("Couldn't move the request", e);
      }
      await get().refresh();
    },
  };

  async function createAt(path: string) {
    try {
      await activate(await api.createWorkspace(path, ""));
      toast.success("Workspace created");
    } catch (e) {
      if (errorMessage(e).includes(ALREADY_EXISTS)) {
        await get().openPath(path);
        return;
      }
      fail("Couldn't create the workspace", e);
    }
  }
});

/** After a request is deleted in the app: close its clean tab, keep edited ones as unsaved. */
function closeOrDetach(requestId: string) {
  const tab = useTabsStore.getState().tabs.find((t) => t.saved?.id === requestId);
  if (!tab) return;
  if (isDirty(tab)) useTabsStore.getState().detach(tab.id);
  else useTabsStore.getState().close(tab.id);
}
