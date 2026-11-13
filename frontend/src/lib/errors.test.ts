import { errorMessage, plural } from "./errors";

describe("errorMessage", () => {
  it.each([
    [new Error("boom"), "boom"],
    ["plain", "plain"],
    [{ message: "from wails" }, "from wails"],
    [42, "42"],
  ])("%s -> %s", (input, expected) => {
    expect(errorMessage(input)).toBe(expected);
  });
});

describe("plural", () => {
  it("uses singular for one and a regular or given plural otherwise", () => {
    expect(plural(1, "request")).toBe("1 request");
    expect(plural(0, "request")).toBe("0 requests");
    expect(plural(3, "entry", "entries")).toBe("3 entries");
  });
});
