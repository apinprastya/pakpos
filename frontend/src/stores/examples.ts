import { create } from "zustand";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import type { Example, ExampleSummary } from "@/lib/model";
import { useSecretsStore } from "@/stores/secrets";
import { useTabsStore } from "@/stores/tabs";
import { useWorkspaceStore } from "@/stores/workspace";

/**
 * Saved response examples of the open workspace, cached per request, plus
 * the example each tab is showing in its response pane (instead of its
 * last response, which stays in the tab).
 *
 * `load` runs when a workspace opens, after every tree reload (which follows
 * `workspace:changed` and the app's own writes, see `useExamplesSync`) and
 * after this store's own writes.
 */
interface ExamplesState {
  /** Workspace the cache belongs to (null when none is open). */
  workspaceId: string | null;
  /** Examples by request id, in saved order. */
  byRequest: Record<string, ExampleSummary[]>;
  /** The example a tab shows, by tab id. */
  viewing: Record<string, Example>;

  load: () => Promise<void>;
  /** Shows an example read-only in a tab's response pane. */
  show: (tabId: string, requestId: string, exampleId: string) => Promise<boolean>;
  /** Goes back to the tab's last response. */
  hide: (tabId: string) => void;
  /**
   * Saves the tab's last response as an example of its saved request. When
   * it holds the value of a secret nothing is saved and the result names the
   * secrets; saving again with `replaceSecrets` writes `{{name}}` instead.
   * A locked secret store is unlocked first (the check needs the values).
   */
  save: (tabId: string, name: string, replaceSecrets?: boolean) => Promise<SaveOutcome>;
  rename: (requestId: string, id: string, name: string) => Promise<void>;
  remove: (requestId: string, id: string) => Promise<void>;
}

/** What `save` did: saved, refused because of secret values (their names), or failed/cancelled. */
export type SaveOutcome = { status: "saved" } | { status: "secrets"; names: string[] } | { status: "failed" };

function group(list: ExampleSummary[]): Record<string, ExampleSummary[]> {
  const out: Record<string, ExampleSummary[]> = {};
  for (const e of list) (out[e.requestId] ??= []).push(e);
  return out;
}

let loadSeq = 0;

export const useExamplesStore = create<ExamplesState>()((set, get) => ({
  workspaceId: null,
  byRequest: {},
  viewing: {},

  load: async () => {
    const ws = useWorkspaceStore.getState().workspace;
    const seq = ++loadSeq;
    if (!ws) {
      set({ workspaceId: null, byRequest: {}, viewing: {} });
      return;
    }
    try {
      const list = await api.listAllExamples();
      if (seq !== loadSeq) return;
      const byRequest = group(list);
      const ids = new Set(list.map((e) => e.id));
      // Drop views of examples that are gone (deleted, or another workspace).
      const viewing = Object.fromEntries(Object.entries(get().viewing).filter(([, ex]) => ids.has(ex.id)));
      set({ workspaceId: ws.id, byRequest, viewing });
    } catch {
      // Keep what we have; the next tree reload retries.
    }
  },

  show: async (tabId, requestId, exampleId) => {
    try {
      const ex = await api.getExample(requestId, exampleId);
      set((s) => ({ viewing: { ...s.viewing, [tabId]: ex } }));
      return true;
    } catch (e) {
      toast.error("Couldn't open the example", { description: errorMessage(e) });
      return false;
    }
  },

  hide: (tabId) => {
    if (!get().viewing[tabId]) return;
    set((s) => {
      const viewing = { ...s.viewing };
      delete viewing[tabId];
      return { viewing };
    });
  },

  save: async (tabId, name, replaceSecrets = false) => {
    const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
    const requestId = tab?.saved?.id ?? "";
    const historyId = tab?.result?.historyId ?? 0;
    if (!requestId || !historyId) return { status: "failed" };
    try {
      let res = await api.saveExample(requestId, name, historyId, replaceSecrets);
      if (res.secretsLocked) {
        // The check for secret values needs them: unlock first, never skip it.
        if (!(await useSecretsStore.getState().ensureReady())) {
          toast.info("The example wasn't saved", {
            description: "Unlock the secrets so the response can be checked for secret values.",
          });
          return { status: "failed" };
        }
        res = await api.saveExample(requestId, name, historyId, replaceSecrets);
        if (res.secretsLocked) throw new Error("The secrets are still locked. Unlock them and try again.");
      }
      if (!res.example) return { status: "secrets", names: res.secretsFound };
      toast.success("Example saved", { description: res.example.name });
      await get().load();
      return { status: "saved" };
    } catch (e) {
      toast.error("Couldn't save the example", { description: errorMessage(e) });
      return { status: "failed" };
    }
  },

  rename: async (requestId, id, name) => {
    const trimmed = name.trim();
    const current = get().byRequest[requestId]?.find((e) => e.id === id);
    if (!trimmed || !current || current.name === trimmed) return;
    try {
      await api.renameExample(requestId, id, trimmed);
      set((s) => ({
        viewing: Object.fromEntries(
          Object.entries(s.viewing).map(([tab, ex]) => [tab, ex.id === id ? { ...ex, name: trimmed } : ex]),
        ),
      }));
    } catch (e) {
      toast.error("Couldn't rename the example", { description: errorMessage(e) });
    }
    await get().load();
  },

  remove: async (requestId, id) => {
    try {
      await api.deleteExample(requestId, id);
      toast.success("Example deleted");
    } catch (e) {
      toast.error("Couldn't delete the example", { description: errorMessage(e) });
    }
    await get().load();
  },
}));

/** The examples of a request (empty when it has none). */
export function useRequestExamples(requestId: string): ExampleSummary[] {
  return useExamplesStore((s) => s.byRequest[requestId] ?? NONE);
}
const NONE: ExampleSummary[] = [];
