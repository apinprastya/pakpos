/**
 * Pure helpers over the workspace tree (collections → folders/requests).
 * Used by the workspace store and the sidebar; nothing here touches the api.
 */
import type { CollectionNode, ContainerNode, FolderNode, RequestSummary, TreeChild, TreeNode } from "./model";

export type ChildKind = TreeChild["kind"];

/** Every node in display order, with its parent and depth (collections are depth 0). */
export function* walkTree(
  collections: CollectionNode[],
): Generator<{ node: TreeNode; parent: ContainerNode | null; depth: number }> {
  function* visit(
    node: TreeNode,
    parent: ContainerNode | null,
    depth: number,
  ): Generator<{ node: TreeNode; parent: ContainerNode | null; depth: number }> {
    yield { node, parent, depth };
    if (node.kind !== "request") for (const c of node.children) yield* visit(c, node, depth + 1);
  }
  for (const c of collections) yield* visit(c, null, 0);
}

export function findNode(
  collections: CollectionNode[],
  id: string,
  kind?: TreeNode["kind"],
): TreeNode | undefined {
  for (const { node } of walkTree(collections)) {
    if (node.id === id && (!kind || node.kind === kind)) return node;
  }
  return undefined;
}

/** The collection or folder with this id. */
export function findContainer(collections: CollectionNode[], id: string): ContainerNode | undefined {
  for (const { node } of walkTree(collections)) {
    if (node.id === id && node.kind !== "request") return node;
  }
  return undefined;
}

export function findRequest(collections: CollectionNode[], id: string): RequestSummary | undefined {
  return findNode(collections, id, "request") as RequestSummary | undefined;
}

/** Where a folder or request sits: its parent and index among the parent's children. */
export function positionOf(
  collections: CollectionNode[],
  kind: ChildKind,
  id: string,
): { parentId: string; index: number } | null {
  for (const { node, parent } of walkTree(collections)) {
    if (parent && node.kind === kind && node.id === id) {
      return { parentId: parent.id, index: parent.children.indexOf(node as TreeChild) };
    }
  }
  return null;
}

/** Request id → id of the collection or folder holding it. */
export function requestParents(collections: CollectionNode[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const { node, parent } of walkTree(collections)) {
    if (node.kind === "request" && parent) out.set(node.id, parent.id);
  }
  return out;
}

/** Ids of every request inside a collection or folder, at any depth. */
export function requestIds(node: TreeNode): string[] {
  if (node.kind === "request") return [node.id];
  return node.children.flatMap(requestIds);
}

export function countRequests(node: TreeNode): number {
  return requestIds(node).length;
}

/** Whether `containerId` is the folder `folderId` or somewhere inside it. */
export function isWithinFolder(
  collections: CollectionNode[],
  containerId: string,
  folderId: string,
): boolean {
  const folder = findNode(collections, folderId, "folder") as FolderNode | undefined;
  const contains = (node: FolderNode): boolean =>
    node.id === containerId || node.children.some((c) => c.kind === "folder" && contains(c));
  return !!folder && contains(folder);
}

/** The containers above a node, outermost (the collection) first. */
export function ancestorsOf(
  collections: CollectionNode[],
  kind: TreeNode["kind"],
  id: string,
): ContainerNode[] {
  const path: ContainerNode[] = [];
  function visit(node: TreeNode): boolean {
    if (node.kind === kind && node.id === id) return true;
    if (node.kind === "request") return false;
    path.push(node);
    if (node.children.some(visit)) return true;
    path.pop();
    return false;
  }
  return collections.some(visit) ? path : [];
}

/**
 * Moves a folder or request into `toParentId` at `index` (clamped; the index
 * counts the target's children without the moved node). Returns the input
 * unchanged when the node or target is missing, or when a folder would land
 * inside itself.
 */
export function moveChild(
  collections: CollectionNode[],
  kind: ChildKind,
  id: string,
  toParentId: string,
  index: number,
): CollectionNode[] {
  let moving: TreeChild | undefined;
  const strip = (children: TreeChild[]): TreeChild[] =>
    children
      .filter((c) => {
        if (c.kind === kind && c.id === id) {
          moving = c;
          return false;
        }
        return true;
      })
      .map((c) => (c.kind === "folder" ? { ...c, children: strip(c.children) } : c));
  const stripped = collections.map((c) => ({ ...c, children: strip(c.children) }));
  if (!moving) return collections;

  const placed: TreeChild = { ...moving, parentId: toParentId };
  let found = false;
  const put = (children: TreeChild[], ownerId: string): TreeChild[] => {
    if (ownerId === toParentId) {
      found = true;
      const next = [...children];
      next.splice(Math.max(0, Math.min(index, next.length)), 0, placed);
      return next;
    }
    return children.map((c) => (c.kind === "folder" ? { ...c, children: put(c.children, c.id) } : c));
  };
  // A folder's own subtree was stripped with it, so it can't be found as a target.
  const out = stripped.map((c) => ({ ...c, children: put(c.children, c.id) }));
  return found ? out : collections;
}

/** A collection or folder something can be moved or saved into. */
export interface Destination {
  id: string;
  kind: "collection" | "folder";
  name: string;
  /** 0 for collections, 1 for their folders, and so on. */
  depth: number;
  /** Names from the collection down, e.g. "Users / Auth". */
  path: string;
}

/**
 * Collections and folders in display order. With `exclude`, that folder and
 * everything inside it are left out (a folder can't move into itself).
 */
export function destinations(collections: CollectionNode[], exclude?: string): Destination[] {
  const out: Destination[] = [];
  const visit = (node: ContainerNode, depth: number, path: string) => {
    if (node.kind === "folder" && node.id === exclude) return;
    const p = path ? `${path} / ${node.name}` : node.name;
    out.push({ id: node.id, kind: node.kind, name: node.name, depth, path: p });
    for (const c of node.children) if (c.kind === "folder") visit(c, depth + 1, p);
  };
  for (const c of collections) visit(c, 0, "");
  return out;
}
