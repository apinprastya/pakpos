import { create } from "zustand";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { historyToResult, type HistorySummary } from "@/lib/model";
import { useTabsStore } from "@/stores/tabs";

export const HISTORY_PAGE_SIZE = 50;

interface HistoryState {
  items: HistorySummary[];
  total: number;
  query: string;
  loading: boolean;
  /** True once the history view has loaded at least once. */
  loaded: boolean;

  /** Loads the first page for `query` (defaults to the current query). */
  load: (query?: string) => Promise<void>;
  loadMore: () => Promise<void>;
  /** Reloads the first page if the list has been shown before (e.g. after a send). */
  refresh: () => Promise<void>;
  open: (id: number) => Promise<void>;
  remove: (id: number) => Promise<void>;
  clear: () => Promise<void>;
}

let generation = 0;

export const useHistoryStore = create<HistoryState>()((set, get) => ({
  items: [],
  total: 0,
  query: "",
  loading: false,
  loaded: false,

  load: async (query = get().query) => {
    const gen = ++generation;
    set({ query, loading: true });
    try {
      const page = await api.historyList({
        text: query,
        workspaceId: "",
        offset: 0,
        limit: HISTORY_PAGE_SIZE,
      });
      if (gen !== generation) return;
      set({ items: page.items, total: page.total, loaded: true });
    } catch (e) {
      if (gen === generation) toast.error("Couldn't load history", { description: errorMessage(e) });
    } finally {
      if (gen === generation) set({ loading: false });
    }
  },

  loadMore: async () => {
    const { items, total, query, loading } = get();
    if (loading || items.length >= total) return;
    const gen = ++generation;
    set({ loading: true });
    try {
      const page = await api.historyList({
        text: query,
        workspaceId: "",
        offset: items.length,
        limit: HISTORY_PAGE_SIZE,
      });
      if (gen !== generation) return;
      const seen = new Set(items.map((i) => i.id));
      set({ items: [...items, ...page.items.filter((i) => !seen.has(i.id))], total: page.total });
    } catch (e) {
      if (gen === generation) toast.error("Couldn't load more history", { description: errorMessage(e) });
    } finally {
      if (gen === generation) set({ loading: false });
    }
  },

  refresh: async () => {
    if (get().loaded) await get().load();
  },

  open: async (id) => {
    try {
      const entry = await api.historyGet(id);
      useTabsStore.getState().openFromHistory(entry.request, historyToResult(entry));
    } catch (e) {
      toast.error("Couldn't open the history entry", { description: errorMessage(e) });
    }
  },

  remove: async (id) => {
    try {
      await api.historyDelete(id);
      set((s) => ({ items: s.items.filter((i) => i.id !== id), total: Math.max(0, s.total - 1) }));
    } catch (e) {
      toast.error("Couldn't delete the history entry", { description: errorMessage(e) });
    }
  },

  clear: async () => {
    try {
      await api.historyClear();
      set({ items: [], total: 0 });
      toast.success("History cleared");
    } catch (e) {
      toast.error("Couldn't clear history", { description: errorMessage(e) });
    }
  },
}));
