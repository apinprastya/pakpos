import type { Direction, UrlMode } from "./url";

/** The URL tool tab's state; kept with the tabs (the input only while it's small). */
export interface UrlToolState {
  input: string;
  mode: UrlMode;
  direction: Direction;
}

/** Inputs larger than this aren't kept in localStorage (its quota is a few MB for all tabs). */
export const MAX_PERSISTED_URL_INPUT = 100 * 1024;

const MODES: UrlMode[] = ["component", "form", "full"];
const DIRECTIONS: Direction[] = ["encode", "decode"];

export function urlInitialState(input = ""): UrlToolState {
  return { input, mode: "component", direction: "encode" };
}

/** New input from an entry point; the tab's mode and direction stay. */
export function urlWithInput(state: UrlToolState, input: string): UrlToolState {
  return { ...state, input };
}

/** What goes to localStorage: everything, but a large input is dropped. */
export function serializeUrlState(state: UrlToolState): UrlToolState {
  return state.input.length > MAX_PERSISTED_URL_INPUT ? { ...state, input: "" } : state;
}

export function restoreUrlState(raw: unknown): UrlToolState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof UrlToolState, unknown>>;
  const d = urlInitialState();
  return {
    input: typeof r.input === "string" ? r.input : d.input,
    mode: MODES.includes(r.mode as UrlMode) ? (r.mode as UrlMode) : d.mode,
    direction: DIRECTIONS.includes(r.direction as Direction) ? (r.direction as Direction) : d.direction,
  };
}
