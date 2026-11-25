import { create } from "zustand";

/** A tab's JSONPath filter on the response body. */
export interface JsonFilter {
  open: boolean;
  query: string;
}

interface JsonFilterState {
  /** By tab id; kept while the app runs (never persisted), so a resend keeps the filter. */
  byTab: Record<string, JsonFilter>;
  set: (tabId: string, patch: Partial<JsonFilter>) => void;
}

export const CLOSED_FILTER: JsonFilter = { open: false, query: "" };

export const jsonFilterInitial = { byTab: {} };

export const useJsonFilterStore = create<JsonFilterState>()((set) => ({
  ...jsonFilterInitial,
  set: (tabId, patch) =>
    set((s) => ({ byTab: { ...s.byTab, [tabId]: { ...(s.byTab[tabId] ?? CLOSED_FILTER), ...patch } } })),
}));
