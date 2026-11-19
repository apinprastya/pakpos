import { StreamLanguage, type StringStream } from "@codemirror/language";

/** The token class of each segment: header, payload, signature (colours from the `--syntax-*` tokens). */
const SEGMENT_TOKENS = ["typeName", "keyword", "propertyName"] as const;

interface JwtTokenizerState {
  /** Index of the segment the stream is in (dots seen so far). */
  segment: number;
}

/** Colours a token's header, payload and signature apart; the dots are punctuation. */
export function jwtToken(stream: StringStream, state: JwtTokenizerState): string {
  if (stream.eat(".")) {
    state.segment++;
    return "punctuation";
  }
  stream.eatWhile((c) => c !== ".");
  return SEGMENT_TOKENS[Math.min(state.segment, SEGMENT_TOKENS.length - 1)];
}

export const jwtLanguage = StreamLanguage.define<JwtTokenizerState>({
  name: "jwt",
  startState: () => ({ segment: 0 }),
  copyState: (s) => ({ ...s }),
  token: jwtToken,
});
