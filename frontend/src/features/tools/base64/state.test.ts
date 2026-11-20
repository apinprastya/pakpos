import { base64InitialState, base64WithInput, restoreBase64State } from "./state";

describe("Base64 tool state", () => {
  it("starts in encode mode, or decode mode with input from an entry point", () => {
    expect(base64InitialState()).toEqual({
      input: "",
      direction: "encode",
      alphabet: "standard",
      padding: true,
    });
    expect(base64InitialState("Zg==")).toMatchObject({ input: "Zg==", direction: "decode" });
  });

  it("replaces the input in decode mode, keeping the options", () => {
    const s = { input: "x", direction: "encode" as const, alphabet: "url" as const, padding: false };
    expect(base64WithInput(s, "Zg")).toEqual({ ...s, input: "Zg", direction: "decode" });
  });

  it.each([
    [
      { input: "secret", direction: "decode", alphabet: "url", padding: false },
      { alphabet: "url", padding: false },
    ],
    [
      { alphabet: "bogus", padding: "no" },
      { alphabet: "standard", padding: true },
    ],
    [null, { alphabet: "standard", padding: true }],
  ])("restores %j without its input", (raw, want) => {
    expect(restoreBase64State(raw)).toEqual({ input: "", direction: "encode", ...want });
  });
});
