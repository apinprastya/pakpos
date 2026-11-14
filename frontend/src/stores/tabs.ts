import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import {
  emptyAuth,
  emptyRequest,
  normalizeRequest,
  requestsEqual,
  type Auth,
  type KeyValue,
  type Request,
  type SendResult,
  type Variable,
} from "@/lib/model";

/** What a non-request tab edits. */
export type DocKind = "environment" | "globals" | "collection" | "folder";

/**
 * The editable part of an environment, the globals, or a collection's or
 * folder's settings. Environments and globals use only `variables`; folders
 * have no `variables`. Secret variables never carry a value here.
 */
export interface DocDraft {
  auth: Auth;
  headers: KeyValue[];
  variables: Variable[];
}

/** State of an environment, globals, collection or folder settings tab. */
export interface DocState {
  kind: DocKind;
  /** Environment, collection or folder id ("" for the globals). */
  targetId: string;
  /** Name shown in the tab (kept in step with the sidebar). */
  name: string;
  /** Null until loaded from Go. */
  draft: DocDraft | null;
  saved: DocDraft | null;
  /** The target was deleted outside the app while the tab had edits. */
  missing: boolean;
}

export function emptyDocDraft(): DocDraft {
  return { auth: emptyAuth(), headers: [], variables: [] };
}

/** Drops the editor's blank rows so they don't count as changes. */
export function compactDraft(d: DocDraft): DocDraft {
  return {
    auth: d.auth,
    headers: d.headers.filter((h) => h.key !== "" || h.value !== ""),
    variables: d.variables
      .filter((v) => v.key !== "" || v.value !== "")
      .map(({ key, value, enabled, secret }) => ({ key, value, enabled, secret })),
  };
}

export function draftsEqual(a: DocDraft, b: DocDraft): boolean {
  return JSON.stringify(compactDraft(a)) === JSON.stringify(compactDraft(b));
}

export interface Tab {
  id: string;
  /** The request as currently edited. */
  request: Request;
  /** Last saved version; null when the request has never been saved. */
  saved: Request | null;
  /** Collection or folder a saved request lives in ("" when unsaved). */
  parentId: string;
  /** Workspace a saved request belongs to ("" when unknown or unsaved). */
  workspaceId: string;
  /** Running send, if any. */
  sendId: string | null;
  /** Last send result for this tab (not persisted). */
  result: SendResult | null;
  /**
   * Set for environment, globals, collection and folder settings tabs; null
   * for request tabs (whose request fields are then unused).
   */
  doc: DocState | null;
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
  openSaved: (request: Request, parentId: string, workspaceId?: string) => string;
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
  markSaved: (id: string, saved: Request, parentId?: string, workspaceId?: string) => void;
  /** Detaches a tab from its file: it stays open as an unsaved request. */
  detach: (id: string) => void;
  /**
   * Applies the version of the request found on disk. A clean tab shows it;
   * a tab with edits keeps them and only updates what it compares against.
   */
  applyDiskVersion: (id: string, disk: Request, parentId: string) => void;
  /** Applies a rename done from the sidebar to the tab and its saved copy. */
  renameSaved: (id: string, name: string) => void;
  setSending: (id: string, sendId: string | null) => void;
  setResult: (id: string, result: SendResult | null) => void;
  openSaveDialog: (tabId: string, closeAfter?: boolean) => void;
  closeSaveDialog: () => void;

  /** Opens an environment, globals, collection or folder settings tab, or focuses the open one. */
  openDoc: (kind: DocKind, targetId: string, name: string, workspaceId: string) => string;
  updateDoc: (id: string, update: (draft: DocDraft) => DocDraft) => void;
  /** Sets what was loaded or saved: the draft and its saved copy both become `saved`. */
  markDocSaved: (id: string, saved: DocDraft, name?: string) => void;
  /** Like applyDiskVersion: a clean tab shows the disk version, an edited one keeps its edits. */
  applyDocDisk: (id: string, disk: DocDraft) => void;
  /** Replaces only the saved copy (after an immediate change on disk, e.g. making a secret plain). */
  setDocSaved: (id: string, saved: DocDraft) => void;
  patchDoc: (id: string, patch: Partial<Pick<DocState, "name" | "missing">>) => void;
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
    parentId: "",
    workspaceId: "",
    sendId: null,
    result: null,
    doc: null,
    ...partial,
  };
}

export function isDirty(tab: Tab): boolean {
  if (tab.doc) {
    const { draft, saved } = tab.doc;
    return draft !== null && saved !== null && !draftsEqual(draft, saved);
  }
  return !requestsEqual(tab.request, tab.saved ?? emptyRequest());
}

const DOC_TITLES: Record<DocKind, (name: string) => string> = {
  environment: (name) => name || "Environment",
  globals: () => "Globals",
  collection: (name) => `${name || "Collection"} settings`,
  folder: (name) => `${name || "Folder"} settings`,
};

export function tabTitle(tab: Tab): string {
  if (tab.doc) return DOC_TITLES[tab.doc.kind](tab.doc.name);
  return tab.request.name || "Untitled request";
}

function mapDoc(tabs: Tab[], id: string, update: (doc: DocState) => DocState): Tab[] {
  return tabs.map((t) => (t.id === id && t.doc ? { ...t, doc: update(t.doc) } : t));
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

      openSaved: (request, parentId, workspaceId = "") => {
        const existing = get().tabs.find((t) => t.saved?.id === request.id && request.id !== "");
        if (existing) {
          set({ activeId: existing.id });
          return existing.id;
        }
        const req = normalizeRequest(request);
        const tab = makeTab({ request: req, saved: req, parentId, workspaceId });
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

      markSaved: (id, saved, parentId, workspaceId) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === id
              ? {
                  ...t,
                  request: saved,
                  saved,
                  parentId: parentId ?? t.parentId,
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
                  parentId: "",
                  workspaceId: "",
                }
              : t,
          ),
        })),

      applyDiskVersion: (id, disk, parentId) =>
        set((s) => ({
          tabs: s.tabs.map((t) => {
            if (t.id !== id) return t;
            const req = normalizeRequest(disk);
            return isDirty(t) ? { ...t, saved: req, parentId } : { ...t, request: req, saved: req, parentId };
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

      openDoc: (kind, targetId, name, workspaceId) => {
        const existing = get().tabs.find(
          (t) =>
            t.doc?.kind === kind &&
            t.doc.targetId === targetId &&
            (t.workspaceId === workspaceId || !workspaceId),
        );
        if (existing) {
          set({ activeId: existing.id });
          return existing.id;
        }
        const doc: DocState = { kind, targetId, name, draft: null, saved: null, missing: false };
        const tab = makeTab({ doc, workspaceId });
        set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
        return tab.id;
      },

      updateDoc: (id, update) =>
        set((s) => ({ tabs: mapDoc(s.tabs, id, (d) => (d.draft ? { ...d, draft: update(d.draft) } : d)) })),

      markDocSaved: (id, saved, name) =>
        set((s) => ({
          tabs: mapDoc(s.tabs, id, (d) => ({
            ...d,
            draft: saved,
            saved,
            name: name ?? d.name,
            missing: false,
          })),
        })),

      applyDocDisk: (id, disk) =>
        set((s) => ({
          tabs: s.tabs.map((t) => {
            if (t.id !== id || !t.doc) return t;
            return isDirty(t)
              ? { ...t, doc: { ...t.doc, saved: disk } }
              : { ...t, doc: { ...t.doc, draft: disk, saved: disk } };
          }),
        })),

      setDocSaved: (id, saved) => set((s) => ({ tabs: mapDoc(s.tabs, id, (d) => ({ ...d, saved })) })),

      patchDoc: (id, patch) => set((s) => ({ tabs: mapDoc(s.tabs, id, (d) => ({ ...d, ...patch })) })),
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
        // Tabs saved before nested folders have `collectionId` instead of `parentId`;
        // tabs saved before M4 have no `doc` (they're all request tabs).
        type StoredTab = Omit<Tab, "parentId" | "doc"> & {
          parentId?: string;
          collectionId?: string;
          doc?: Partial<DocState> | null;
        };
        const p = persisted as { tabs?: StoredTab[]; activeId?: string } | undefined;
        if (!p?.tabs?.length) return current;
        const tabs = p.tabs.map(({ collectionId, ...t }) =>
          makeTab({
            ...t,
            parentId: t.parentId ?? collectionId ?? "",
            request: normalizeRequest(t.request),
            saved: t.saved ? normalizeRequest(t.saved) : null,
            sendId: null,
            result: null,
            doc: restoreDoc(t.doc),
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

const DOC_KINDS: DocKind[] = ["environment", "globals", "collection", "folder"];

function restoreDraft(d: Partial<DocDraft> | null | undefined): DocDraft | null {
  if (!d) return null;
  return {
    auth: { ...emptyAuth(), ...d.auth },
    headers: Array.isArray(d.headers) ? d.headers : [],
    variables: Array.isArray(d.variables) ? d.variables : [],
  };
}

/** Restores a persisted doc tab; anything unrecognised becomes a request tab. */
function restoreDoc(d: Partial<DocState> | null | undefined): DocState | null {
  if (!d || !d.kind || !DOC_KINDS.includes(d.kind)) return null;
  const draft = restoreDraft(d.draft);
  const saved = restoreDraft(d.saved);
  return {
    kind: d.kind,
    targetId: d.targetId ?? "",
    name: d.name ?? "",
    // A draft without its saved copy can't be compared; reload both from disk.
    draft: saved ? draft : null,
    saved: draft ? saved : null,
    missing: false,
  };
}
