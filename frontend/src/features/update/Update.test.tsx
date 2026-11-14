import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "@/lib/api";
import { ACTIONS } from "@/features/palette/actions";
import { StatusBar } from "@/features/shell/StatusBar";
import { DEFAULT_SETTINGS } from "@/lib/model";
import { useSettingsStore } from "@/stores/settings";
import { CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, useUpdateStore } from "@/stores/update";
import { makeUpdateInfo } from "@/test/fixtures";
import { megabytes, percent, releaseDate } from "./format";
import { UpdateDialog } from "./UpdateDialog";
import { useUpdateCheck } from "./useUpdateCheck";

function openWith(state: Partial<ReturnType<typeof useUpdateStore.getState>>) {
  useUpdateStore.setState({ dialogOpen: true, ...state });
  render(<UpdateDialog />);
  return screen.getByRole("dialog", { name: "Software update" });
}

describe("UpdateDialog", () => {
  it("formats sizes, dates and percentages", () => {
    expect(megabytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(releaseDate("")).toBe("");
    expect(releaseDate("nope")).toBe("");
    expect(releaseDate("2026-11-10T00:00:00Z")).not.toBe("");
    expect(percent(5, 10)).toBe(50);
    expect(percent(20, 10)).toBe(100);
    expect(percent(5, 0)).toBeNull();
  });

  it("offers a check before one has run, and retries after a failure", async () => {
    const user = userEvent.setup();
    let dialog = openWith({});
    expect(within(dialog).getByText("Pakpos hasn't checked for updates yet.")).toBeInTheDocument();
    vi.mocked(api.checkForUpdates).mockRejectedValue(new Error("GitHub is unreachable"));
    await user.click(within(dialog).getByRole("button", { name: "Check for updates" }));
    dialog = await screen.findByRole("dialog", { name: "Software update" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("GitHub is unreachable");
    expect(within(dialog).getByText("Pakpos couldn't check for updates.")).toBeInTheDocument();
    vi.mocked(api.checkForUpdates).mockResolvedValue(makeUpdateInfo({ available: false, latest: "26.11.1" }));
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByText(/You're up to date. Pakpos 26.11.1/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(useUpdateStore.getState().dialogOpen).toBe(false);
  });

  it("shows checking while a check runs", () => {
    const dialog = openWith({ phase: "checking" });
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(within(dialog).getByText("Checking for updates…")).toBeInTheDocument();
  });

  it("shows a new release with notes and installs it", async () => {
    const user = userEvent.setup();
    const dialog = openWith({ phase: "checked", info: makeUpdateInfo() });
    expect(within(dialog).getByText(/Pakpos 26.11.2 is available. You have 26.11.1./)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Release notes")).toHaveTextContent("Fixes");

    await user.click(within(dialog).getByRole("button", { name: "Open release page" }));
    expect(api.openReleasePage).toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Download and install" }));
    await waitFor(() => expect(useUpdateStore.getState().phase).toBe("installed"));
    expect(within(dialog).getByText(/Pakpos 26.11.2 is installed/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Restart now" }));
    expect(api.restartToUpdate).toHaveBeenCalled();
  });

  it("explains why a release can't be installed here", () => {
    const dialog = openWith({
      phase: "checked",
      info: makeUpdateInfo({ canInstall: false, reason: "Update it with your package manager." }),
    });
    expect(within(dialog).getByRole("note")).toHaveTextContent("Update it with your package manager.");
    expect(within(dialog).queryByRole("button", { name: "Download and install" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Later" })).toBeInTheDocument();
  });

  it("skips a version", async () => {
    const user = userEvent.setup();
    const dialog = openWith({ phase: "checked", info: makeUpdateInfo() });
    await user.click(within(dialog).getByRole("button", { name: "Skip this version" }));
    expect(useUpdateStore.getState()).toMatchObject({ skipped: "26.11.2", dialogOpen: false });
  });

  it("shows download progress and cancels it", async () => {
    const user = userEvent.setup();
    const dialog = openWith({ phase: "installing", info: makeUpdateInfo() });
    expect(within(dialog).getByText("Starting download…")).toBeInTheDocument();
    act(() => useUpdateStore.setState({ progress: { done: 1024 * 1024, total: 4 * 1024 * 1024 } }));
    expect(within(dialog).getByRole("progressbar", { name: "Download progress" })).toHaveAttribute(
      "aria-valuenow",
      "25",
    );
    expect(within(dialog).getByText("1.0 MB of 4.0 MB")).toBeInTheDocument();
    act(() => useUpdateStore.setState({ progress: { done: 1024 * 1024, total: 0 } }));
    expect(within(dialog).getByText("1.0 MB")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel download" }));
    expect(api.cancelUpdate).toHaveBeenCalled();
  });
});

describe("useUpdateCheck", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("checks after start and daily, only once settings allow it", () => {
    const autoCheck = vi.spyOn(useUpdateStore.getState(), "autoCheck").mockResolvedValue();
    const { unmount } = renderHook(() => useUpdateCheck());
    vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS);
    expect(autoCheck).not.toHaveBeenCalled(); // settings not loaded yet

    act(() => useSettingsStore.setState({ loaded: true }));
    vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS);
    expect(autoCheck).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    expect(autoCheck).toHaveBeenCalledTimes(2);

    act(() => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, checkForUpdates: false } }));
    vi.advanceTimersByTime(CHECK_INTERVAL_MS * 2);
    expect(autoCheck).toHaveBeenCalledTimes(2);
    unmount();
  });
});

describe("update entry points", () => {
  it("the status bar shows an available or installed update", async () => {
    const user = userEvent.setup();
    render(<StatusBar />);
    expect(screen.queryByRole("button", { name: "Update available" })).not.toBeInTheDocument();
    act(() => useUpdateStore.setState({ phase: "checked", info: makeUpdateInfo() }));
    await user.click(screen.getByRole("button", { name: "Update available" }));
    expect(useUpdateStore.getState().dialogOpen).toBe(true);
    act(() => useUpdateStore.setState({ phase: "installed" }));
    expect(screen.getByRole("button", { name: "Restart to update" })).toBeInTheDocument();
  });

  it("the palette checks for updates", async () => {
    const action = ACTIONS.find((a) => a.id === "check-for-updates")!;
    expect(action.enabled({} as never)).toBe(true);
    action.run({} as never);
    await waitFor(() => expect(useUpdateStore.getState().phase).toBe("checked"));
    expect(useUpdateStore.getState().dialogOpen).toBe(true);
  });
});
