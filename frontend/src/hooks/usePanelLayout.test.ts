import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useUiStateStore } from "@/stores/uiState";
import { parseLayout, usePanelLayout } from "./usePanelLayout";

describe("parseLayout", () => {
  it.each([
    [
      { a: 30, b: 70 },
      { a: 30, b: 70 },
    ],
    [{}, undefined],
    [null, undefined],
    [[30, 70], undefined],
    ["x", undefined],
    [{ a: "30" }, undefined],
    [{ a: -1 }, undefined],
    [{ a: 101 }, undefined],
    [{ a: Number.NaN }, undefined],
  ])("%j → %j", (input, want) => {
    expect(parseLayout(input)).toEqual(want);
  });
});

describe("usePanelLayout", () => {
  it("reads the saved layout per group and saves rounded changes", () => {
    useUiStateStore.setState({ values: { "panels.main": { sidebar: 22, workspace: 78 } } });
    const { result, rerender } = renderHook(({ id }) => usePanelLayout(id), { initialProps: { id: "main" } });
    expect(result.current.defaultLayout).toEqual({ sidebar: 22, workspace: 78 });

    act(() => result.current.onLayoutChanged({ sidebar: 25.123456, workspace: 74.876544 }));
    expect(useUiStateStore.getState().values["panels.main"]).toEqual({ sidebar: 25.12, workspace: 74.88 });

    rerender({ id: "split-vertical" });
    expect(result.current.defaultLayout).toBeUndefined();
  });
});
