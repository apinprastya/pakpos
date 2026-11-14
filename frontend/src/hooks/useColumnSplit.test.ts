import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useUiStateStore } from "@/stores/uiState";
import { clampSplit, MAX_SPLIT, MIN_SPLIT, useColumnSplit } from "./useColumnSplit";

describe("useColumnSplit", () => {
  it("uses the default until a split is stored", () => {
    const { result } = renderHook(() => useColumnSplit("keyValue", 0.4));
    expect(result.current.ratio).toBe(0.4);
    expect(result.current.style).toEqual({ "--col-a": "0.4fr", "--col-b": "0.6fr" });

    act(() => result.current.setRatio(0.25));
    expect(result.current.ratio).toBe(0.25);
    expect(useUiStateStore.getState().values["columns.keyValue"]).toBe(0.25);
    expect(result.current.style).toEqual({ "--col-a": "0.25fr", "--col-b": "0.75fr" });

    act(() => result.current.reset());
    expect(result.current.ratio).toBe(0.4);
    expect(useUiStateStore.getState().values).not.toHaveProperty("columns.keyValue");
  });

  it("clamps stored and set values and ignores junk", () => {
    useUiStateStore.setState({ values: { "columns.a": 0.99, "columns.b": "wide" } });
    expect(renderHook(() => useColumnSplit("a", 0.4)).result.current.ratio).toBe(MAX_SPLIT);
    expect(renderHook(() => useColumnSplit("b", 0.4)).result.current.ratio).toBe(0.4);

    const { result } = renderHook(() => useColumnSplit("c", 0.4));
    act(() => result.current.setRatio(-3));
    expect(result.current.ratio).toBe(MIN_SPLIT);
  });

  it("clampSplit rounds to three places", () => {
    expect(clampSplit(0.123456)).toBe(MIN_SPLIT);
    expect(clampSplit(0.45678)).toBe(0.457);
  });
});
