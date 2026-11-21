import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import {
  emptyAuth,
  emptyRequest,
  emptyScripts,
  normalizeRequest,
  normalizeScripts,
  requestsEqual,
  type Auth,
  type KeyValue,
  type Request,
  type Scripts,
  type SendResult,
  type Variable,
} from "@/lib/model";
import { toolDef } from "@/features/tools/registry";
import { normalizeWebhook, webhooksEqual, type Webhook } from "@/lib/webhookModel";

/** What a non-request tab edits (or, for `runner`, runs). */
export type DocKind = "environment" | "globals" | "collection" | "folder" | "runner" | "webhook";

/** A webhook tab's definition as edited and as saved (null until loaded from Go). */
export interface WebhookDoc {
  draft: Webhook | null;
  saved: Webhook | null;
}

/**
 * A runner tab's configuration, kept with the tab (results are not: past runs
 * are reloaded from Go). Requests are selected by default, so `excludedIds`
 * lists the unchecked ones and new requests join the run.
 */
export interface RunnerSettings {
  targetKind: "collection" | "folder";
  excludedIds: string[];
  /** null: the environment selected when the run starts; "": none. */
  environmentId: string | null;
  /** 0 with a data file: one per row. */
  iterations: number;
  delayMs: number;
  /** Path of the data file ("" for none). */
  dataFile: string;
  stopOnFailure: boolean;
  keepVariables: boolean;
  saveResponses: boolean;
  recordHistory: boolean;
}

export function defaultRunnerSettings(targetKind: RunnerSettings["targetKind"]): RunnerSettings {
  return {
    targetKind,
    excludedIds: [],
    environmentId: null,
    iterations: 1,
    delayMs: 0,
    dataFile: "",
    stopOnFailure: false,
    keepVariables: true,
    saveResponses: false,
    recordHistory: false,
  };
}

/**
 * The editable part of an environment, the globals, or a collection's or
 * folder's settings. Environments and globals use only `variables`; folders
 * have no `variables`; only collections and folders have `scripts`. Secret
 * variables never carry a value here.
 */
export interface DocDraft {
  auth: Auth;
  headers: KeyValue[];
  variables: Variable[];
  scripts: Scripts;
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
  /** Set for runner tabs (whose draft stays null). */
  runner?: RunnerSettings;
  /** Set for webhook tabs (whose draft stays null). */
  webhook?: WebhookDoc;
}

export function emptyDocDraft(): DocDraft {
  return { auth: emptyAuth(), headers: [], variables: [], scripts: emptyScripts() };
}

/** Drops the editor's blank rows so they don't count as changes. */
export function compactDraft(d: DocDraft): DocDraft {
  return {
    auth: d.auth,
    headers: d.headers.filter((h) => h.key !== "" || h.value !== ""),
    variables: d.variables
      .filter((v) => v.key !== "" || v.value !== "")
      .map(({ key, value, enabled, secret }) => ({ key, value, enabled, secret })),
    scripts: normalizeScripts(d.scripts),
  };
}

/** True when the draft's scripts differ from the saved ones (only then are they sent on save). */
export function scriptsChanged(draft: DocDraft, saved: DocDraft | null): boolean {
  const a = normalizeScripts(draft.scripts);
  const b = normalizeScripts(saved?.scripts);
  return a.preRequest !== b.preRequest || a.test !== b.test;
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
  /**
   * Set for tool tabs (JWT decoder, …); null otherwise. A tool tab has no
   * workspace or parent: it survives a workspace switch and is never dirty.
   */
  tool: ToolTab | null;
  /** Section open in each pane (e.g. the request's Body), so it survives switching tabs. */
  sections: TabSections;
}

/** A tool tab's tool (an id from the tools registry) and that tool's own state. */
export interface ToolTab {
  id: string;
  state: unknown;
}

/** True for request tabs: neither a doc (settings, runner) nor a tool tab. */
export function isRequestTab(tab: Tab): boolean {
  return !tab.doc && !tab.tool;
}

/** Panes whose section tabs are remembered per tab. */
export type TabPane = "request" | "response" | "settings" | "scripts" | "runner" | "webhook";
export type TabSections = Partial<Record<TabPane, string>>;

const TAB_PANES: TabPane[] = ["request", "response", "settings", "scripts", "runner", "webhook"];

/** Keeps only string sections of known panes (persisted data may be anything). */
export function restoreSections(raw: unknown): TabSections {
  const out: TabSections = {};
  if (!raw || typeof raw !== "object") return out;
  for (const pane of TAB_PANES) {
    const v = (raw as Record<string, unknown>)[pane];
    if (typeof v === "string" && v) out[pane] = v;
  }
  return out;
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
  /** Opens an unsaved request (e.g. imported from cURL) in a new tab; `parentId` is the collection or folder it inherits from. */
  openDraft: (request: Request, parentId?: string) => string;
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
  /** Opens the runner tab of a collection or folder, or focuses the open one. */
  openRunner: (
    kind: RunnerSettings["targetKind"],
    targetId: string,
    name: string,
    workspaceId: string,
  ) => string;
  /** Changes a runner tab's configuration. */
  updateRunner: (id: string, patch: Partial<RunnerSettings>) => void;
  /** Opens a webhook's tab, or focuses the open one. */
  openWebhook: (webhookId: string, name: string, workspaceId: string) => string;
  /** Edits a loaded webhook tab's draft. */
  updateWebhook: (id: string, update: (draft: Webhook) => Webhook) => void;
  /** Sets what was loaded or saved: the draft and its saved copy both become `saved`. */
  markWebhookSaved: (id: string, saved: Webhook) => void;
  /** A version read from disk: a clean tab shows it, an edited one keeps its edits. */
  applyWebhookDisk: (id: string, disk: Webhook) => void;
  /**
   * Opens a tool's tab, or focuses the open one (one tab per tool). With
   * `input` (e.g. "Decode JWT" from a request), the tab's input is replaced.
   * Returns the tab id, or "" for an unknown tool.
   */
  openTool: (toolId: string, input?: string) => string;
  /** Changes a tool tab's state. */
  updateToolState: (id: string, update: (state: unknown) => unknown) => void;
  /** Remembers which section of a pane is open in a tab. */
  setSection: (id: string, pane: TabPane, section: string) => void;
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
    tool: null,
    sections: {},
    ...partial,
  };
}

export function isDirty(tab: Tab): boolean {
  if (tab.tool) return false;
  if (tab.doc?.webhook) {
    const { draft, saved } = tab.doc.webhook;
    return draft !== null && saved !== null && !webhooksEqual(draft, saved);
  }
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
  runner: (name) => `Run ${name || "collection"}`,
  webhook: (name) => name || "Webhook",
};

export function tabTitle(tab: Tab): string {
  if (tab.tool) return toolDef(tab.tool.id)?.label ?? "Unknown tool";
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

      openDraft: (request, parentId = "") => {
        const req = { ...normalizeRequest(request), id: "", seq: 0 };
        const tab = makeTab({ request: req, parentId });
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

      openRunner: (kind, targetId, name, workspaceId) => {
        const id = get().openDoc("runner", targetId, name, workspaceId);
        set((s) => ({
          tabs: mapDoc(s.tabs, id, (d) => (d.runner ? d : { ...d, runner: defaultRunnerSettings(kind) })),
        }));
        return id;
      },

      openWebhook: (webhookId, name, workspaceId) => {
        const id = get().openDoc("webhook", webhookId, name, workspaceId);
        set((s) => ({
          tabs: mapDoc(s.tabs, id, (d) => (d.webhook ? d : { ...d, webhook: { draft: null, saved: null } })),
        }));
        return id;
      },

      updateWebhook: (id, update) =>
        set((s) => ({
          tabs: mapDoc(s.tabs, id, (d) =>
            d.webhook?.draft ? { ...d, webhook: { ...d.webhook, draft: update(d.webhook.draft) } } : d,
          ),
        })),

      markWebhookSaved: (id, saved) =>
        set((s) => ({
          tabs: mapDoc(s.tabs, id, (d) => ({
            ...d,
            name: saved.name,
            missing: false,
            webhook: { draft: saved, saved },
          })),
        })),

      applyWebhookDisk: (id, disk) =>
        set((s) => ({
          tabs: s.tabs.map((t) => {
            if (t.id !== id || !t.doc?.webhook) return t;
            const webhook = isDirty(t) ? { ...t.doc.webhook, saved: disk } : { draft: disk, saved: disk };
            return { ...t, doc: { ...t.doc, webhook } };
          }),
        })),

      updateRunner: (id, patch) =>
        set((s) => ({
          tabs: mapDoc(s.tabs, id, (d) => (d.runner ? { ...d, runner: { ...d.runner, ...patch } } : d)),
        })),

      openTool: (toolId, input) => {
        const def = toolDef(toolId);
        if (!def) return "";
        const existing = get().tabs.find((t) => t.tool?.id === toolId);
        if (existing) {
          set((s) => ({
            activeId: existing.id,
            tabs:
              input === undefined
                ? s.tabs
                : s.tabs.map((t) =>
                    t.id === existing.id && t.tool
                      ? { ...t, tool: { ...t.tool, state: def.withInput(t.tool.state, input) } }
                      : t,
                  ),
          }));
          return existing.id;
        }
        const tab = makeTab({ tool: { id: toolId, state: def.initialState(input) } });
        set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
        return tab.id;
      },

      updateToolState: (id, update) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === id && t.tool ? { ...t, tool: { ...t.tool, state: update(t.tool.state) } } : t,
          ),
        })),

      setSection: (id, pane, section) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === id && t.sections[pane] !== section
              ? { ...t, sections: { ...t.sections, [pane]: section } }
              : t,
          ),
        })),
    }),
    {
      name: "pakpos-tabs",
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      // Convenience only: keep the open tabs and drafts, not responses or sends.
      // A tool's state is kept only when the tool says so (never a JWT's token).
      partialize: (s) => ({
        activeId: s.activeId,
        tabs: s.tabs.map((t) => ({ ...t, sendId: null, result: null, tool: persistedTool(t.tool) })),
      }),
      merge: (persisted, current) => {
        // Tabs saved before nested folders have `collectionId` instead of `parentId`;
        // tabs saved before M4 have no `doc` (they're all request tabs).
        type StoredTab = Omit<Tab, "parentId" | "doc" | "sections" | "tool"> & {
          sections?: unknown;
          tool?: unknown;
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
            ...restoreKind(t.doc, t.tool),
            sections: restoreSections(t.sections),
          }),
        );
        const activeIdx = p.tabs.findIndex((t) => t.id === p.activeId);
        return { ...current, tabs, activeId: tabs[Math.max(activeIdx, 0)].id };
      },
    },
  ),
);

/**
 * The open section of a tab's pane, and a setter that remembers it. Falls back
 * to `fallback` when nothing (or a section the pane doesn't have) is stored.
 */
export function useTabSection<T extends string>(
  tab: Tab,
  pane: TabPane,
  sections: readonly T[],
  fallback: T,
): [T, (section: string) => void] {
  const stored = tab.sections[pane];
  const value = sections.find((s) => s === stored) ?? fallback;
  const setSection = useTabsStore((s) => s.setSection);
  return [value, (section) => setSection(tab.id, pane, section)];
}

export function useActiveTab(): Tab {
  return useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId) ?? s.tabs[0]);
}

function persistedTool(tool: ToolTab | null): ToolTab | null {
  if (!tool) return null;
  const def = toolDef(tool.id);
  if (!def?.persist) return { id: tool.id, state: null };
  return def.serialize ? { id: tool.id, state: def.serialize(tool.state) } : tool;
}

/**
 * Restores a persisted tool tab. Its state comes back only for tools that
 * persist; others start empty. An unknown tool (from another build) keeps
 * its id so its tab can say so and be closed.
 */
export function restoreTool(raw: unknown): ToolTab | null {
  if (!raw || typeof raw !== "object") return null;
  const { id, state } = raw as { id?: unknown; state?: unknown };
  if (typeof id !== "string" || !id) return null;
  const def = toolDef(id);
  if (!def) return { id, state: null };
  return { id, state: def.persist ? def.restore(state) : def.initialState() };
}

/** A tab is a tool tab, a doc tab, or (anything else) a request tab. */
function restoreKind(doc: Partial<DocState> | null | undefined, tool: unknown) {
  const t = restoreTool(tool);
  return t ? { doc: null, tool: t } : { doc: restoreDoc(doc), tool: null };
}

const DOC_KINDS: DocKind[] = ["environment", "globals", "collection", "folder", "runner", "webhook"];

function restoreRunner(raw: unknown): RunnerSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<RunnerSettings>;
  const d = defaultRunnerSettings(r.targetKind === "folder" ? "folder" : "collection");
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  return {
    ...d,
    excludedIds: Array.isArray(r.excludedIds) ? r.excludedIds.filter((x) => typeof x === "string") : [],
    environmentId: typeof r.environmentId === "string" ? r.environmentId : null,
    iterations: num(r.iterations, d.iterations),
    delayMs: num(r.delayMs, d.delayMs),
    dataFile: typeof r.dataFile === "string" ? r.dataFile : "",
    stopOnFailure: bool(r.stopOnFailure, d.stopOnFailure),
    keepVariables: bool(r.keepVariables, d.keepVariables),
    saveResponses: bool(r.saveResponses, d.saveResponses),
    recordHistory: bool(r.recordHistory, d.recordHistory),
  };
}

function restoreDraft(d: Partial<DocDraft> | null | undefined): DocDraft | null {
  if (!d) return null;
  return {
    auth: { ...emptyAuth(), ...d.auth },
    headers: Array.isArray(d.headers) ? d.headers : [],
    variables: Array.isArray(d.variables) ? d.variables : [],
    // Tabs stored before scripts existed have none; saving sends scripts only when edited.
    scripts: normalizeScripts(d.scripts),
  };
}

/** Restores a persisted doc tab; anything unrecognised becomes a request tab. */
function restoreDoc(d: Partial<DocState> | null | undefined): DocState | null {
  if (!d || !d.kind || !DOC_KINDS.includes(d.kind)) return null;
  if (d.kind === "runner") {
    return {
      kind: "runner",
      targetId: d.targetId ?? "",
      name: d.name ?? "",
      draft: null,
      saved: null,
      missing: false,
      runner: restoreRunner(d.runner),
    };
  }
  if (d.kind === "webhook") {
    const w = (d.webhook ?? {}) as Partial<WebhookDoc>;
    // A draft without its saved copy can't be compared; reload both from disk.
    const both = !!w.draft && !!w.saved;
    return {
      kind: "webhook",
      targetId: d.targetId ?? "",
      name: d.name ?? "",
      draft: null,
      saved: null,
      missing: false,
      webhook: {
        draft: both ? normalizeWebhook(w.draft) : null,
        saved: both ? normalizeWebhook(w.saved) : null,
      },
    };
  }
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
