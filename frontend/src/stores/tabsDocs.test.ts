import { emptyAuth } from "@/lib/model";
import { makeVar } from "@/test/fixtures";
import { resetTabs } from "@/test/store";
import {
  compactDraft,
  draftsEqual,
  emptyDocDraft,
  isDirty,
  tabTitle,
  useTabsStore,
  type DocDraft,
} from "./tabs";

const s = () => useTabsStore.getState();
const draft = (vars = [makeVar("a", "1")]): DocDraft => ({ ...emptyDocDraft(), variables: vars });
const doc = (id: string) => s().tabs.find((t) => t.id === id)!;

beforeEach(() => resetTabs());

describe("tabs store: environment and settings tabs", () => {
  it("opens one tab per target and workspace, focusing an open one", () => {
    const a = s().openDoc("environment", "e1", "Dev", "w1");
    expect(s().activeId).toBe(a);
    s().activate("t1");
    expect(s().openDoc("environment", "e1", "Dev", "w1")).toBe(a);
    expect(s().activeId).toBe(a);
    expect(s().openDoc("environment", "e1", "Dev", "w2")).not.toBe(a);
    expect(s().openDoc("globals", "", "Globals", "")).not.toBe(a);
    expect(doc(a).doc).toMatchObject({
      kind: "environment",
      targetId: "e1",
      draft: null,
      saved: null,
      missing: false,
    });
  });

  it("tracks a draft against its saved copy", () => {
    const id = s().openDoc("collection", "c1", "Users", "w1");
    expect(isDirty(doc(id))).toBe(false); // not loaded yet
    s().updateDoc(id, (d) => ({ ...d, headers: [] })); // ignored until loaded
    expect(doc(id).doc!.draft).toBeNull();

    s().markDocSaved(id, draft(), "Users API");
    expect(doc(id).doc!.name).toBe("Users API");
    expect(isDirty(doc(id))).toBe(false);
    s().updateDoc(id, (d) => ({ ...d, variables: [...d.variables, makeVar("", "")] }));
    expect(isDirty(doc(id))).toBe(false); // a blank row is not a change
    s().updateDoc(id, (d) => ({ ...d, variables: [makeVar("a", "2")] }));
    expect(isDirty(doc(id))).toBe(true);

    s().setDocSaved(id, draft([makeVar("a", "2")]));
    expect(isDirty(doc(id))).toBe(false);
    s().patchDoc(id, { missing: true, name: "Renamed" });
    expect(doc(id).doc).toMatchObject({ missing: true, name: "Renamed" });
    s().markDocSaved(id, draft());
    expect(doc(id).doc).toMatchObject({ missing: false, name: "Renamed" });
  });

  it("applies the disk version to a clean tab and keeps edits on a dirty one", () => {
    const id = s().openDoc("environment", "e1", "Dev", "w1");
    s().markDocSaved(id, draft());
    s().applyDocDisk(id, draft([makeVar("a", "disk")]));
    expect(doc(id).doc!.draft!.variables[0].value).toBe("disk");

    s().updateDoc(id, () => draft([makeVar("a", "mine")]));
    s().applyDocDisk(id, draft([makeVar("a", "disk2")]));
    expect(doc(id).doc!.draft!.variables[0].value).toBe("mine");
    expect(doc(id).doc!.saved!.variables[0].value).toBe("disk2");
    s().applyDocDisk("t1", draft()); // a request tab is left alone
    expect(doc("t1").doc).toBeNull();
  });

  it("titles tabs by kind", () => {
    const t = (kind: string, name: string) =>
      tabTitle(doc(s().openDoc(kind as never, `${kind}-${name}`, name, "w")));
    expect(t("environment", "Dev")).toBe("Dev");
    expect(t("environment", "")).toBe("Environment");
    expect(t("globals", "x")).toBe("Globals");
    expect(t("collection", "Users")).toBe("Users settings");
    expect(t("folder", "")).toBe("Folder settings");
    expect(t("collection", "")).toBe("Collection settings");
  });

  it("compares drafts without blank rows", () => {
    const a = { auth: emptyAuth(), headers: [{ key: "", value: "", enabled: true }], variables: [] };
    expect(compactDraft(a).headers).toEqual([]);
    const renamed = {
      ...emptyDocDraft(),
      variables: [{ ...makeVar("b", "", { secret: true }), origin: "b" }],
    };
    expect(compactDraft(renamed).variables[0]).toEqual(makeVar("b", "", { secret: true }));
    expect(
      draftsEqual(renamed, { ...emptyDocDraft(), variables: [makeVar("b", "", { secret: true })] }),
    ).toBe(true);
    expect(draftsEqual(a, emptyDocDraft())).toBe(true);
  });

  it("persists doc tabs and restores them; unknown kinds become request tabs", async () => {
    const id = s().openDoc("environment", "e1", "Dev", "w1");
    s().markDocSaved(id, draft());
    s().updateDoc(id, () => draft([makeVar("a", "edited")]));
    const stored = localStorage.getItem("pakpos-tabs")!;
    resetTabs();
    localStorage.setItem("pakpos-tabs", stored);
    await useTabsStore.persist.rehydrate();
    const restored = s().tabs.find((t) => t.doc)!;
    expect(restored.doc).toMatchObject({ kind: "environment", targetId: "e1", name: "Dev" });
    expect(restored.doc!.draft!.variables[0].value).toBe("edited");
    expect(isDirty(restored)).toBe(true);

    const raw = JSON.parse(stored);
    raw.state.tabs = [
      { ...raw.state.tabs[0], doc: { kind: "bogus" } },
      { ...raw.state.tabs[1], id: "x", doc: { kind: "folder", targetId: "f1", draft: { variables: null } } },
    ];
    localStorage.setItem("pakpos-tabs", JSON.stringify(raw));
    await useTabsStore.persist.rehydrate();
    expect(s().tabs[0].doc).toBeNull();
    // A draft without its saved copy is reloaded from disk.
    expect(s().tabs[1].doc).toMatchObject({
      kind: "folder",
      targetId: "f1",
      name: "",
      draft: null,
      saved: null,
    });
  });

  it("restores partial drafts with defaults", async () => {
    const id = s().openDoc("folder", "f1", "Admin", "w1");
    s().markDocSaved(id, draft());
    const raw = JSON.parse(localStorage.getItem("pakpos-tabs")!);
    const t = raw.state.tabs.find((x: { doc: unknown }) => x.doc);
    t.doc.draft = { headers: "bad" };
    t.doc.saved = { auth: { type: "basic" } };
    localStorage.setItem("pakpos-tabs", JSON.stringify(raw));
    await useTabsStore.persist.rehydrate();
    const restored = s().tabs.find((x) => x.doc)!.doc!;
    expect(restored.draft).toEqual({ auth: emptyAuth(), headers: [], variables: [] });
    expect(restored.saved!.auth.type).toBe("basic");
  });
});
