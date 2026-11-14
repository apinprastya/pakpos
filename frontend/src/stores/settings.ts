import { create } from "zustand";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { DEFAULT_SETTINGS, type AppSettings, type LayoutSetting, type ThemeSetting } from "@/lib/model";
import { useLayoutStore } from "./layout";
import { useThemeStore } from "./theme";

export type SettingsSection = "appearance" | "requests" | "history" | "secrets" | "about";

/**
 * App settings. Go (SQLite) is the single source of truth, including theme and
 * layout. The theme and layout stores keep a localStorage copy only so the
 * first paint uses the right theme before Go answers; `load` overwrites them
 * from Go, and every change goes through `save`.
 */
interface SettingsState {
  settings: AppSettings;
  loaded: boolean;
  dialogOpen: boolean;
  section: SettingsSection;

  load: () => Promise<void>;
  /** Saves to Go and applies. Rejects with Go's validation message. */
  save: (next: AppSettings) => Promise<AppSettings>;
  /** Quick changes from the theme menu and status bar. */
  setTheme: (theme: ThemeSetting) => Promise<void>;
  setLayout: (layout: LayoutSetting) => Promise<void>;

  openDialog: (section?: SettingsSection) => void;
  closeDialog: () => void;
  setSection: (section: SettingsSection) => void;
}

/** Pushes theme and layout into the stores that render them (and cache them). */
function applyToUi(s: AppSettings): void {
  if (useThemeStore.getState().mode !== s.theme) useThemeStore.getState().setMode(s.theme);
  if (useLayoutStore.getState().splitOrientation !== s.layout)
    useLayoutStore.getState().setSplitOrientation(s.layout);
}

/** Settings to start from before Go answers: defaults plus the cached UI choices. */
function initialSettings(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    theme: useThemeStore.getState().mode,
    layout: useLayoutStore.getState().splitOrientation,
  };
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  settings: initialSettings(),
  loaded: false,
  dialogOpen: false,
  section: "appearance",

  load: async () => {
    try {
      const settings = await api.getSettings();
      set({ settings, loaded: true });
      applyToUi(settings);
    } catch {
      // Keep the cached UI choices; the dialog will retry on open.
      set({ loaded: false });
    }
  },

  save: async (next) => {
    let saved: AppSettings;
    try {
      saved = await api.setSettings(next);
    } catch (e) {
      throw new Error(errorMessage(e), { cause: e });
    }
    set({ settings: saved, loaded: true });
    applyToUi(saved);
    return saved;
  },

  setTheme: async (theme) => {
    // Apply at once so the UI responds even if Go is slow; persist after.
    useThemeStore.getState().setMode(theme);
    await persistQuick({ ...get().settings, theme });
  },

  setLayout: async (layout) => {
    useLayoutStore.getState().setSplitOrientation(layout);
    await persistQuick({ ...get().settings, layout });
  },

  openDialog: (section) => set((s) => ({ dialogOpen: true, section: section ?? s.section })),
  closeDialog: () => set({ dialogOpen: false }),
  setSection: (section) => set({ section }),
}));

async function persistQuick(next: AppSettings): Promise<void> {
  useSettingsStore.setState({ settings: next });
  try {
    await useSettingsStore.getState().save(next);
  } catch {
    // The choice still applies for this session; it's cached in localStorage.
  }
}
