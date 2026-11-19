import { jwtInitialState, restoreJwtState } from "./state";

describe("JWT tool state", () => {
  it.each([
    [
      { token: "a.b.c", revealed: { x: "secret" } },
      { token: "a.b.c", revealed: {} },
    ],
    [{ token: 3 }, { token: "", revealed: {} }],
    [null, { token: "", revealed: {} }],
    ["a.b.c", { token: "", revealed: {} }],
  ])("restores %j without revealed secrets", (raw, want) => {
    expect(restoreJwtState(raw)).toEqual(want);
  });

  it("starts with the given input", () => {
    expect(jwtInitialState()).toEqual({ token: "", revealed: {} });
    expect(jwtInitialState("x")).toEqual({ token: "x", revealed: {} });
  });
});
