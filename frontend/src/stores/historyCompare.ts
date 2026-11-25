import { create } from "zustand";
import type { HistorySummary } from "@/lib/model";

interface HistoryCompareState {
  /** The entry picked first; the history list waits for the second while set. */
  base: HistorySummary | null;
  /** The two entries the compare dialog shows: a was sent first. */
  pair: { a: HistorySummary; b: HistorySummary } | null;

  start: (item: HistorySummary) => void;
  cancel: () => void;
  /** Picks the second entry and opens the dialog (picking the first again cancels). */
  pick: (item: HistorySummary) => void;
  /** Opens the dialog for two entries directly. */
  compare: (x: HistorySummary, y: HistorySummary) => void;
  close: () => void;
}

export const historyCompareInitial = { base: null, pair: null };

function ordered(x: HistorySummary, y: HistorySummary) {
  return x.createdAt < y.createdAt || (x.createdAt === y.createdAt && x.id < y.id)
    ? { a: x, b: y }
    : { a: y, b: x };
}

export const useHistoryCompareStore = create<HistoryCompareState>()((set, get) => ({
  ...historyCompareInitial,
  start: (item) => set({ base: item }),
  cancel: () => set({ base: null }),
  pick: (item) => {
    const base = get().base;
    if (!base || base.id === item.id) {
      set({ base: null });
      return;
    }
    set({ base: null, pair: ordered(base, item) });
  },
  compare: (x, y) => set({ base: null, pair: ordered(x, y) }),
  close: () => set({ pair: null }),
}));
