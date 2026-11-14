import type { EditorLanguage } from "./languages";

// Each test imports a fresh copy, so the language cache starts empty.
async function fresh() {
  vi.resetModules();
  return import("./languages");
}

describe("editor languages", () => {
  it("maps generator editor ids", async () => {
    const { editorLanguage } = await fresh();
    expect(editorLanguage("python")).toBe("python");
    expect(editorLanguage("shell")).toBe("shell");
    expect(editorLanguage("json")).toBe("json");
    expect(editorLanguage("cobol")).toBe("text");
  });

  it("loads every language but plain text lazily, once", async () => {
    const { languageExtension, loadLanguage, needsLoading } = await fresh();
    const all: EditorLanguage[] = [
      "json",
      "xml",
      "html",
      "javascript",
      "shell",
      "go",
      "python",
      "java",
      "php",
    ];
    for (const lang of all) {
      expect(needsLoading(lang)).toBe(true);
      expect(languageExtension(lang)).toEqual([]);
      const p = loadLanguage(lang);
      expect(loadLanguage(lang)).toBe(p);
      const ext = await p;
      expect(ext).toBeTruthy();
      expect(needsLoading(lang)).toBe(false);
      expect(languageExtension(lang)).toBe(ext);
    }
    expect(needsLoading("text")).toBe(false);
    expect(await loadLanguage("text")).toEqual([]);
  });

  it("preloads a set of languages", async () => {
    const { needsLoading, preloadLanguages } = await fresh();
    await preloadLanguages(["json", "xml"]);
    expect(needsLoading("json")).toBe(false);
    expect(needsLoading("xml")).toBe(false);
    expect(needsLoading("html")).toBe(true);
  });

  it("falls back to no highlighting when a language fails to load, and retries later", async () => {
    vi.doMock("@codemirror/lang-java", () => {
      throw new Error("chunk failed");
    });
    const { loadLanguage, needsLoading } = await fresh();
    expect(await loadLanguage("java")).toEqual([]);
    expect(needsLoading("java")).toBe(true);
    vi.doUnmock("@codemirror/lang-java");
    vi.resetModules();
    expect(await loadLanguage("java")).not.toEqual([]);
  });
});
