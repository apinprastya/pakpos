import type { CollectionNode, TreeNode } from "@/lib/model";
import { col, folder, req } from "@/test/fixtures";
import {
  colKey,
  collectionOrder,
  dropPosition,
  dropTarget,
  emptyExpandState,
  filterTree,
  folderKey,
  isColKey,
  isExpandedIn,
  keyId,
  keyKind,
  nodeKey,
  parseExpandState,
  reqKey,
  serializeExpandState,
  subtreeKeys,
  visibleItems,
  withExpanded,
} from "./treeModel";

// Users[ a1 "List users", Auth[ login, Tokens[ refresh ] ], a2 "Create user" POST ]
// Orders[ b1 "Get order" ]  Empty[]
const tree = (): CollectionNode[] => [
  col("a", "Users", [
    req("a1", "List users"),
    folder("auth", "Auth", [req("login", "Log in"), folder("tokens", "Tokens", [req("refresh", "Refresh")])]),
    req("a2", "Create user", "POST"),
  ]),
  col("b", "Orders", [req("b1", "Get order", "GET", "https://shop/orders/1")]),
  col("c", "Empty"),
];

function shape(nodes: TreeNode[]): string {
  return nodes.map((n) => (n.kind === "request" ? n.id : `${n.id}[${shape(n.children)}]`)).join(" ");
}

describe("tree keys", () => {
  it("round-trips ids and kinds", () => {
    expect(isColKey(colKey("x"))).toBe(true);
    expect(isColKey(reqKey("x"))).toBe(false);
    expect(keyId(folderKey("abc"))).toBe("abc");
    expect([keyKind("c:x"), keyKind("f:x"), keyKind("r:x")]).toEqual(["collection", "folder", "request"]);
    expect(nodeKey(tree()[0].children[1])).toBe("f:auth");
  });

  it("subtreeKeys covers a node and everything inside it", () => {
    expect([...subtreeKeys(tree()[0].children[1])]).toEqual(["f:auth", "r:login", "f:tokens", "r:refresh"]);
    expect([...subtreeKeys(req("x"))]).toEqual(["r:x"]);
  });
});

describe("filterTree", () => {
  it("returns everything for an empty query", () => {
    const t = tree();
    expect(filterTree(t, "  ")).toBe(t);
  });

  it("matches request name, URL and exact method, keeping the folders on the way", () => {
    expect(shape(filterTree(tree(), "create"))).toBe("a[a2]");
    expect(shape(filterTree(tree(), "shop/orders"))).toBe("b[b1]");
    expect(shape(filterTree(tree(), "post"))).toBe("a[a2]");
    expect(shape(filterTree(tree(), "refresh"))).toBe("a[auth[tokens[refresh]]]");
    expect(filterTree(tree(), "nothing")).toEqual([]);
  });

  it("a matching collection or folder name keeps everything inside it", () => {
    expect(shape(filterTree(tree(), "users"))).toBe("a[a1 auth[login tokens[refresh]] a2]");
    expect(shape(filterTree(tree(), "auth"))).toBe("a[auth[login tokens[refresh]]]");
    expect(shape(filterTree(tree(), "tokens"))).toBe("a[auth[tokens[refresh]]]");
  });
});

describe("visibleItems", () => {
  it("lists rows with levels and positions, skipping collapsed collections and folders", () => {
    const open = new Set(["c:a", "f:auth", "c:c"]);
    const items = visibleItems(tree(), (k) => open.has(k));
    expect(items.map((i) => `${i.key}@${i.level}`)).toEqual([
      "c:a@1",
      "r:a1@2",
      "f:auth@2",
      "r:login@3",
      "f:tokens@3",
      "r:a2@2",
      "c:b@1",
      "c:c@1",
    ]);
    const tokens = items.find((i) => i.key === "f:tokens")!;
    expect(tokens).toMatchObject({ parent: "f:auth", posInSet: 2, setSize: 2 });
    expect(items[0]).toMatchObject({ parent: null, posInSet: 1, setSize: 3 });
  });
});

describe("expand state", () => {
  it("collections start expanded and folders collapsed", () => {
    expect(isExpandedIn(emptyExpandState, "c:a")).toBe(true);
    expect(isExpandedIn(emptyExpandState, "f:auth")).toBe(false);
  });

  it("toggles and returns the same state for no-ops", () => {
    let s = withExpanded(emptyExpandState, "c:a", false);
    s = withExpanded(s, "f:auth", true);
    expect(isExpandedIn(s, "c:a")).toBe(false);
    expect(isExpandedIn(s, "f:auth")).toBe(true);
    expect(withExpanded(s, "f:auth", true)).toBe(s);
    s = withExpanded(withExpanded(s, "c:a", true), "f:auth", false);
    expect(serializeExpandState(s)).toEqual({ collapsed: [], expanded: [] });
  });

  it("parses stored state, the Tier 1 format, and junk", () => {
    const stored = parseExpandState({ collapsed: ["c:a", 3], expanded: ["f:x"] });
    expect(serializeExpandState(stored)).toEqual({ collapsed: ["c:a"], expanded: ["f:x"] });
    const legacy = parseExpandState(null, ["a", "b", null]);
    expect(serializeExpandState(legacy)).toEqual({ collapsed: ["c:a", "c:b"], expanded: [] });
    expect(serializeExpandState(parseExpandState({ collapsed: "no" }))).toEqual({
      collapsed: [],
      expanded: [],
    });
    expect(serializeExpandState(parseExpandState(["a"], "junk"))).toEqual({ collapsed: [], expanded: [] });
  });
});

describe("dropPosition", () => {
  const rect = { top: 100, height: 20 };
  it("collections go before or after other collections", () => {
    expect(dropPosition("collection", "collection", 105, rect)).toBe("before");
    expect(dropPosition("collection", "collection", 115, rect)).toBe("after");
    expect(dropPosition("collection", "collection", null, rect)).toBe("after");
  });
  it("items go inside a collection", () => {
    expect(dropPosition("request", "collection", 101, rect)).toBe("inside");
  });
  it("folders split into quarters; requests into halves", () => {
    expect(dropPosition("request", "folder", 102, rect)).toBe("before");
    expect(dropPosition("folder", "folder", 110, rect)).toBe("inside");
    expect(dropPosition("request", "folder", 118, rect)).toBe("after");
    expect(dropPosition("folder", "request", 104, rect)).toBe("before");
    expect(dropPosition("request", "request", 112, rect)).toBe("after");
  });
  it("without a pointer or a size, containers take it inside and requests after", () => {
    expect(dropPosition("request", "folder", null, rect)).toBe("inside");
    expect(dropPosition("request", "request", 110, { top: 0, height: 0 })).toBe("after");
  });
});

describe("dropTarget", () => {
  it("before and after a request, counting siblings without the dragged item", () => {
    expect(dropTarget(tree(), "r:a1", "r:a2", "before")).toEqual({ parentId: "a", index: 1 });
    expect(dropTarget(tree(), "r:a1", "r:a2", "after")).toEqual({ parentId: "a", index: 2 });
    expect(dropTarget(tree(), "r:b1", "r:a1", "before")).toEqual({ parentId: "a", index: 0 });
    expect(dropTarget(tree(), "r:a1", "r:refresh", "after")).toEqual({ parentId: "tokens", index: 1 });
  });

  it("inside a folder or collection goes to its end", () => {
    expect(dropTarget(tree(), "r:a1", "f:tokens", "inside")).toEqual({ parentId: "tokens", index: 1 });
    expect(dropTarget(tree(), "r:a1", "c:b", "inside")).toEqual({ parentId: "b", index: 1 });
    expect(dropTarget(tree(), "r:a1", "c:a", "before")).toEqual({ parentId: "a", index: 2 });
    expect(dropTarget(tree(), "f:tokens", "c:c", "inside")).toEqual({ parentId: "c", index: 0 });
  });

  it("folders can go before or after siblings at any level", () => {
    expect(dropTarget(tree(), "f:tokens", "r:a1", "before")).toEqual({ parentId: "a", index: 0 });
    expect(dropTarget(tree(), "f:auth", "r:b1", "after")).toEqual({ parentId: "b", index: 1 });
  });

  it("rejects drops onto itself, into its own subtree, or nonsense", () => {
    expect(dropTarget(tree(), "r:a1", "r:a1", "after")).toBeNull();
    expect(dropTarget(tree(), "f:auth", "f:tokens", "inside")).toBeNull();
    expect(dropTarget(tree(), "f:auth", "r:refresh", "before")).toBeNull();
    expect(dropTarget(tree(), "f:auth", "r:login", "after")).toBeNull();
    expect(dropTarget(tree(), "c:a", "c:b", "after")).toBeNull();
    expect(dropTarget(tree(), "r:a1", "r:nope", "after")).toBeNull();
    expect(dropTarget(tree(), "r:a1", "f:nope", "inside")).toBeNull();
    expect(dropTarget(tree(), "r:a1", "r:a2", "inside")).toBeNull();
  });
});

describe("collectionOrder", () => {
  it("places the dragged collection before or after the target", () => {
    expect(collectionOrder(tree(), "c:a", "c:b", "after")).toEqual(["b", "a", "c"]);
    expect(collectionOrder(tree(), "c:c", "c:a", "before")).toEqual(["c", "a", "b"]);
  });
  it("ignores items, itself and unknown collections", () => {
    expect(collectionOrder(tree(), "c:a", "c:a", "after")).toBeNull();
    expect(collectionOrder(tree(), "r:a1", "c:a", "after")).toBeNull();
    expect(collectionOrder(tree(), "c:a", "r:a1", "after")).toBeNull();
    expect(collectionOrder(tree(), "c:x", "c:a", "after")).toBeNull();
    expect(collectionOrder(tree(), "c:a", "c:x", "after")).toBeNull();
  });
});
