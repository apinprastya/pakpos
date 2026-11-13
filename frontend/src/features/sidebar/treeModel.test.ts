import type { CollectionNode } from "@/lib/model";
import {
  colKey,
  filterTree,
  findCollectionOf,
  isColKey,
  keyId,
  moveRequestOver,
  positionOf,
  reorder,
  reqKey,
  visibleItems,
} from "./treeModel";

const req = (id: string, name = id, method = "GET", url = `https://api/${id}`) => ({
  id,
  name,
  method,
  url,
  seq: 0,
});
const tree = (): CollectionNode[] => [
  { id: "a", name: "Users", seq: 1, requests: [req("a1", "List users"), req("a2", "Create user", "POST")] },
  { id: "b", name: "Orders", seq: 2, requests: [req("b1", "Get order", "GET", "https://shop/orders/1")] },
  { id: "c", name: "Empty", seq: 3, requests: [] },
];
const ids = (cols: CollectionNode[]) => cols.map((c) => `${c.id}:${c.requests.map((r) => r.id).join(",")}`);

describe("tree keys", () => {
  it("round-trips ids", () => {
    expect(isColKey(colKey("x"))).toBe(true);
    expect(isColKey(reqKey("x"))).toBe(false);
    expect(keyId(reqKey("abc"))).toBe("abc");
  });
});

describe("filterTree", () => {
  it("returns everything for an empty query", () => {
    const t = tree();
    expect(filterTree(t, "  ")).toBe(t);
  });
  it("matches request name, URL and exact method; collection names keep all requests", () => {
    expect(ids(filterTree(tree(), "create"))).toEqual(["a:a2"]);
    expect(ids(filterTree(tree(), "shop/orders"))).toEqual(["b:b1"]);
    expect(ids(filterTree(tree(), "post"))).toEqual(["a:a2"]);
    expect(ids(filterTree(tree(), "users"))).toEqual(["a:a1,a2"]);
    expect(filterTree(tree(), "nothing")).toEqual([]);
  });
});

describe("visibleItems", () => {
  it("skips requests of collapsed collections", () => {
    const items = visibleItems(tree(), (id) => id !== "b");
    expect(items.map((i) => i.key)).toEqual(["c:a", "r:a1", "r:a2", "c:b", "c:c"]);
    expect(items[1]).toEqual({ key: "r:a1", level: 2, parent: "c:a" });
  });
});

describe("reorder and positions", () => {
  it("reorder moves active into over's place and ignores unknown ids", () => {
    expect(reorder(["x", "y", "z"], "x", "z")).toEqual(["y", "z", "x"]);
    expect(reorder(["x", "y"], "x", "x")).toEqual(["x", "y"]);
    expect(reorder(["x", "y"], "q", "x")).toEqual(["x", "y"]);
  });
  it("positionOf and findCollectionOf", () => {
    expect(positionOf(tree(), "a2")).toEqual({ collectionId: "a", index: 1 });
    expect(positionOf(tree(), "zz")).toBeNull();
    expect(findCollectionOf(tree(), "b1")?.id).toBe("b");
  });
});

describe("moveRequestOver", () => {
  it("reorders within a collection", () => {
    expect(ids(moveRequestOver(tree(), "a1", reqKey("a2")))).toEqual(["a:a2,a1", "b:b1", "c:"]);
  });
  it("leaves order alone when dropped on its own collection header", () => {
    const t = tree();
    expect(moveRequestOver(t, "a1", colKey("a"))).toBe(t);
  });
  it("moves into another collection before the request it is over", () => {
    expect(ids(moveRequestOver(tree(), "a1", reqKey("b1")))).toEqual(["a:a2", "b:a1,b1", "c:"]);
  });
  it("moves to the end of a collection when over its header", () => {
    expect(ids(moveRequestOver(tree(), "a1", colKey("c")))).toEqual(["a:a2", "b:b1", "c:a1"]);
    expect(ids(moveRequestOver(tree(), "b1", colKey("a")))).toEqual(["a:a1,a2,b1", "b:", "c:"]);
  });
  it("ignores unknown requests or targets", () => {
    const t = tree();
    expect(moveRequestOver(t, "nope", reqKey("a1"))).toBe(t);
    expect(moveRequestOver(t, "a1", reqKey("nope"))).toBe(t);
  });
});
