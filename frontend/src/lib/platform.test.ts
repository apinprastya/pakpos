import { isMac, modKeyLabel } from "./platform";

describe("platform", () => {
  it("detects macOS", () => {
    expect(isMac("MacIntel")).toBe(true);
    expect(isMac("Linux x86_64")).toBe(false);
  });

  it("labels the modifier key", () => {
    expect(modKeyLabel("MacIntel")).toBe("⌘");
    expect(modKeyLabel("Win32")).toBe("Ctrl");
  });

  it("falls back to navigator.platform", () => {
    expect(typeof isMac()).toBe("boolean");
  });
});
