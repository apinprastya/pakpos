import { create } from "zustand";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import type { Environment, Globals } from "@/lib/model";
import { useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";

export type EnvironmentsStatus = "idle" | "loading" | "ready" | "error";

/**
 * Environments, globals and the selected environment of the open workspace.
 * Go is the source of truth: the selection is stored per workspace in SQLite.
 * Secret variables never carry a value here (Go sends them empty).
 *
 * `load` runs when a workspace opens, on `workspace:changed` (external edits to
 * `environments/`) and after the store's own writes, which don't fire the event.
 */
interface EnvironmentsState {
  status: EnvironmentsStatus;
  error: string | null;
  /** Workspace the lists belong to (null when none is open). */
  workspaceId: string | null;
  environments: Environment[];
  globals: Globals | null;
  /** Selected environment id, "" for none. */
  selectedId: string;
  /** Environment that should start in rename mode (just created). */
  renameTarget: string | null;
  /**
   * Bumped whenever variables or inherited settings may have changed (a
   * reload, or a collection or folder saved), so previews re-resolve.
   */
  version: number;

  load: () => Promise<void>;
  /** Clears everything (no workspace open). */
  clear: () => void;
  select: (id: string) => Promise<void>;
  create: (name?: string) => Promise<Environment | null>;
  rename: (id: string, name: string) => Promise<void>;
  duplicate: (id: string) => Promise<Environment | null>;
  remove: (id: string) => Promise<void>;
  /** Moves an environment to a new position (optimistic, then reloads). */
  reorder: (ids: string[]) => Promise<void>;
  setRenameTarget: (id: string | null) => void;
  /** Marks variables or inherited settings as changed (see `version`). */
  touch: () => void;
  /** Opens the environment's editor tab. */
  open: (id: string) => void;
  openGlobals: () => void;
}

function fail(title: string, e: unknown) {
  toast.error(title, { description: errorMessage(e) });
}

function workspaceId(): string {
  return useWorkspaceStore.getState().workspace?.id ?? "";
}

/** Closes the editor tab of an environment deleted in the app (its edits are gone with it). */
function closeEnvironmentTab(id: string) {
  const tab = useTabsStore
    .getState()
    .tabs.find((t) => t.doc?.kind === "environment" && t.doc.targetId === id);
  if (tab) useTabsStore.getState().close(tab.id);
}

let loadSeq = 0;

export const useEnvironmentsStore = create<EnvironmentsState>()((set, get) => ({
  status: "idle",
  error: null,
  workspaceId: null,
  environments: [],
  globals: null,
  selectedId: "",
  renameTarget: null,
  version: 0,

  load: async () => {
    const ws = useWorkspaceStore.getState().workspace;
    if (!ws) {
      get().clear();
      return;
    }
    const seq = ++loadSeq;
    // Keep showing the current lists while reloading the same workspace.
    if (get().workspaceId !== ws.id) {
      set({
        status: "loading",
        error: null,
        workspaceId: ws.id,
        environments: [],
        globals: null,
        selectedId: "",
      });
    }
    try {
      const [environments, globals, selected] = await Promise.all([
        api.listEnvironments(),
        api.getGlobals(),
        api.selectedEnvironment(),
      ]);
      if (seq !== loadSeq) return;
      set((s) => ({
        status: "ready",
        error: null,
        workspaceId: ws.id,
        environments,
        globals,
        selectedId: selected?.id ?? "",
        version: s.version + 1,
      }));
    } catch (e) {
      if (seq !== loadSeq) return;
      set({ status: "error", error: errorMessage(e), workspaceId: ws.id });
    }
  },

  clear: () => {
    loadSeq++;
    set({ status: "idle", error: null, workspaceId: null, environments: [], globals: null, selectedId: "" });
  },

  select: async (id) => {
    const previous = get().selectedId;
    if (previous === id) return;
    set((s) => ({ selectedId: id, version: s.version + 1 }));
    try {
      await api.selectEnvironment(id);
    } catch (e) {
      set({ selectedId: previous });
      fail("Couldn't switch the environment", e);
    }
  },

  create: async (name = "New environment") => {
    try {
      const env = await api.createEnvironment(name);
      await get().load();
      set({ renameTarget: env.id });
      return env;
    } catch (e) {
      fail("Couldn't create the environment", e);
      return null;
    }
  },

  rename: async (id, name) => {
    const trimmed = name.trim();
    const current = get().environments.find((e) => e.id === id);
    if (!trimmed || !current || current.name === trimmed) return;
    try {
      await api.renameEnvironment(id, trimmed);
    } catch (e) {
      fail("Couldn't rename the environment", e);
    }
    await get().load();
  },

  duplicate: async (id) => {
    try {
      const copy = await api.duplicateEnvironment(id);
      await get().load();
      set({ renameTarget: copy.id });
      return copy;
    } catch (e) {
      fail("Couldn't duplicate the environment", e);
      return null;
    }
  },

  remove: async (id) => {
    try {
      await api.deleteEnvironment(id);
    } catch (e) {
      fail("Couldn't delete the environment", e);
      return;
    }
    closeEnvironmentTab(id);
    await get().load();
    toast.success("Environment deleted");
  },

  reorder: async (ids) => {
    const byId = new Map(get().environments.map((e) => [e.id, e]));
    set({ environments: ids.map((id) => byId.get(id)).filter((e): e is Environment => !!e) });
    try {
      await api.reorderEnvironments(ids);
    } catch (e) {
      fail("Couldn't reorder environments", e);
    }
    await get().load();
  },

  setRenameTarget: (id) => set({ renameTarget: id }),
  touch: () => set((s) => ({ version: s.version + 1 })),

  open: (id) => {
    const env = get().environments.find((e) => e.id === id);
    if (!env) return;
    useTabsStore.getState().openDoc("environment", id, env.name, workspaceId());
  },

  openGlobals: () => {
    useTabsStore.getState().openDoc("globals", "", "Globals", workspaceId());
  },
}));

/** The selected environment, or null for none. */
export function useSelectedEnvironment(): Environment | null {
  return useEnvironmentsStore((s) => s.environments.find((e) => e.id === s.selectedId) ?? null);
}

/** Moves one id up or down by one place; returns null when it can't move. */
export function shiftId(ids: string[], id: string, delta: -1 | 1): string[] | null {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** Moves `activeId` to where `overId` is (drag and drop). */
export function moveId(ids: string[], activeId: string, overId: string): string[] | null {
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, activeId);
  return next;
}
