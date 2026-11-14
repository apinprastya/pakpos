import { create } from "zustand";
import type { DeleteTarget } from "@/features/sidebar/ConfirmDeleteDialog";

/** A second step of the palette, reached from an action. */
export type PalettePage = "environment" | "move";

/** The command palette's state, and the confirm one of its actions asked for. */
interface PaletteState {
  open: boolean;
  /** The input's text (">" starts actions mode). */
  input: string;
  /** The second step being shown, if any. */
  page: PalettePage | null;
  /** A destructive action waiting for confirmation (e.g. "Clear history"). */
  confirm: DeleteTarget | null;

  openPalette: (input?: string) => void;
  close: () => void;
  toggle: () => void;
  setInput: (input: string) => void;
  /** Shows a second step with an empty input. */
  goTo: (page: PalettePage) => void;
  /** Leaves a second step, back to the actions. */
  back: () => void;
  setConfirm: (target: DeleteTarget | null) => void;
}

export const usePaletteStore = create<PaletteState>()((set, get) => ({
  open: false,
  input: "",
  page: null,
  confirm: null,

  openPalette: (input = "") => set({ open: true, input, page: null }),
  close: () => set({ open: false }),
  toggle: () => (get().open ? set({ open: false }) : set({ open: true, input: "", page: null })),
  setInput: (input) => set({ input }),
  goTo: (page) => set({ page, input: "" }),
  back: () => set({ page: null, input: ">" }),
  setConfirm: (confirm) => set({ confirm }),
}));
