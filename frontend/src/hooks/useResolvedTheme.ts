import { useEffect, useState } from "react";
import { applyTheme, resolveTheme, useThemeStore, type ResolvedTheme } from "@/stores/theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Resolves the theme mode against the OS preference, applies it to <html>, and tracks OS changes. */
export function useResolvedTheme(): ResolvedTheme {
  const mode = useThemeStore((s) => s.mode);
  const [prefersDark, setPrefersDark] = useState(() => window.matchMedia(DARK_QUERY).matches);

  useEffect(() => {
    const mql = window.matchMedia(DARK_QUERY);
    const onChange = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const resolved = resolveTheme(mode, prefersDark);
  useEffect(() => applyTheme(resolved), [resolved]);
  return resolved;
}
