import {
  MAX_PERSISTED_INPUT,
  jsonInitialState,
  jsonWithInput,
  restoreJsonState,
  serializeJsonState,
} from "./state";

describe("JSON tool state", () => {
  it.each([
    [
      { input: "[1]", mode: "minify", indent: "tab", sortKeys: true },
      { input: "[1]", mode: "minify", indent: "tab", sortKeys: true },
    ],
    [{ input: 1, mode: "pretty", indent: "8", sortKeys: "yes" }, jsonInitialState()],
    [null, jsonInitialState()],
    ["text", jsonInitialState()],
  ])("restores %j", (raw, want) => {
    expect(restoreJsonState(raw)).toEqual(want);
  });

  it("takes new input formatted, keeping minify and the other choices", () => {
    const s = { input: "a", mode: "escape" as const, indent: "4" as const, sortKeys: true };
    expect(jsonWithInput(s, "[1]")).toEqual({ ...s, input: "[1]", mode: "format" });
    expect(jsonWithInput({ ...s, mode: "minify" }, "[1]").mode).toBe("minify");
  });

  it("drops a large input from what is persisted", () => {
    const small = jsonInitialState("x".repeat(MAX_PERSISTED_INPUT));
    expect(serializeJsonState(small)).toBe(small);
    const big = { ...jsonInitialState("x".repeat(MAX_PERSISTED_INPUT + 1)), sortKeys: true };
    expect(serializeJsonState(big)).toEqual({ ...big, input: "" });
  });
});
