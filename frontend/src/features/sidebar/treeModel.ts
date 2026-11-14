import type { CollectionNode, RequestSummary, TreeChild, TreeNode } from "@/lib/model";
import { ancestorsOf, findContainer, isWithinFolder } from "@/lib/tree";

/* ---------- keys ---------- */

/** Tree and drag-and-drop ids: one namespace for collections, folders and requests. */
export const colKey = (id: string) => `c:${id}`;
export const folderKey = (id: string) => `f:${id}`;
export const reqKey = (id: string) => `r:${id}`;
export const keyId = (key: string) => key.slice(2);
export const isColKey = (key: string) => key.startsWith("c:");

const prefixes = { collection: "c:", folder: "f:", request: "r:" } as const;

export function nodeKey(node: TreeNode): string {
  return prefixes[node.kind] + node.id;
}

export function keyKind(key: string): TreeNode["kind"] {
  if (key.startsWith("f:")) return "folder";
  if (key.startsWith("r:")) return "request";
  return "collection";
}

/* ---------- filter ---------- */

/**
 * Keeps what matches the query and the folders and collections leading to it.
 * A request matches on name, URL or exact method; a collection or folder whose
 * name matches keeps everything inside it.
 */
export function filterTree(collections: CollectionNode[], query: string): CollectionNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return collections;
  const nameMatches = (n: { name: string }) => n.name.toLowerCase().includes(q);
  const requestMatches = (r: RequestSummary) =>
    nameMatches(r) || r.url.toLowerCase().includes(q) || r.method.toLowerCase() === q;
  const filterChildren = (children: TreeChild[]): TreeChild[] => {
    const out: TreeChild[] = [];
    for (const c of children) {
      if (c.kind === "request") {
        if (requestMatches(c)) out.push(c);
      } else if (nameMatches(c)) {
        out.push(c);
      } else {
        const kept = filterChildren(c.children);
        if (kept.length) out.push({ ...c, children: kept });
      }
    }
    return out;
  };
  const out: CollectionNode[] = [];
  for (const c of collections) {
    if (nameMatches(c)) {
      out.push(c);
      continue;
    }
    const kept = filterChildren(c.children);
    if (kept.length) out.push({ ...c, children: kept });
  }
  return out;
}

/* ---------- visible rows ---------- */

export interface VisibleItem {
  key: string;
  node: TreeNode;
  /** aria-level: 1 for collections. */
  level: number;
  /** Key of the collection or folder holding it; null for collections. */
  parent: string | null;
  /** 1-based position among its siblings, and how many siblings there are. */
  posInSet: number;
  setSize: number;
}

/** Tree rows in display order, skipping what's inside collapsed collections and folders. */
export function visibleItems(
  collections: CollectionNode[],
  isExpanded: (key: string) => boolean,
): VisibleItem[] {
  const items: VisibleItem[] = [];
  const visit = (nodes: TreeNode[], level: number, parent: string | null) => {
    nodes.forEach((node, i) => {
      const key = nodeKey(node);
      items.push({ key, node, level, parent, posInSet: i + 1, setSize: nodes.length });
      if (node.kind !== "request" && isExpanded(key)) visit(node.children, level + 1, key);
    });
  };
  visit(collections, 1, null);
  return items;
}

/* ---------- expand state ---------- */

/**
 * Which collections are collapsed and which folders are expanded, by tree key.
 * Collections start expanded and folders start collapsed, so only the
 * exceptions are stored.
 */
export interface ExpandState {
  collapsed: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
}

export const emptyExpandState: ExpandState = { collapsed: new Set(), expanded: new Set() };

export function isExpandedIn(state: ExpandState, key: string): boolean {
  return isColKey(key) ? !state.collapsed.has(key) : state.expanded.has(key);
}

export function withExpanded(state: ExpandState, key: string, expanded: boolean): ExpandState {
  if (isExpandedIn(state, key) === expanded) return state;
  const toggle = (set: ReadonlySet<string>, add: boolean) => {
    const next = new Set(set);
    if (add) next.add(key);
    else next.delete(key);
    return next;
  };
  return isColKey(key)
    ? { ...state, collapsed: toggle(state.collapsed, !expanded) }
    : { ...state, expanded: toggle(state.expanded, expanded) };
}

const stringsOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Reads stored expand state. `legacy` is the Tier 1 format: an array of
 * collapsed collection ids.
 */
export function parseExpandState(stored: unknown, legacy?: unknown): ExpandState {
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const s = stored as { collapsed?: unknown; expanded?: unknown };
    return { collapsed: new Set(stringsOf(s.collapsed)), expanded: new Set(stringsOf(s.expanded)) };
  }
  return { collapsed: new Set(stringsOf(legacy).map(colKey)), expanded: new Set() };
}

export function serializeExpandState(state: ExpandState): { collapsed: string[]; expanded: string[] } {
  return { collapsed: [...state.collapsed], expanded: [...state.expanded] };
}

/* ---------- drag and drop ---------- */

export type DropPosition = "before" | "after" | "inside";

/**
 * Where a drop lands relative to the row under the pointer. Collections take
 * items inside and other collections before or after; folders take the top
 * and bottom quarter as before/after and the middle as inside; requests
 * split in half. Without a pointer position, containers take it inside.
 */
export function dropPosition(
  activeKind: TreeNode["kind"],
  overKind: TreeNode["kind"],
  pointerY: number | null,
  rect: { top: number; height: number },
): DropPosition {
  const rel = pointerY === null || rect.height <= 0 ? null : (pointerY - rect.top) / rect.height;
  if (activeKind === "collection") return rel !== null && rel < 0.5 ? "before" : "after";
  if (overKind === "collection") return "inside";
  if (rel === null) return overKind === "folder" ? "inside" : "after";
  if (overKind === "request") return rel < 0.5 ? "before" : "after";
  if (rel < 0.25) return "before";
  if (rel > 0.75) return "after";
  return "inside";
}

export interface DropTarget {
  parentId: string;
  /** Index among the target's children, not counting the moved item. */
  index: number;
}

/**
 * Where a dragged folder or request ends up when dropped on `overKey` at
 * `position`, or null when the drop isn't allowed: onto itself, or a folder
 * into itself or one of its subfolders.
 */
export function dropTarget(
  collections: CollectionNode[],
  activeKey: string,
  overKey: string,
  position: DropPosition,
): DropTarget | null {
  const activeKind = keyKind(activeKey);
  const overKind = keyKind(overKey);
  if (activeKind === "collection" || activeKey === overKey) return null;
  const activeId = keyId(activeKey);
  const others = (children: TreeChild[]) =>
    children.filter((c) => !(c.kind === activeKind && c.id === activeId));

  let parentId: string;
  let index: number;
  if (position === "inside" || overKind === "collection") {
    const target = overKind === "request" ? undefined : findContainer(collections, keyId(overKey));
    if (!target) return null;
    parentId = target.id;
    index = others(target.children).length;
  } else {
    const parent = ancestorsOf(collections, overKind, keyId(overKey)).at(-1);
    if (!parent) return null;
    const siblings = others(parent.children);
    const at = siblings.findIndex((c) => c.kind === overKind && c.id === keyId(overKey));
    parentId = parent.id;
    index = position === "before" ? at : at + 1;
  }
  if (activeKind === "folder" && isWithinFolder(collections, parentId, activeId)) return null;
  return { parentId, index };
}

/** New collection order when collection `activeKey` is dropped before or after `overKey`. */
export function collectionOrder(
  collections: CollectionNode[],
  activeKey: string,
  overKey: string,
  position: DropPosition,
): string[] | null {
  if (!isColKey(activeKey) || !isColKey(overKey) || activeKey === overKey) return null;
  const ids = collections.map((c) => c.id).filter((id) => id !== keyId(activeKey));
  const at = ids.indexOf(keyId(overKey));
  if (at < 0 || !collections.some((c) => c.id === keyId(activeKey))) return null;
  ids.splice(position === "before" ? at : at + 1, 0, keyId(activeKey));
  return ids;
}

/** Keys of a node and everything inside it (a dragged folder can't be dropped there). */
export function subtreeKeys(node: TreeNode): Set<string> {
  const out = new Set<string>();
  const visit = (n: TreeNode) => {
    out.add(nodeKey(n));
    if (n.kind !== "request") n.children.forEach(visit);
  };
  visit(node);
  return out;
}
