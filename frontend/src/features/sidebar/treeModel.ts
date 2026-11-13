import type { CollectionNode, RequestSummary } from "@/lib/model";

/** Ids used by the tree and drag-and-drop: collections and requests share one namespace. */
export const colKey = (id: string) => `c:${id}`;
export const reqKey = (id: string) => `r:${id}`;
export const isColKey = (key: string) => key.startsWith("c:");
export const keyId = (key: string) => key.slice(2);

/** Keeps collections with matches; a collection whose name matches keeps all its requests. */
export function filterTree(collections: CollectionNode[], query: string): CollectionNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return collections;
  const matches = (r: RequestSummary) =>
    r.name.toLowerCase().includes(q) || r.url.toLowerCase().includes(q) || r.method.toLowerCase() === q;
  const out: CollectionNode[] = [];
  for (const c of collections) {
    if (c.name.toLowerCase().includes(q)) {
      out.push(c);
      continue;
    }
    const requests = c.requests.filter(matches);
    if (requests.length) out.push({ ...c, requests });
  }
  return out;
}

export interface VisibleItem {
  key: string;
  level: 1 | 2;
  /** Parent collection key for requests. */
  parent?: string;
}

/** Tree rows in display order, skipping requests inside collapsed collections. */
export function visibleItems(
  collections: CollectionNode[],
  isExpanded: (id: string) => boolean,
): VisibleItem[] {
  const items: VisibleItem[] = [];
  for (const c of collections) {
    items.push({ key: colKey(c.id), level: 1 });
    if (isExpanded(c.id)) {
      for (const r of c.requests) items.push({ key: reqKey(r.id), level: 2, parent: colKey(c.id) });
    }
  }
  return items;
}

export function findCollectionOf(
  collections: CollectionNode[],
  requestId: string,
): CollectionNode | undefined {
  return collections.find((c) => c.requests.some((r) => r.id === requestId));
}

function arrayMove<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Reorders `ids` so `active` takes `over`'s place (sortable semantics). */
export function reorder(ids: string[], active: string, over: string): string[] {
  const from = ids.indexOf(active);
  const to = ids.indexOf(over);
  if (from < 0 || to < 0 || from === to) return ids;
  return arrayMove(ids, from, to);
}

/**
 * Moves request `requestId` relative to `overKey` (a request or collection key).
 * Over a request: takes its position, in its collection. Over a collection: goes to its end.
 */
export function moveRequestOver(
  collections: CollectionNode[],
  requestId: string,
  overKey: string,
): CollectionNode[] {
  const from = findCollectionOf(collections, requestId);
  if (!from) return collections;
  const to = isColKey(overKey)
    ? collections.find((c) => c.id === keyId(overKey))
    : findCollectionOf(collections, keyId(overKey));
  if (!to) return collections;
  const moving = from.requests.find((r) => r.id === requestId)!;

  if (from.id === to.id) {
    if (isColKey(overKey)) return collections;
    const ids = reorder(
      from.requests.map((r) => r.id),
      requestId,
      keyId(overKey),
    );
    const byId = new Map(from.requests.map((r) => [r.id, r]));
    return collections.map((c) =>
      c.id === from.id ? { ...c, requests: ids.map((id) => byId.get(id)!) } : c,
    );
  }

  const target = [...to.requests];
  const overIdx = isColKey(overKey) ? target.length : target.findIndex((r) => r.id === keyId(overKey));
  target.splice(overIdx < 0 ? target.length : overIdx, 0, moving);
  return collections.map((c) => {
    if (c.id === from.id) return { ...c, requests: c.requests.filter((r) => r.id !== requestId) };
    if (c.id === to.id) return { ...c, requests: target };
    return c;
  });
}

/** Where a request sits: its collection and index. */
export function positionOf(
  collections: CollectionNode[],
  requestId: string,
): { collectionId: string; index: number } | null {
  for (const c of collections) {
    const index = c.requests.findIndex((r) => r.id === requestId);
    if (index >= 0) return { collectionId: c.id, index };
  }
  return null;
}
