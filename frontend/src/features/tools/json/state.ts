import type { Indent, JsonMode } from "./json";

/** The JSON tool tab's state; kept with the tabs (the input only while it's small). */
export interface JsonToolState {
  input: string;
  mode: JsonMode;
  indent: Indent;
  sortKeys: boolean;
}

/** Inputs larger than this aren't kept in localStorage (its quota is a few MB for all tabs). */
export const MAX_PERSISTED_INPUT = 100 * 1024;

const MODES: JsonMode[] = ["format", "minify", "escape", "unescape"];
const INDENTS: Indent[] = ["2", "4", "tab"];

export function jsonInitialState(input = ""): JsonToolState {
  return { input, mode: "format", indent: "2", sortKeys: false };
}

/** New input from an entry point: shown formatted, with the tab's other choices kept. */
export function jsonWithInput(state: JsonToolState, input: string): JsonToolState {
  return { ...state, input, mode: state.mode === "minify" ? "minify" : "format" };
}

/** What goes to localStorage: everything, but a large input is dropped. */
export function serializeJsonState(state: JsonToolState): JsonToolState {
  return state.input.length > MAX_PERSISTED_INPUT ? { ...state, input: "" } : state;
}

export function restoreJsonState(raw: unknown): JsonToolState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof JsonToolState, unknown>>;
  const d = jsonInitialState();
  return {
    input: typeof r.input === "string" ? r.input : d.input,
    mode: MODES.includes(r.mode as JsonMode) ? (r.mode as JsonMode) : d.mode,
    indent: INDENTS.includes(r.indent as Indent) ? (r.indent as Indent) : d.indent,
    sortKeys: typeof r.sortKeys === "boolean" ? r.sortKeys : d.sortKeys,
  };
}
