import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import { emptyRequest, normalizeRequest, requestsEqual, type Request, type SendResult } from "@/lib/model";

export interface Tab {
  id: string;
  /** The request as currently edited. */
  request: Request;
  /** Last saved version; null when the request has never been saved. */
  saved: Request | null;
  /** Collection a saved request lives in. */
  collectionId: string;
  /** Workspace a saved request belongs to ("" when unknown or unsaved). */
  workspaceId: string;
  /** Running send, if any. */
  sendId: string | null;
  /** Last send result for this tab (not persisted). */
  result: SendResult | null;
}

interface TabsState {
  tabs: Tab[];
  activeId: string;
  /** Tab waiting on the "save changes?" prompt. */
  pendingCloseId: string | null;
  /** Tab whose request is being saved through the Save dialog. */
  saveDialog: { tabId: string; closeAfter: boolean } | null;

  newTab: () => string;
  /** Opens a saved request, or focuses its tab if it's already open. */
  openSaved: (request: Request, collectionId: string, workspaceId?: string) => string;
  /** Opens a history entry as a new unsaved tab with its response attached. */
  openFromHistory: (request: Request, result: SendResult) => string;
  activate: (id: string) => void;
  /** Closes without asking. Always leaves at least one tab open. */
  close: (id: string) => void;
  /** Closes, or asks first when the tab has unsaved changes. */
  requestClose: (id: string) => void;
  cancelClose: () => void;
  move: (fromId: string, toId: string) => void;
  updateRequest: (id: string, update: (req: Request) => Request) => void;
  markSaved: (id: string, saved: Request, collectionId?: string, workspaceId?: string) => void;
  /** Detaches a tab from its file: it stays open as an unsaved request. */
  detach: (id: string) => void;
  /**
   * Applies the version of the request found on disk. A clean tab shows it;
   * a tab with edits keeps them and only updates what it compares against.
   */
  applyDiskVersion: (id: string, disk: Request, collectionId: string) => void;
  /** Applies a rename done from the sidebar to the tab and its saved copy. */
  renameSaved: (id: string, name: string) => void;
  setSending: (id: string, sendId: string | null) => void;
  setResult: (id: string, result: SendResult | null) => void;
  openSaveDialog: (tabId: string, closeAfter?: boolean) => void;
  closeSaveDialog: () => void;
}

let counter = 0;
export function newTabId(): string {
  counter += 1;
  return `tab-${Date.now().toString(36)}-${counter}`;
}

function makeTab(partial: Partial<Tab> = {}): Tab {
  return {
    id: newTabId(),
    request: emptyRequest(),
    saved: null,
    collectionId: "",
    workspaceId: "",
    sendId: null,
    result: null,
    ...partial,
  };
}

export function isDirty(tab: Tab): boolean {
  return !requestsEqual(tab.request, tab.saved ?? emptyRequest());
}

export function tabTitle(tab: Tab): string {
  return tab.request.name || "Untitled request";
}

/** localStorage that never throws (private windows, blocked storage). */
const safeStorage: StateStorage = {
  getItem: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
  removeItem: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

const first = makeTab();

export const useTabsStore = create<TabsState>()(
  persist(
    (set, get) => ({
      tabs: [first],
      activeId: first.id,
      pendingCloseId: null,
      saveDialog: null,

      newTab: () => {
        const tab = makeTab();
        set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
        return tab.id;
      },

      openSaved: (request, collectionId, workspaceId = "") => {
        const existing = get().tabs.find((t) => t.saved?.id === request.id && request.id !== "");
        if (existing) {
          set({ activeId: existing.id });
          return existing.id;
        }
        const req = normalizeRequest(request);
        const tab = makeTab({ request: req, saved: req, collectionId, workspaceId });
        set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
        return tab.id;
      },

      openFromHistory: (request, result) => {
        // A history entry is a snapshot: open it detached from any saved file.
        const req = { ...normalizeRequest(request), id: "", seq: 0 };
        const tab = makeTab({ request: req, result });
        set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
        return tab.id;
      },

      activate: (id) => {
        if (get().tabs.some((t) => t.id === id)) set({ activeId: id });
      },

      close: (id) =>
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          if (idx < 0) return {};
          const rest = s.tabs.filter((t) => t.id !== id);
          const tabs = rest.length ? rest : [makeTab()];
          let activeId = s.activeId;
          if (s.activeId === id) activeId = (tabs[Math.min(idx, tabs.length - 1)] ?? tabs[0]).id;
          return {
            tabs,
            activeId,
            pendingCloseId: s.pendingCloseId === id ? null : s.pendingCloseId,
          };
        }),

      requestClose: (id) => {
        const tab = get().tabs.find((t) => t.id === id);
        if (!tab) return;
        if (isDirty(tab)) set({ pendingCloseId: id, activeId: id });
        else get().close(id);
      },

      cancelClose: () => set({ pendingCloseId: null }),

      move: (fromId, toId) =>
        set((s) => {
          const from = s.tabs.findIndex((t) => t.id === fromId);
          const to = s.tabs.findIndex((t) => t.id === toId);
          if (from < 0 || to < 0 || from === to) return {};
          const tabs = [...s.tabs];
          const [tab] = tabs.splice(from, 1);
          tabs.splice(to, 0, tab);
          return { tabs };
        }),

      updateRequest: (id, update) =>
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, request: update(t.request) } : t)) })),

      markSaved: (id, saved, collectionId, workspaceId) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === id
              ? {
                  ...t,
                  request: saved,
                  saved,
                  collectionId: collectionId ?? t.collectionId,
                  workspaceId: workspaceId ?? t.workspaceId,
                }
              : t,
          ),
        })),

      detach: (id) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === id
              ? {
                  ...t,
                  request: { ...t.request, id: "", seq: 0 },
                  saved: null,
                  collectionId: "",
                  workspaceId: "",
                }
              : t,
          ),
        })),

      applyDiskVersion: (id, disk, collectionId) =>
        set((s) => ({
          tabs: s.tabs.map((t) => {
            if (t.id !== id) return t;
            const req = normalizeRequest(disk);
            return isDirty(t)
              ? { ...t, saved: req, collectionId }
              : { ...t, request: req, saved: req, collectionId };
          }),
        })),

      renameSaved: (id, name) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === id && t.saved
              ? { ...t, request: { ...t.request, name }, saved: { ...t.saved, name } }
              : t,
          ),
        })),

      setSending: (id, sendId) =>
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, sendId } : t)) })),

      setResult: (id, result) =>
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, result, sendId: null } : t)) })),

      openSaveDialog: (tabId, closeAfter = false) => set({ saveDialog: { tabId, closeAfter } }),
      closeSaveDialog: () => set({ saveDialog: null }),
    }),
    {
      name: "pakpos-tabs",
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      // Convenience only: keep the open tabs and drafts, not responses or sends.
      partialize: (s) => ({
        activeId: s.activeId,
        tabs: s.tabs.map((t) => ({ ...t, sendId: null, result: null })),
      }),
      merge: (persisted, current) => {
        const p = persisted as Partial<Pick<TabsState, "tabs" | "activeId">> | undefined;
        if (!p?.tabs?.length) return current;
        const tabs = p.tabs.map((t) =>
          makeTab({
            ...t,
            request: normalizeRequest(t.request),
            saved: t.saved ? normalizeRequest(t.saved) : null,
            sendId: null,
            result: null,
          }),
        );
        const activeIdx = p.tabs.findIndex((t) => t.id === p.activeId);
        return { ...current, tabs, activeId: tabs[Math.max(activeIdx, 0)].id };
      },
    },
  ),
);

export function useActiveTab(): Tab {
  return useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId) ?? s.tabs[0]);
}
