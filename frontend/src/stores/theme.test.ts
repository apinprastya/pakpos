import { act, renderHook } from "@testing-library/react";
import { applyTheme, resolveTheme, useThemeStore } from "./theme";
import { useResolvedTheme } from "@/hooks/useResolvedTheme";

type Listener = (e: MediaQueryListEvent) => void;

function mockMatchMedia(initial: boolean) {
  const listeners = new Set<Listener>();
  const mql = {
    matches: initial,
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  };
  vi.spyOn(window, "matchMedia").mockReturnValue(mql as unknown as MediaQueryList);
  return {
    listeners,
    emit: (matches: boolean) => listeners.forEach((l) => l({ matches } as MediaQueryListEvent)),
  };
}

describe("theme store", () => {
  beforeEach(() => useThemeStore.setState({ mode: "system" }));
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["light", true, "light"],
    ["dark", false, "dark"],
    ["system", true, "dark"],
    ["system", false, "light"],
  ] as const)("resolveTheme(%s, prefersDark=%s) = %s", (mode, prefersDark, expected) => {
    expect(resolveTheme(mode, prefersDark)).toBe(expected);
  });

  it("applyTheme toggles the dark class", () => {
    const el = document.createElement("html");
    applyTheme("dark", el);
    expect(el.classList.contains("dark")).toBe(true);
    applyTheme("light", el);
    expect(el.classList.contains("dark")).toBe(false);
  });

  it("persists the chosen mode", () => {
    useThemeStore.getState().setMode("dark");
    expect(JSON.parse(localStorage.getItem("pakpos-theme")!).state.mode).toBe("dark");
  });

  it("useResolvedTheme follows OS changes in system mode and cleans up", () => {
    const mm = mockMatchMedia(false);
    const { result, unmount } = renderHook(() => useResolvedTheme());
    expect(result.current).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    act(() => mm.emit(true));
    expect(result.current).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    act(() => useThemeStore.getState().setMode("light"));
    expect(result.current).toBe("light");

    unmount();
    expect(mm.listeners.size).toBe(0);
  });
});
