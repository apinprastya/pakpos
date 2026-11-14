import { create } from "zustand";
import { api } from "@/lib/api";

/**
 * App-wide UI state that survives restarts: panel sizes, table column widths.
 * Go (SQLite) stores it; `load` runs before the first render (main.tsx) so
 * panels mount at their saved sizes. Writes are debounced per key, since
 * dragging a divider changes the value on every pointer move.
 */
interface UiStateState {
  values: Record<string, unknown>;
  loaded: boolean;
  load: () => Promise<void>;
  /** Sets a value (saved shortly after); undefined removes it. */
  set: (key: string, value: unknown) => void;
}

export const SAVE_DELAY_MS = 300;
const LOAD_TIMEOUT_MS = 1500;

const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; value: unknown }>();

function write(key: string, value: unknown): void {
  pending.delete(key);
  api.setUiState(key, value === undefined ? "" : JSON.stringify(value)).catch((e: unknown) => {
    console.warn(`save ui state ${key}`, e);
  });
}

/** Writes every pending change now (the window may be closing). */
export function flushUiState(): void {
  for (const [key, { timer, value }] of [...pending]) {
    clearTimeout(timer);
    write(key, value);
  }
}

function parse(raw: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    try {
      out[k] = JSON.parse(v);
    } catch {
      // A corrupt value falls back to the default.
    }
  }
  return out;
}

export const useUiStateStore = create<UiStateState>()((set) => ({
  values: {},
  loaded: false,

  load: async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), LOAD_TIMEOUT_MS);
    });
    try {
      const raw = await Promise.race([api.getUiState(), timeout]);
      // Values set while loading win over stored ones.
      if (raw) set((s) => ({ values: { ...parse(raw), ...s.values } }));
    } catch {
      // Start from defaults; nothing is lost but the saved layout.
    } finally {
      clearTimeout(timer);
      set({ loaded: true });
    }
  },

  set: (key, value) => {
    set((s) => {
      const values = { ...s.values };
      if (value === undefined) delete values[key];
      else values[key] = value;
      return { values };
    });
    const prev = pending.get(key);
    if (prev) clearTimeout(prev.timer);
    pending.set(key, { timer: setTimeout(() => write(key, value), SAVE_DELAY_MS), value });
  },
}));

/** Resets the store and drops pending writes (tests). */
export function resetUiState(): void {
  for (const { timer } of pending.values()) clearTimeout(timer);
  pending.clear();
  useUiStateStore.setState({ values: {}, loaded: false });
}
