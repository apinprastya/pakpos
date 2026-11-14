import { api } from "@/lib/api";
import { DEFAULT_SETTINGS } from "@/lib/model";
import { useLayoutStore } from "./layout";
import { useSettingsStore } from "./settings";
import { useThemeStore } from "./theme";

describe("settings store", () => {
  beforeEach(() => {
    useThemeStore.setState({ mode: "system" });
    useLayoutStore.setState({ splitOrientation: "vertical" });
  });

  it("load takes Go's settings as the source of truth and updates the UI caches", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({
      ...DEFAULT_SETTINGS,
      theme: "dark",
      layout: "horizontal",
    });
    await useSettingsStore.getState().load();
    const s = useSettingsStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.settings.theme).toBe("dark");
    expect(useThemeStore.getState().mode).toBe("dark");
    expect(useLayoutStore.getState().splitOrientation).toBe("horizontal");
  });

  it("load keeps the cached UI choices when Go fails", async () => {
    useThemeStore.setState({ mode: "light" });
    vi.mocked(api.getSettings).mockRejectedValue(new Error("boom"));
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().loaded).toBe(false);
    expect(useThemeStore.getState().mode).toBe("light");
  });

  it("save stores what Go returns and applies it", async () => {
    const next = { ...DEFAULT_SETTINGS, theme: "light" as const, timeoutMs: 5000 };
    vi.mocked(api.setSettings).mockResolvedValue(next);
    await expect(useSettingsStore.getState().save(next)).resolves.toEqual(next);
    expect(useSettingsStore.getState().settings).toEqual(next);
    expect(useThemeStore.getState().mode).toBe("light");
  });

  it("save rejects with Go's validation message", async () => {
    vi.mocked(api.setSettings).mockRejectedValue("timeout must be between 0 and 600000 ms");
    await expect(useSettingsStore.getState().save(DEFAULT_SETTINGS)).rejects.toThrow(
      "timeout must be between 0 and 600000 ms",
    );
  });

  it("setTheme applies at once and persists the merged settings", async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, timeoutMs: 1234 } });
    await useSettingsStore.getState().setTheme("dark");
    expect(useThemeStore.getState().mode).toBe("dark");
    expect(api.setSettings).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, timeoutMs: 1234, theme: "dark" });
  });

  it("setLayout keeps the choice for the session when saving fails", async () => {
    vi.mocked(api.setSettings).mockRejectedValue(new Error("db locked"));
    await useSettingsStore.getState().setLayout("horizontal");
    expect(useLayoutStore.getState().splitOrientation).toBe("horizontal");
    expect(useSettingsStore.getState().settings.layout).toBe("horizontal");
  });

  it("opens the dialog at a section, and keeps the last section otherwise", () => {
    const s = useSettingsStore.getState();
    s.openDialog("requests");
    expect(useSettingsStore.getState()).toMatchObject({ dialogOpen: true, section: "requests" });
    s.closeDialog();
    s.openDialog();
    expect(useSettingsStore.getState()).toMatchObject({ dialogOpen: true, section: "requests" });
    s.setSection("about");
    expect(useSettingsStore.getState().section).toBe("about");
  });
});
