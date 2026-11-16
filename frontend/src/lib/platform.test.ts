import { isMac, markPlatform, modKeyLabel } from "./platform";

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

  it("marks the platform on the root element", () => {
    const root = document.createElement("html");
    markPlatform(root, "MacIntel");
    expect(root).toHaveAttribute("data-platform", "mac");
    markPlatform(root, "Linux x86_64");
    expect(root).toHaveAttribute("data-platform", "other");
    markPlatform();
    expect(document.documentElement.dataset.platform).toMatch(/^(mac|other)$/);
  });
});
