import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { flushUiState, SAVE_DELAY_MS, useUiStateStore } from "./uiState";

afterEach(() => {
  vi.useRealTimers();
});

describe("uiState store", () => {
  it("loads and parses stored values, skipping corrupt ones", async () => {
    vi.mocked(api.getUiState).mockResolvedValue({
      "panels.main": '{"sidebar":20,"workspace":80}',
      "columns.keyValue": "0.3",
      broken: "{",
    });
    await useUiStateStore.getState().load();
    const s = useUiStateStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.values).toEqual({ "panels.main": { sidebar: 20, workspace: 80 }, "columns.keyValue": 0.3 });
  });

  it("keeps values set while loading", async () => {
    let resolve!: (v: Record<string, string>) => void;
    vi.mocked(api.getUiState).mockReturnValue(new Promise((r) => (resolve = r)));
    const loading = useUiStateStore.getState().load();
    useUiStateStore.getState().set("a", 2);
    resolve({ a: "1", b: "1" });
    await loading;
    expect(useUiStateStore.getState().values).toEqual({ a: 2, b: 1 });
  });

  it("starts from defaults when Go fails or is too slow", async () => {
    vi.mocked(api.getUiState).mockRejectedValue(new Error("boom"));
    await useUiStateStore.getState().load();
    expect(useUiStateStore.getState()).toMatchObject({ loaded: true, values: {} });

    useUiStateStore.setState({ loaded: false });
    vi.useFakeTimers();
    vi.mocked(api.getUiState).mockReturnValue(new Promise(() => {}));
    const loading = useUiStateStore.getState().load();
    await vi.advanceTimersByTimeAsync(2000);
    await loading;
    expect(useUiStateStore.getState()).toMatchObject({ loaded: true, values: {} });
  });

  it("debounces writes per key and removes with undefined", async () => {
    vi.useFakeTimers();
    const { set } = useUiStateStore.getState();
    set("columns.keyValue", 0.3);
    set("columns.keyValue", 0.35);
    set("panels.main", { sidebar: 25 });
    expect(useUiStateStore.getState().values["columns.keyValue"]).toBe(0.35);
    expect(api.setUiState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(api.setUiState).toHaveBeenCalledTimes(2);
    expect(api.setUiState).toHaveBeenCalledWith("columns.keyValue", "0.35");
    expect(api.setUiState).toHaveBeenCalledWith("panels.main", '{"sidebar":25}');

    set("columns.keyValue", undefined);
    expect(useUiStateStore.getState().values).not.toHaveProperty("columns.keyValue");
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(api.setUiState).toHaveBeenLastCalledWith("columns.keyValue", "");
  });

  it("flushes pending writes at once", () => {
    useUiStateStore.getState().set("k", true);
    flushUiState();
    expect(api.setUiState).toHaveBeenCalledWith("k", "true");
    flushUiState(); // nothing left
    expect(api.setUiState).toHaveBeenCalledTimes(1);
  });

  it("warns when a write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(api.setUiState).mockRejectedValue(new Error("disk full"));
    useUiStateStore.getState().set("k", 1);
    flushUiState();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("save ui state k", expect.any(Error)));
    warn.mockRestore();
  });
});
