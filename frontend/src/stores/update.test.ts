import { toast } from "sonner";
import { api } from "@/lib/api";
import type { UpdateInfo } from "@/lib/model";
import { makeUpdateInfo } from "@/test/fixtures";
import { SKIPPED_KEY, selectUpdateBadge, useUpdateStore } from "./update";

vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: { ...actual.toast, info: vi.fn() } };
});

const state = () => useUpdateStore.getState();

describe("update store", () => {
  beforeEach(() => vi.mocked(toast.info).mockClear());

  it("check opens the dialog and stores the result", async () => {
    vi.mocked(api.checkForUpdates).mockResolvedValue(makeUpdateInfo());
    const p = state().check();
    expect(state()).toMatchObject({ dialogOpen: true, phase: "checking" });
    await p;
    expect(state()).toMatchObject({ phase: "checked", error: null });
    expect(state().info?.latest).toBe("26.11.2");
  });

  it("check reports a failure", async () => {
    vi.mocked(api.checkForUpdates).mockRejectedValue(new Error("offline"));
    await state().check();
    expect(state()).toMatchObject({ phase: "idle", info: null, error: "offline" });
    state().closeDialog();
    expect(state()).toMatchObject({ dialogOpen: false, error: null });
  });

  it("check only reopens the dialog while installing", async () => {
    useUpdateStore.setState({ phase: "installing" });
    await state().check();
    expect(state().dialogOpen).toBe(true);
    expect(api.checkForUpdates).not.toHaveBeenCalled();
  });

  it("autoCheck announces a new release once", async () => {
    vi.mocked(api.checkForUpdates).mockResolvedValue(makeUpdateInfo());
    await state().autoCheck();
    expect(state()).toMatchObject({ phase: "checked", dialogOpen: false });
    expect(toast.info).toHaveBeenCalledTimes(1);
    const [title, opts] = vi.mocked(toast.info).mock.calls[0];
    expect(title).toBe("Pakpos 26.11.2 is available");
    (opts as unknown as { action: { onClick: () => void } }).action.onClick();
    expect(state().dialogOpen).toBe(true);

    await state().autoCheck();
    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it("autoCheck stays quiet when up to date, skipped, failing or busy", async () => {
    vi.mocked(api.checkForUpdates).mockResolvedValue(makeUpdateInfo({ available: false }));
    await state().autoCheck();
    vi.mocked(api.checkForUpdates).mockResolvedValue(makeUpdateInfo());
    useUpdateStore.setState({ skipped: "26.11.2" });
    await state().autoCheck();
    expect(state().phase).toBe("checked");
    vi.mocked(api.checkForUpdates).mockRejectedValue(new Error("rate limited"));
    await state().autoCheck();
    expect(state().error).toBeNull();
    expect(toast.info).not.toHaveBeenCalled();

    vi.mocked(api.checkForUpdates).mockClear();
    useUpdateStore.setState({ phase: "installing" });
    await state().autoCheck();
    expect(api.checkForUpdates).not.toHaveBeenCalled();
  });

  it("autoCheck keeps a manual check that started meanwhile", async () => {
    let resolve!: (i: UpdateInfo) => void;
    vi.mocked(api.checkForUpdates).mockReturnValue(new Promise((r) => (resolve = r)));
    const p = state().autoCheck();
    useUpdateStore.setState({ phase: "checking" });
    resolve(makeUpdateInfo());
    await p;
    expect(state().phase).toBe("checking");
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("install reports progress and ends installed", async () => {
    useUpdateStore.setState({ phase: "checked", info: makeUpdateInfo() });
    const off = vi.fn();
    let emit!: (p: { done: number; total: number }) => void;
    vi.mocked(api.onUpdateProgress).mockImplementation((cb) => {
      emit = cb;
      return off;
    });
    let finish!: () => void;
    vi.mocked(api.installUpdate).mockReturnValue(new Promise<void>((r) => (finish = r)));
    const p = state().install();
    expect(state().phase).toBe("installing");
    emit({ done: 5, total: 10 });
    expect(state().progress).toEqual({ done: 5, total: 10 });
    finish();
    await p;
    expect(state().phase).toBe("installed");
    expect(off).toHaveBeenCalled();
  });

  it("install does nothing unless an installable release was checked", async () => {
    await state().install();
    useUpdateStore.setState({ phase: "checked", info: makeUpdateInfo({ canInstall: false }) });
    await state().install();
    expect(api.installUpdate).not.toHaveBeenCalled();
  });

  it("install shows a failure, but not a cancel", async () => {
    useUpdateStore.setState({ phase: "checked", info: makeUpdateInfo() });
    vi.mocked(api.installUpdate).mockRejectedValue(new Error("checksum mismatch"));
    await state().install();
    expect(state()).toMatchObject({ phase: "checked", error: "checksum mismatch", progress: null });

    let fail!: (e: Error) => void;
    vi.mocked(api.installUpdate).mockReturnValue(new Promise<void>((_, rej) => (fail = rej)));
    const p = state().install();
    await state().cancel();
    expect(api.cancelUpdate).toHaveBeenCalled();
    fail(new Error("context canceled"));
    await p;
    expect(state()).toMatchObject({ phase: "checked", error: null });
  });

  it("cancel does nothing when no install runs", async () => {
    await state().cancel();
    expect(api.cancelUpdate).not.toHaveBeenCalled();
  });

  it("closing the dialog keeps an install's error", () => {
    useUpdateStore.setState({ phase: "installed", error: "restart failed", dialogOpen: true });
    state().closeDialog();
    expect(state().error).toBe("restart failed");
  });

  it("restart and the release page report failures", async () => {
    await state().restart();
    expect(api.restartToUpdate).toHaveBeenCalled();
    expect(state().error).toBeNull();
    vi.mocked(api.restartToUpdate).mockRejectedValue(new Error("no update has been installed"));
    await state().restart();
    expect(state().error).toBe("no update has been installed");

    await state().openReleasePage();
    expect(api.openReleasePage).toHaveBeenCalled();
    vi.mocked(api.openReleasePage).mockRejectedValue(new Error("no browser"));
    await state().openReleasePage();
    expect(state().error).toBe("no browser");
  });

  it("skip remembers the version and closes the dialog", () => {
    state().skip();
    expect(localStorage.getItem(SKIPPED_KEY)).toBeNull();
    useUpdateStore.setState({ info: makeUpdateInfo(), dialogOpen: true });
    state().skip();
    expect(state()).toMatchObject({ skipped: "26.11.2", dialogOpen: false });
    expect(localStorage.getItem(SKIPPED_KEY)).toBe("26.11.2");
  });

  it("skip still works when storage throws", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    useUpdateStore.setState({ info: makeUpdateInfo() });
    state().skip();
    expect(state().skipped).toBe("26.11.2");
    spy.mockRestore();
  });

  it("reads the skipped version at startup, tolerating storage errors", async () => {
    localStorage.setItem(SKIPPED_KEY, "26.10.1");
    vi.resetModules();
    const fresh = await import("./update");
    expect(fresh.useUpdateStore.getState().skipped).toBe("26.10.1");

    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.resetModules();
    const again = await import("./update");
    expect(again.useUpdateStore.getState().skipped).toBe("");
    spy.mockRestore();
  });

  it("selectUpdateBadge", () => {
    const base = state();
    expect(selectUpdateBadge(base)).toBeNull();
    expect(selectUpdateBadge({ ...base, info: makeUpdateInfo() })).toBe("available");
    expect(selectUpdateBadge({ ...base, info: makeUpdateInfo(), skipped: "26.11.2" })).toBeNull();
    expect(selectUpdateBadge({ ...base, info: makeUpdateInfo(), phase: "installing" })).toBeNull();
    expect(selectUpdateBadge({ ...base, info: makeUpdateInfo(), phase: "installed" })).toBe("installed");
  });
});
