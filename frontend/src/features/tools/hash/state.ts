import type { HashAlgorithm, KeyFormat } from "@/lib/toolModel";

/** The hash tool tab's state. Never persisted: the text or key is often a credential. */
export interface HashToolState {
  source: "text" | "file";
  text: string;
  /** The file chosen in File mode ("" for none). */
  filePath: string;
  algorithm: HashAlgorithm;
  hmac: boolean;
  /** The HMAC key as typed; it may use `{{variables}}`. */
  key: string;
  keyFormat: KeyFormat;
  /** Secret values revealed for this tab, by variable name (memory only). */
  revealed: Record<string, string>;
}

export function hashInitialState(input = ""): HashToolState {
  return {
    source: "text",
    text: input,
    filePath: "",
    algorithm: "sha256",
    hmac: false,
    key: "",
    keyFormat: "text",
    revealed: {},
  };
}

/** New text from an entry point: hashed as text, with the other choices kept. */
export function hashWithInput(state: HashToolState, input: string): HashToolState {
  return { ...state, source: "text", text: input };
}

/** The tool doesn't persist; anything read back starts empty. */
export function restoreHashState(): HashToolState {
  return hashInitialState();
}
