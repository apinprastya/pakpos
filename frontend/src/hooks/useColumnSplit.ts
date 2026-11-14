import { useCallback, useMemo, type CSSProperties } from "react";
import { useUiStateStore } from "@/stores/uiState";

/** The narrowest share either side of a split may get. */
export const MIN_SPLIT = 0.15;
export const MAX_SPLIT = 1 - MIN_SPLIT;

/** Marks the two header cells a ColumnResizer measures. */
export const SPLIT_A = { "data-split": "a" } as const;
export const SPLIT_B = { "data-split": "b" } as const;

export function clampSplit(r: number): number {
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, Math.round(r * 1000) / 1000));
}

function parseSplit(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? clampSplit(v) : undefined;
}

export interface ColumnSplit {
  /** Share of the first resizable column (0..1); the second gets the rest. */
  ratio: number;
  setRatio: (ratio: number) => void;
  /** Back to the table's default. */
  reset: () => void;
  /** Sets --col-a/--col-b (fr units) for the table's grid template. */
  style: CSSProperties;
}

/**
 * The remembered width split between a table's two flexible columns
 * (e.g. key and value). Tables use `var(--col-a)`/`var(--col-b)` in their
 * grid template, so rows don't re-render while the split changes.
 */
export function useColumnSplit(table: string, defaultRatio: number): ColumnSplit {
  const key = `columns.${table}`;
  const stored = useUiStateStore((s) => parseSplit(s.values[key]));
  const ratio = stored ?? defaultRatio;
  const setRatio = useCallback((r: number) => useUiStateStore.getState().set(key, clampSplit(r)), [key]);
  const reset = useCallback(() => useUiStateStore.getState().set(key, undefined), [key]);
  const style = useMemo(
    () =>
      ({ "--col-a": `${ratio}fr`, "--col-b": `${Math.round((1 - ratio) * 1000) / 1000}fr` }) as CSSProperties,
    [ratio],
  );
  return { ratio, setRatio, reset, style };
}
