import { useCallback, useMemo } from "react";
import type { Layout } from "react-resizable-panels";
import { useUiStateStore } from "@/stores/uiState";

/** A stored layout: panel id → size in percent. Anything else is ignored. */
export function parseLayout(v: unknown): Layout | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Layout = {};
  for (const [id, size] of Object.entries(v)) {
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0 || size > 100) return undefined;
    out[id] = size;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Remembers a resizable panel group's layout. Spread the result on the
 * group: the saved layout is read when the group (id) mounts, and every
 * finished resize is saved.
 */
export function usePanelLayout(groupId: string): {
  defaultLayout: Layout | undefined;
  onLayoutChanged: (layout: Layout) => void;
} {
  const key = `panels.${groupId}`;
  // Read once per group: later changes come from the group itself.
  const defaultLayout = useMemo(() => parseLayout(useUiStateStore.getState().values[key]), [key]);
  const onLayoutChanged = useCallback(
    (layout: Layout) => {
      const rounded: Layout = {};
      for (const [id, size] of Object.entries(layout)) rounded[id] = Math.round(size * 100) / 100;
      useUiStateStore.getState().set(key, rounded);
    },
    [key],
  );
  return { defaultLayout, onLayoutChanged };
}
