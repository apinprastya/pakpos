import { create } from "zustand";
import { persist } from "zustand/middleware";

export type SidebarView = "collections" | "history";
/** "vertical" stacks response under request; "horizontal" puts them side by side. */
export type SplitOrientation = "vertical" | "horizontal";

interface LayoutState {
  sidebarView: SidebarView;
  splitOrientation: SplitOrientation;
  setSidebarView: (view: SidebarView) => void;
  toggleSplitOrientation: () => void;
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      sidebarView: "collections",
      splitOrientation: "vertical",
      setSidebarView: (sidebarView) => set({ sidebarView }),
      toggleSplitOrientation: () =>
        set((s) => ({
          splitOrientation: s.splitOrientation === "vertical" ? "horizontal" : "vertical",
        })),
    }),
    { name: "pakpos-layout" },
  ),
);
