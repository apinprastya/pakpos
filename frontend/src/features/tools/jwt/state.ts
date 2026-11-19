/** The JWT decoder tab's state. Never persisted: a token is a credential. */
export interface JwtState {
  /** What's in the token field, `{{variables}}` included. */
  token: string;
  /** Secret values revealed for this tab, by variable name (memory only). */
  revealed: Record<string, string>;
}

export function jwtInitialState(input = ""): JwtState {
  return { token: input, revealed: {} };
}

/** The tool doesn't persist, but an old or hand-edited entry must still load cleanly. */
export function restoreJwtState(raw: unknown): JwtState {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<JwtState>;
  return jwtInitialState(typeof r.token === "string" ? r.token : "");
}
