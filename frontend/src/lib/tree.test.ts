import type { CollectionNode, TreeNode } from "@/lib/model";
import { col, folder, req } from "@/test/fixtures";
import {
  ancestorsOf,
  countRequests,
  destinations,
  findContainer,
  findNode,
  findRequest,
  isWithinFolder,
  moveChild,
  positionOf,
  requestIds,
  requestParents,
  walkTree,
} from "./tree";

// Users[ list, Auth[ login, Tokens[ refresh ] ], create ]  Orders[ get ]  Empty[]
const tree = (): CollectionNode[] => [
  col("a", "Users", [
    req("list"),
    folder("auth", "Auth", [req("login"), folder("tokens", "Tokens", [req("refresh")])]),
    req("create", "create", "POST"),
  ]),
  col("b", "Orders", [req("get")]),
  col("c", "Empty"),
];

/** "a[list auth[login tokens[refresh]] create] b[get] c[]" */
function shape(nodes: TreeNode[]): string {
  return nodes.map((n) => (n.kind === "request" ? n.id : `${n.id}[${shape(n.children)}]`)).join(" ");
}

describe("walking and finding", () => {
  it("walks in display order with depth and parent", () => {
    const rows = [...walkTree(tree())].map(
      ({ node, parent, depth }) => `${node.id}:${depth}:${parent?.id ?? "-"}`,
    );
    expect(rows).toEqual([
      "a:0:-",
      "list:1:a",
      "auth:1:a",
      "login:2:auth",
      "tokens:2:auth",
      "refresh:3:tokens",
      "create:1:a",
      "b:0:-",
      "get:1:b",
      "c:0:-",
    ]);
  });

  it("finds nodes, containers and requests", () => {
    const t = tree();
    expect(findNode(t, "tokens")?.kind).toBe("folder");
    expect(findNode(t, "tokens", "request")).toBeUndefined();
    expect(findContainer(t, "b")?.name).toBe("Orders");
    expect(findContainer(t, "list")).toBeUndefined();
    expect(findRequest(t, "refresh")?.parentId).toBe("tokens");
    expect(findRequest(t, "auth")).toBeUndefined();
  });

  it("positions, parents, request ids and counts", () => {
    const t = tree();
    expect(positionOf(t, "folder", "auth")).toEqual({ parentId: "a", index: 1 });
    expect(positionOf(t, "request", "refresh")).toEqual({ parentId: "tokens", index: 0 });
    expect(positionOf(t, "request", "nope")).toBeNull();
    expect(positionOf(t, "request", "a")).toBeNull(); // collections have no position
    expect(requestParents(t).get("login")).toBe("auth");
    expect(requestParents(t).size).toBe(5);
    expect(requestIds(t[0])).toEqual(["list", "login", "refresh", "create"]);
    expect(requestIds(req("x"))).toEqual(["x"]);
    expect(countRequests(t[0].children[1])).toBe(2);
    expect(countRequests(t[2])).toBe(0);
  });

  it("isWithinFolder and ancestorsOf", () => {
    const t = tree();
    expect(isWithinFolder(t, "auth", "auth")).toBe(true);
    expect(isWithinFolder(t, "tokens", "auth")).toBe(true);
    expect(isWithinFolder(t, "a", "auth")).toBe(false);
    expect(isWithinFolder(t, "auth", "tokens")).toBe(false);
    expect(isWithinFolder(t, "auth", "missing")).toBe(false);
    expect(ancestorsOf(t, "request", "refresh").map((n) => n.id)).toEqual(["a", "auth", "tokens"]);
    expect(ancestorsOf(t, "folder", "auth").map((n) => n.id)).toEqual(["a"]);
    expect(ancestorsOf(t, "collection", "b")).toEqual([]);
    expect(ancestorsOf(t, "request", "missing")).toEqual([]);
  });
});

describe("moveChild", () => {
  it("moves a request into a folder at an index, updating its parent", () => {
    const out = moveChild(tree(), "request", "list", "tokens", 0);
    expect(shape(out)).toBe("a[auth[login tokens[list refresh]] create] b[get] c[]");
    expect(findRequest(out, "list")?.parentId).toBe("tokens");
  });

  it("reorders within the parent and clamps the index", () => {
    expect(shape(moveChild(tree(), "request", "list", "a", 99))).toBe(
      "a[auth[login tokens[refresh]] create list] b[get] c[]",
    );
    expect(shape(moveChild(tree(), "request", "create", "a", -3))).toBe(
      "a[create list auth[login tokens[refresh]]] b[get] c[]",
    );
  });

  it("moves folders with their subtree across collections", () => {
    const out = moveChild(tree(), "folder", "auth", "c", 0);
    expect(shape(out)).toBe("a[list create] b[get] c[auth[login tokens[refresh]]]");
    expect(findContainer(out, "auth")?.kind).toBe("folder");
  });

  it("leaves the tree alone for unknown items, unknown targets, or a folder into itself", () => {
    const t = tree();
    expect(moveChild(t, "request", "nope", "a", 0)).toBe(t);
    expect(moveChild(t, "request", "list", "nope", 0)).toBe(t);
    expect(moveChild(t, "folder", "auth", "tokens", 0)).toBe(t);
    expect(moveChild(t, "folder", "auth", "auth", 0)).toBe(t);
  });
});

describe("destinations", () => {
  it("lists collections and folders nested, with paths", () => {
    expect(destinations(tree())).toEqual([
      { id: "a", kind: "collection", name: "Users", depth: 0, path: "Users" },
      { id: "auth", kind: "folder", name: "Auth", depth: 1, path: "Users / Auth" },
      { id: "tokens", kind: "folder", name: "Tokens", depth: 2, path: "Users / Auth / Tokens" },
      { id: "b", kind: "collection", name: "Orders", depth: 0, path: "Orders" },
      { id: "c", kind: "collection", name: "Empty", depth: 0, path: "Empty" },
    ]);
  });

  it("leaves out an excluded folder and its subtree", () => {
    expect(destinations(tree(), "auth").map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(destinations(tree(), "tokens").map((d) => d.id)).toEqual(["a", "auth", "b", "c"]);
  });
});
