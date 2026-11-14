import { useEffect } from "react";
import { saveTab, sendTab } from "@/features/request/actions";
import { useSettingsStore } from "@/stores/settings";
import { useTabsStore } from "@/stores/tabs";

/** App-wide shortcuts: Mod+Enter send, Mod+S save, Mod+T new tab, Mod+W close tab, Mod+, settings. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
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
      }
    };
    // Capture phase so editors (CodeMirror) don't swallow the shortcut first.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
