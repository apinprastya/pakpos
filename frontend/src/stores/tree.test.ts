import { col, folder, req } from "@/test/fixtures";
import { useLayoutStore } from "@/stores/layout";
import { readExpandState, useTreeStore } from "@/stores/tree";
import { useWorkspaceStore } from "@/stores/workspace";
import { isExpandedIn } from "@/features/sidebar/treeModel";

const ws = { id: "w1", name: "Shop", path: "/shop" };
const tree = [
  col("c1", "Users", [
    folder("f1", "Admin", [folder("f2", "Deep", [req("r1", "Nested")])]),
    req("r2", "Top"),
  ]),
];

const expanded = (key: string) =>
  isExpandedIn(useTreeStore.getState().states.w1 ?? readExpandState("w1"), key);

beforeEach(() => {
  useWorkspaceStore.setState({ status: "ready", workspace: ws, collections: tree });
  useLayoutStore.setState({ sidebarView: "collections" });
});

describe("tree store", () => {
  it("remembers expand state per workspace in localStorage", () => {
    useTreeStore.getState().setExpanded("w1", "f:f1", true);
    expect(expanded("f:f1")).toBe(true);
    expect(JSON.parse(localStorage.getItem("pakpos-tree:w1")!)).toEqual({
      collapsed: [],
      expanded: ["f:f1"],
    });
    // No change, no write.
    const before = useTreeStore.getState().states;
    useTreeStore.getState().setExpanded("w1", "f:f1", true);
    expect(useTreeStore.getState().states).toBe(before);
    useTreeStore.getState().setExpanded("w1", "c:c1", false);
    expect(expanded("c:c1")).toBe(false);
  });

  it("reads the Tier 1 format and tolerates bad or blocked storage", () => {
    localStorage.setItem("pakpos-tree-collapsed:w9", JSON.stringify(["c1"]));
    expect(readExpandState("w9").collapsed.has("c:c1")).toBe(true);
    localStorage.setItem("pakpos-tree:w8", "{bad");
    expect(readExpandState("w8").collapsed.size).toBe(0);
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readExpandState("w1").expanded.size).toBe(0);
    get.mockRestore();
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    useTreeStore.getState().setExpanded("w1", "f:f2", true);
    expect(expanded("f:f2")).toBe(true);
    set.mockRestore();
  });

  it("reveals a request: expands its ancestors and asks the tree to focus it", () => {
    useTreeStore.getState().setExpanded("w1", "c:c1", false);
    expect(useTreeStore.getState().revealInTree("r1")).toBe(true);
    expect(expanded("c:c1")).toBe(true);
    expect(expanded("f:f1")).toBe(true);
    expect(expanded("f:f2")).toBe(true);
    const reveal = useTreeStore.getState().reveal!;
    expect(reveal).toMatchObject({ key: "r:r1", focus: true });

    // A second reveal of the same row is a new request.
    useTreeStore.getState().revealInTree("r1");
    expect(useTreeStore.getState().reveal!.nonce).not.toBe(reveal.nonce);
    useTreeStore.getState().revealDone(reveal.nonce); // stale: ignored
    expect(useTreeStore.getState().reveal).not.toBeNull();
    useTreeStore.getState().revealDone(useTreeStore.getState().reveal!.nonce);
    expect(useTreeStore.getState().reveal).toBeNull();
  });

  it("expands a revealed folder itself; focuses only when the tree is showing", () => {
    useLayoutStore.setState({ sidebarView: "history" });
    useTreeStore.getState().revealInTree("f1");
    expect(expanded("f:f1")).toBe(true);
    expect(useTreeStore.getState().reveal).toMatchObject({ key: "f:f1", focus: false });
    expect(useLayoutStore.getState().sidebarView).toBe("history");

    useTreeStore.getState().revealInTree("c1", { show: true });
    expect(useLayoutStore.getState().sidebarView).toBe("collections");
    expect(useTreeStore.getState().reveal).toMatchObject({ key: "c:c1", focus: true });
  });

  it("does nothing for unknown ids or without a workspace", () => {
    expect(useTreeStore.getState().revealInTree("nope")).toBe(false);
    useWorkspaceStore.setState({ workspace: null });
    expect(useTreeStore.getState().revealInTree("r1")).toBe(false);
    expect(useTreeStore.getState().reveal).toBeNull();
  });
});
