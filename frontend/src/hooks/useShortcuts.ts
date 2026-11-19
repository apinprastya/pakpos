import { useEffect } from "react";
import { saveTab, sendTab } from "@/features/request/actions";
import { useCodeDialogsStore } from "@/stores/codeDialogs";
import { usePaletteStore } from "@/stores/palette";
import { useSettingsStore } from "@/stores/settings";
import { isRequestTab, useTabsStore } from "@/stores/tabs";
import { useConsoleStore } from "@/stores/console";

/**
 * App-wide shortcuts: Mod+K command palette, Mod+Enter send, Mod+S save, Mod+T new tab,
 * Mod+W close tab, Mod+, settings, Mod+J toggle console, Mod+Shift+C generate code (request tabs).
 * While the palette is open only Mod+K works (it closes it); the palette handles its own keys.
 */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (!e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        usePaletteStore.getState().toggle();
        return;
      }
      if (usePaletteStore.getState().open) return;
      if (e.shiftKey) {
        if (e.key.toLowerCase() === "c") {
          const { tabs, activeId } = useTabsStore.getState();
          const tab = tabs.find((t) => t.id === activeId);
          if (!tab || !isRequestTab(tab)) return;
          e.preventDefault();
          useCodeDialogsStore.getState().openCode(tab.id);
        }
        return;
      }
      const { activeId, newTab, requestClose } = useTabsStore.getState();
      switch (e.key.toLowerCase()) {
        case "enter":
          e.preventDefault();
          void sendTab(activeId);
          break;
        case "s":
          e.preventDefault();
          void saveTab(activeId);
          break;
        case "t":
          e.preventDefault();
          newTab();
          break;
        case "w":
          e.preventDefault();
          requestClose(activeId);
          break;
        case ",":
          e.preventDefault();
          useSettingsStore.getState().openDialog();
          break;
        case "j":
          e.preventDefault();
          useConsoleStore.getState().toggle();
          break;
      }
    };
    // Capture phase so editors (CodeMirror) don't swallow the shortcut first.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
