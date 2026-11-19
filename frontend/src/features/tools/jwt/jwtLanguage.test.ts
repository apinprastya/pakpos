import { StringStream } from "@codemirror/language";
import { loadLanguage, needsLoading } from "@/components/editor/languages";
import { jwtToken } from "./jwtLanguage";

function tokens(line: string) {
  const state = { segment: 0 };
  const stream = new StringStream(line, 2, 2);
  const out: [string, string][] = [];
  while (!stream.eol()) {
    stream.start = stream.pos;
    const style = jwtToken(stream, state);
    out.push([stream.current(), style]);
  }
  return out;
}

describe("jwt language", () => {
  it("colours header, payload and signature apart", () => {
    expect(tokens("aaa.bbb.ccc.ddd")).toEqual([
      ["aaa", "typeName"],
      [".", "punctuation"],
      ["bbb", "keyword"],
      [".", "punctuation"],
      ["ccc", "propertyName"],
      [".", "punctuation"],
      ["ddd", "propertyName"],
    ]);
  });

  it("loads as a lazy editor language", async () => {
    expect(needsLoading("jwt")).toBe(true);
    await loadLanguage("jwt");
    expect(needsLoading("jwt")).toBe(false);
  });
});
