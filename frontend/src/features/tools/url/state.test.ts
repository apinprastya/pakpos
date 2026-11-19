import {
  MAX_PERSISTED_URL_INPUT,
  restoreUrlState,
  serializeUrlState,
  urlInitialState,
  urlWithInput,
} from "./state";

describe("URL tool state", () => {
  it.each([
    [
      { input: "a b", mode: "form", direction: "decode" },
      { input: "a b", mode: "form", direction: "decode" },
    ],
    [{ input: 1, mode: "path", direction: "up" }, urlInitialState()],
    [null, urlInitialState()],
    ["x", urlInitialState()],
  ])("restores %j", (raw, want) => {
    expect(restoreUrlState(raw)).toEqual(want);
  });

  it("takes new input and keeps the mode and direction", () => {
    const s = { input: "a", mode: "full" as const, direction: "decode" as const };
    expect(urlWithInput(s, "b")).toEqual({ ...s, input: "b" });
    expect(urlInitialState("x")).toEqual({ input: "x", mode: "component", direction: "encode" });
  });

  it("drops a large input from what is persisted", () => {
    const small = urlInitialState("x".repeat(MAX_PERSISTED_URL_INPUT));
    expect(serializeUrlState(small)).toBe(small);
    const big = { ...urlInitialState("x".repeat(MAX_PERSISTED_URL_INPUT + 1)), mode: "form" as const };
    expect(serializeUrlState(big)).toEqual({ ...big, input: "" });
  });
});
