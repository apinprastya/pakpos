import { editorLanguage, isLazyLanguage, languageExtension, loadLanguage } from "./languages";

describe("editor languages", () => {
  it("maps generator editor ids", () => {
    expect(editorLanguage("python")).toBe("python");
    expect(editorLanguage("shell")).toBe("shell");
    expect(editorLanguage("cobol")).toBe("text");
  });

  it("loads the generated-code languages lazily, once", async () => {
    for (const lang of ["shell", "go", "python", "java", "php"] as const) {
      expect(isLazyLanguage(lang)).toBe(true);
      expect(languageExtension(lang)).toEqual([]);
      const ext = await loadLanguage(lang);
      expect(ext).toBeTruthy();
      expect(loadLanguage(lang)).toBe(loadLanguage(lang));
    }
    expect(isLazyLanguage("json")).toBe(false);
    expect(await loadLanguage("text")).toEqual([]);
    expect(await loadLanguage("json")).toBeTruthy();
  });

  it("falls back to no highlighting when a language fails to load", async () => {
    vi.resetModules();
    vi.doMock("@codemirror/lang-java", () => {
      throw new Error("chunk failed");
    });
    const fresh = await import("./languages");
    expect(await fresh.loadLanguage("java")).toEqual([]);
    vi.doUnmock("@codemirror/lang-java");
  });
});
