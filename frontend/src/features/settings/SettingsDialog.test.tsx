import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import App from "@/App";
import { api } from "@/lib/api";
import { DEFAULT_SETTINGS } from "@/lib/model";
import { useSettingsStore } from "@/stores/settings";
import { useThemeStore } from "@/stores/theme";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: { ...actual.toast, success: vi.fn(), info: vi.fn(), error: vi.fn() } };
});

async function openSettings() {
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole("button", { name: "Settings" }));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  return { user, dialog };
}

function section(dialog: HTMLElement, name: string) {
  return within(within(dialog).getByRole("navigation", { name: "Settings sections" })).getByRole("button", {
    name: new RegExp(`^${name}`),
  });
}

describe("SettingsDialog", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockClear();
    useThemeStore.setState({ mode: "system" });
  });

  it("opens from the rail with Go's current settings and shows appearance first", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({ ...DEFAULT_SETTINGS, theme: "dark" });
    const { dialog } = await openSettings();
    expect(within(dialog).getByText("Changes apply when you save.")).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole("radio", { name: "Dark" })).toBeChecked());
    expect(section(dialog, "Appearance")).toHaveAttribute("aria-current", "page");
  });

  it("opens with Mod+, and closes with Cancel without saving", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.keyboard("{Control>},{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(within(dialog).getByRole("radio", { name: "Light" }));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    expect(api.setSettings).not.toHaveBeenCalled();
    expect(useThemeStore.getState().mode).toBe("system");
  });

  it("saves appearance and request settings together", async () => {
    const { user, dialog } = await openSettings();
    await user.click(within(dialog).getByRole("radio", { name: "Light" }));
    await user.click(within(dialog).getByRole("radio", { name: "Beside the request" }));

    await user.click(section(dialog, "Requests"));
    const timeout = within(dialog).getByRole("textbox", { name: "Timeout" });
    await user.clear(timeout);
    await user.type(timeout, "90");
    await user.click(within(dialog).getByRole("switch", { name: "Follow redirects" }));
    expect(within(dialog).getByRole("textbox", { name: "Maximum redirects" })).toBeDisabled();

    await user.click(within(dialog).getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(api.setSettings).toHaveBeenCalledWith({
        ...DEFAULT_SETTINGS,
        theme: "light",
        layout: "horizontal",
        timeoutMs: 90_000,
        followRedirects: false,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Settings saved");
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    expect(useThemeStore.getState().mode).toBe("light");
  });

  it("warns when TLS verification is turned off", async () => {
    const { user, dialog } = await openSettings();
    await user.click(section(dialog, "Requests"));
    expect(within(dialog).queryByRole("note")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("switch", { name: "Verify TLS certificates" }));
    expect(within(dialog).getByRole("note")).toHaveTextContent("accept any certificate");
  });

  it("shows field errors inline, jumps to the section and doesn't save", async () => {
    const { user, dialog } = await openSettings();
    await user.click(section(dialog, "History"));
    const keep = within(dialog).getByRole("textbox", { name: "Requests to keep" });
    await user.clear(keep);
    await user.type(keep, "lots");
    await user.click(section(dialog, "About"));
    await user.click(within(dialog).getByRole("button", { name: "Save settings" }));

    expect(section(dialog, "History")).toHaveAttribute("aria-current", "page");
    expect(section(dialog, "History")).toHaveAccessibleName("History, has errors");
    expect(within(dialog).getByRole("textbox", { name: "Requests to keep" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(within(dialog).getByText("Enter a number from 0 to 100,000.")).toBeInTheDocument();
    expect(api.setSettings).not.toHaveBeenCalled();
  });

  it("jumps to Requests when a request field is invalid", async () => {
    const { user, dialog } = await openSettings();
    await user.click(section(dialog, "Requests"));
    const timeout = within(dialog).getByRole("textbox", { name: "Timeout" });
    await user.clear(timeout);
    await user.click(section(dialog, "History"));
    await user.click(within(dialog).getByRole("button", { name: "Save settings" }));
    expect(section(dialog, "Requests")).toHaveAttribute("aria-current", "page");
    expect(within(dialog).getByText("Enter whole seconds from 0 to 600.")).toBeInTheDocument();
  });

  it("explains that lowering retention deletes history", async () => {
    const { user, dialog } = await openSettings();
    await user.click(section(dialog, "History"));
    const keep = within(dialog).getByRole("textbox", { name: "Requests to keep" });
    await user.clear(keep);
    await user.type(keep, "50");
    expect(within(dialog).getByRole("note")).toHaveTextContent("older than the newest 50 entries");
  });

  it("shows Go's error when saving fails and stays open", async () => {
    vi.mocked(api.setSettings).mockRejectedValue(new Error("database is locked"));
    const { user, dialog } = await openSettings();
    await user.click(within(dialog).getByRole("button", { name: "Save settings" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("database is locked");
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    // Editing clears the error.
    await user.click(within(dialog).getByRole("radio", { name: "Dark" }));
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("resets the form to Go's defaults, falling back to built-in defaults", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({ ...DEFAULT_SETTINGS, theme: "dark", timeoutMs: 5000 });
    const { user, dialog } = await openSettings();
    await waitFor(() => expect(within(dialog).getByRole("radio", { name: "Dark" })).toBeChecked());
    await user.click(within(dialog).getByRole("button", { name: "Reset to defaults" }));
    await waitFor(() => expect(within(dialog).getByRole("radio", { name: "Match system" })).toBeChecked());

    await user.click(within(dialog).getByRole("radio", { name: "Dark" }));
    vi.mocked(api.defaultSettings).mockRejectedValue(new Error("offline"));
    await user.click(within(dialog).getByRole("button", { name: "Reset to defaults" }));
    await waitFor(() => expect(within(dialog).getByRole("radio", { name: "Match system" })).toBeChecked());
    await user.click(section(dialog, "Requests"));
    expect(within(dialog).getByRole("textbox", { name: "Timeout" })).toHaveValue("30");
  });

  it("shows build details in About", async () => {
    vi.mocked(api.buildInfo).mockResolvedValue({ version: "1.4.0", commit: "", os: "darwin", arch: "arm64" });
    const { user, dialog } = await openSettings();
    await user.click(section(dialog, "About"));
    expect(await within(dialog).findByText("1.4.0")).toBeInTheDocument();
    expect(within(dialog).getByText("Not recorded")).toBeInTheDocument();
    expect(within(dialog).getByText("darwin/arm64")).toBeInTheDocument();
  });

  it("About waits for build details, and tolerates failures loading them", async () => {
    vi.mocked(api.buildInfo).mockRejectedValue(new Error("no"));
    vi.mocked(api.getSettings).mockRejectedValue(new Error("no"));
    const { user, dialog } = await openSettings();
    await user.click(section(dialog, "About"));
    expect(within(dialog).getByText("Loading version details…")).toBeInTheDocument();
  });

  it("quick theme and layout changes are saved to Go", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Change theme" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Dark" }));
    await waitFor(() =>
      expect(api.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "dark" })),
    );
    await user.click(screen.getByRole("button", { name: "Show response beside request" }));
    await waitFor(() =>
      expect(api.setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ layout: "horizontal" })),
    );
    expect(useSettingsStore.getState().settings.layout).toBe("horizontal");
  });

  it("loads settings from Go when the app starts", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({ ...DEFAULT_SETTINGS, theme: "dark" });
    render(<App />);
    await waitFor(() => expect(useThemeStore.getState().mode).toBe("dark"));
  });
});
