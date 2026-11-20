import type { Alphabet, Direction } from "./base64";

/** The Base64 tool tab's state. Never persisted: Base64 often wraps a credential. */
export interface Base64ToolState {
  input: string;
  direction: Direction;
  alphabet: Alphabet;
  padding: boolean;
}

/** A new tab; input from an entry point ("Decode Base64") opens in decode mode. */
export function base64InitialState(input?: string): Base64ToolState {
  return { input: input ?? "", direction: input ? "decode" : "encode", alphabet: "standard", padding: true };
}

/** New input from an entry point: decoded, with the encode options kept. */
export function base64WithInput(state: Base64ToolState, input: string): Base64ToolState {
  return { ...state, input, direction: "decode" };
}

/** The tool doesn't persist, but an old or hand-edited entry must still load cleanly (empty). */
export function restoreBase64State(raw: unknown): Base64ToolState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Base64ToolState, unknown>>;
  return {
    ...base64InitialState(),
    alphabet: r.alphabet === "url" ? "url" : "standard",
    padding: typeof r.padding === "boolean" ? r.padding : true,
  };
}
