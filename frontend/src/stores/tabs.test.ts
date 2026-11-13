import { emptyRequest, type SendResult } from "@/lib/model";
import { activeTab, resetTabs } from "@/test/store";
import { isDirty, tabTitle, useTabsStore } from "./tabs";

const s = () => useTabsStore.getState();
const result: SendResult = { response: null, error: { kind: "dns", message: "x" }, historyId: 0 };

describe("tabs store", () => {
  beforeEach(() => resetTabs());

  it("opens new tabs and activates them", () => {
    const id = s().newTab();
    expect(s().tabs).toHaveLength(2);
    expect(s().activeId).toBe(id);
    s().activate("t1");
    expect(s().activeId).toBe("t1");
    s().activate("missing");
    expect(s().activeId).toBe("t1");
  });

  it("opens saved requests once and focuses the existing tab", () => {
    const req = { ...emptyRequest(), id: "r1", name: "Get user" };
    const a = s().openSaved(req, "c1");
    s().activate("t1");
    const b = s().openSaved(req, "c1");
    expect(a).toBe(b);
    expect(s().activeId).toBe(a);
    expect(activeTab().collectionId).toBe("c1");
    expect(isDirty(activeTab())).toBe(false);
    expect(tabTitle(activeTab())).toBe("Get user");
  });

  it("opens history entries detached with their result", () => {
    s().openFromHistory({ ...emptyRequest(), id: "r1", url: "x" }, result);
    expect(activeTab().request.id).toBe("");
    expect(activeTab().saved).toBeNull();
    expect(activeTab().result).toBe(result);
    expect(tabTitle(activeTab())).toBe("Untitled request");
  });

  it("closes tabs, picks a neighbour and never leaves zero tabs", () => {
    const b = s().newTab();
    const c = s().newTab();
    s().activate(b);
    s().close(b);
    expect(s().activeId).toBe(c);
    s().close("nope");
    expect(s().tabs).toHaveLength(2);
    s().close(c);
    s().close("t1");
    expect(s().tabs).toHaveLength(1);
    expect(s().tabs[0].id).not.toBe("t1");
  });

  it("asks before closing a dirty tab", () => {
    s().requestClose("missing");
    s().updateRequest("t1", (r) => ({ ...r, url: "https://x" }));
    expect(isDirty(activeTab())).toBe(true);
    s().requestClose("t1");
    expect(s().pendingCloseId).toBe("t1");
    s().cancelClose();
    expect(s().pendingCloseId).toBeNull();
    s().requestClose("t1");
    s().close("t1");
    expect(s().pendingCloseId).toBeNull();
    // A clean tab closes straight away.
    const id = s().newTab();
    s().requestClose(id);
    expect(s().tabs.some((t) => t.id === id)).toBe(false);
  });

  it("reorders tabs", () => {
    const b = s().newTab();
    const c = s().newTab();
    s().move(c, "t1");
    expect(s().tabs.map((t) => t.id)).toEqual([c, "t1", b]);
    s().move(c, c);
    s().move("x", c);
    expect(s().tabs.map((t) => t.id)).toEqual([c, "t1", b]);
  });

  it("tracks sends, results and saves", () => {
    s().setSending("t1", "s1");
    expect(activeTab().sendId).toBe("s1");
    s().setResult("t1", result);
    expect(activeTab().sendId).toBeNull();
    expect(activeTab().result).toBe(result);
    const saved = { ...emptyRequest(), id: "r9", name: "Saved", url: "u" };
    s().markSaved("t1", saved, "c2");
    expect(activeTab().saved).toEqual(saved);
    expect(activeTab().collectionId).toBe("c2");
    s().markSaved("t1", saved);
    expect(activeTab().collectionId).toBe("c2");
  });

  it("opens and closes the save dialog", () => {
    s().openSaveDialog("t1");
    expect(s().saveDialog).toEqual({ tabId: "t1", closeAfter: false });
    s().closeSaveDialog();
    expect(s().saveDialog).toBeNull();
  });

  it("persists tabs without results and restores them", async () => {
    s().updateRequest("t1", (r) => ({ ...r, url: "https://persist.dev", query: null as never }));
    s().setResult("t1", result);
    const stored = localStorage.getItem("pakpos-tabs")!;
    const raw = JSON.parse(stored);
    expect(raw.state.tabs[0].result).toBeNull();
    expect(raw.state.tabs[0].request.url).toBe("https://persist.dev");

    resetTabs({}, { id: "other" });
    localStorage.setItem("pakpos-tabs", stored);
    await useTabsStore.persist.rehydrate();
    expect(s().tabs[0].request.url).toBe("https://persist.dev");
    expect(s().tabs[0].request.query).toEqual([]);
    expect(s().activeId).toBe("t1");
  });

  it("keeps the current state when nothing is persisted", async () => {
    localStorage.setItem("pakpos-tabs", JSON.stringify({ state: { tabs: [] }, version: 1 }));
    await useTabsStore.persist.rehydrate();
    expect(s().tabs[0].id).toBe("t1");
  });

  it("survives storage that throws", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const rm = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await useTabsStore.persist.rehydrate();
    s().newTab();
    await useTabsStore.persist.clearStorage();
    expect(s().tabs.length).toBeGreaterThan(0);
    spy.mockRestore();
    set.mockRestore();
    rm.mockRestore();
  });
});

describe("tabs: workspace sync helpers", () => {
  const base = () => ({ ...emptyRequest(), id: "r1", name: "Get user", url: "https://a" });

  it("openSaved records the workspace, markSaved can set it", () => {
    resetTabs();
    const id = useTabsStore.getState().openSaved(base(), "c1", "w1");
    expect(useTabsStore.getState().tabs.find((t) => t.id === id)?.workspaceId).toBe("w1");
    useTabsStore.getState().markSaved(id, base(), undefined, "w2");
    expect(useTabsStore.getState().tabs.find((t) => t.id === id)).toMatchObject({
      workspaceId: "w2",
      collectionId: "c1",
    });
  });

  it("detach turns a saved tab into an unsaved request", () => {
    resetTabs(base(), { saved: base(), collectionId: "c1", workspaceId: "w1" });
    useTabsStore.getState().detach("t1");
    expect(activeTab()).toMatchObject({ saved: null, collectionId: "", workspaceId: "" });
    expect(activeTab().request.id).toBe("");
    expect(activeTab().request.url).toBe("https://a");
  });

  it("applyDiskVersion replaces a clean tab and keeps edits on a dirty one", () => {
    const disk = { ...base(), url: "https://disk" };
    resetTabs(base(), { saved: base() });
    useTabsStore.getState().applyDiskVersion("t1", disk, "c2");
    expect(activeTab().request.url).toBe("https://disk");
    expect(activeTab().collectionId).toBe("c2");

    resetTabs({ ...base(), url: "https://edited" }, { saved: base() });
    useTabsStore.getState().applyDiskVersion("t1", disk, "c2");
    expect(activeTab().request.url).toBe("https://edited");
    expect(activeTab().saved?.url).toBe("https://disk");
  });

  it("renameSaved renames both copies; ignores unsaved tabs", () => {
    resetTabs(base(), { saved: base() });
    useTabsStore.getState().renameSaved("t1", "Fetch user");
    expect(activeTab().request.name).toBe("Fetch user");
    expect(activeTab().saved?.name).toBe("Fetch user");

    resetTabs(base());
    useTabsStore.getState().renameSaved("t1", "X");
    expect(activeTab().request.name).toBe("Get user");
  });
});
