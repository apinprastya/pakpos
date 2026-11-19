import { useEffect, useState } from "react";

/** Inputs at least this long are processed after typing pauses, not on every keystroke. */
export const DEBOUNCE_FROM = 200_000;
export const DEBOUNCE_MS = 250;

/** Text tools stop at 10 MiB instead of freezing the UI. */
export const MAX_TOOL_INPUT = 10 * 1024 * 1024;

/** `input`, or for large inputs its value once typing has paused. */
export function useSettled(input: string): string {
  const [settled, setSettled] = useState(input);
  const large = input.length >= DEBOUNCE_FROM;
  useEffect(() => {
    if (!large) return;
    const timer = setTimeout(() => setSettled(input), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input, large]);
  return large ? settled : input;
}
