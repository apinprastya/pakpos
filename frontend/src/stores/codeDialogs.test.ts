import { useCodeDialogsStore } from "./codeDialogs";

describe("code dialogs store", () => {
  it("opens and closes the dialogs", () => {
    const s = useCodeDialogsStore.getState;
    s().openImport();
    expect(s()).toMatchObject({ importOpen: true, importParentId: "" });
    s().openImport("f1");
    expect(s().importParentId).toBe("f1");
    s().closeImport();
    expect(s().importOpen).toBe(false);
    s().openCode("t1");
    expect(s().codeTabId).toBe("t1");
    s().closeCode();
    expect(s().codeTabId).toBeNull();
  });

  it("remembers the language in localStorage, and survives storage errors", async () => {
    useCodeDialogsStore.getState().setLanguage("go-native");
    expect(localStorage.getItem("pakpos-code-language")).toBe("go-native");

    vi.resetModules();
    const fresh = await import("./codeDialogs");
    expect(fresh.useCodeDialogsStore.getState().language).toBe("go-native");

    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    fresh.useCodeDialogsStore.getState().setLanguage("php-curl");
    expect(fresh.useCodeDialogsStore.getState().language).toBe("php-curl");
    vi.resetModules();
    expect((await import("./codeDialogs")).useCodeDialogsStore.getState().language).toBe("curl");
    set.mockRestore();
    get.mockRestore();
    localStorage.removeItem("pakpos-code-language");
  });
});
