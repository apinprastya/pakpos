/**
 * Pure search over what the palette can open: requests, folders,
 * collections, environments, the globals, examples and open tabs.
 */
import type { CollectionNode, Environment, ExampleSummary } from "@/lib/model";
import { walkTree } from "@/lib/tree";
import { tabTitle, type Tab } from "@/stores/tabs";

export type SearchKind = "request" | "folder" | "collection" | "environment" | "globals" | "example" | "tab";

export interface SearchItem {
  /** Unique and stable: also the key in the recent list (e.g. "request:<id>"). */
  value: string;
  kind: SearchKind;
  /** What the item is called (for an example: "Example: <name> — <request>"). */
  label: string;
  /** Breadcrumb of the containers, "Users › Auth" ("" for top-level items). */
  path: string;
  /** Requests: method and URL. */
  method?: string;
  url?: string;
  /** The request, folder, collection, environment, example or tab id. */
  id: string;
  /** Examples: the request they belong to. */
  requestId?: string;
}

export const PATH_SEPARATOR = " › ";

export interface SearchSources {
  collections: CollectionNode[];
  environments: Environment[];
  /** False without a workspace: no globals item. */
  hasWorkspace: boolean;
  examples: ExampleSummary[];
  tabs: Tab[];
}

/** Every item the palette can search, in tree order. */
export function buildItems(src: SearchSources): SearchItem[] {
  const items: SearchItem[] = [];
  const requestNames = new Map<string, { name: string; path: string }>();
  const pathOf = new Map<string, string>();
  for (const { node, parent } of walkTree(src.collections)) {
    const parentPath = parent ? (pathOf.get(parent.id) ?? "") : "";
    const path = parentPath && parent ? `${parentPath}${PATH_SEPARATOR}${parent.name}` : (parent?.name ?? "");
    if (node.kind !== "request") pathOf.set(node.id, path);
    if (node.kind === "request") {
      requestNames.set(node.id, { name: node.name, path });
      items.push({
        value: `request:${node.id}`,
        kind: "request",
        label: node.name,
        path,
        method: node.method,
        url: node.url,
        id: node.id,
      });
    } else {
      items.push({ value: `${node.kind}:${node.id}`, kind: node.kind, label: node.name, path, id: node.id });
    }
  }
  if (src.hasWorkspace) items.push({ value: "globals", kind: "globals", label: "Globals", path: "", id: "" });
  for (const e of src.environments) {
    items.push({ value: `environment:${e.id}`, kind: "environment", label: e.name, path: "", id: e.id });
  }
  for (const ex of src.examples) {
    const req = requestNames.get(ex.requestId);
    if (!req) continue;
    items.push({
      value: `example:${ex.id}`,
      kind: "example",
      label: `Example: ${ex.name} — ${req.name}`,
      path: req.path,
      id: ex.id,
      requestId: ex.requestId,
    });
  }
  for (const t of src.tabs) {
    items.push({
      value: `tab:${t.id}`,
      kind: "tab",
      label: tabTitle(t),
      path: "",
      id: t.id,
      url: t.doc ? undefined : t.request.url || undefined,
      method: t.doc ? undefined : t.request.method,
    });
  }
  return items;
}

const BOUNDARY = /[\s/._\-›:{}?&=]/;

/**
 * How well `query` matches `text` (higher is better), or null. A substring
 * scores highest, more so at the start or at a word boundary; otherwise the
 * letters must appear in order, scoring runs and word starts.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  const at = t.indexOf(q);
  if (at >= 0) {
    const boundary = at === 0 ? 300 : BOUNDARY.test(t[at - 1]) ? 200 : 0;
    return 1000 + boundary - at - (t.length - q.length) / 100;
  }
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, from);
    if (found < 0) return null;
    score += found === prev + 1 ? 10 : 1;
    if (found === 0 || BOUNDARY.test(t[found - 1])) score += 8;
    prev = found;
    from = found + 1;
  }
  return score - t.length / 100;
}

/** Score of one item for a query (each word must match the name, path or URL). */
export function scoreItem(item: SearchItem, query: string): { score: number; inName: boolean } | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { score: 0, inName: false };
  let total = 0;
  for (const w of words) {
    const name = fuzzyScore(w, item.label);
    const path = item.path ? fuzzyScore(w, item.path) : null;
    const url = item.url ? fuzzyScore(w, item.url) : null;
    const best = Math.max(name === null ? -Infinity : name * 1.5, path ?? -Infinity, url ?? -Infinity);
    if (best === -Infinity) return null;
    total += best;
  }
  return { score: total, inName: item.label.toLowerCase().includes(query.trim().toLowerCase()) };
}

/**
 * Items matching `query`, best first. Items whose name contains the query
 * come before looser matches; within each, recently used items (in `recent`
 * order) come first, then by score.
 */
export function rankItems(items: SearchItem[], query: string, recent: string[], limit = 50): SearchItem[] {
  const rank = new Map(recent.map((v, i) => [v, i]));
  const scored: { item: SearchItem; score: number; tier: number; recent: number }[] = [];
  for (const item of items) {
    const s = scoreItem(item, query);
    if (!s) continue;
    scored.push({ item, score: s.score, tier: s.inName ? 1 : 0, recent: rank.get(item.value) ?? Infinity });
  }
  scored.sort(
    (a, b) =>
      b.tier - a.tier || a.recent - b.recent || b.score - a.score || a.item.label.localeCompare(b.item.label),
  );
  return scored.slice(0, limit).map((s) => s.item);
}

/** The recently used items that still exist, newest first. */
export function recentItems(items: SearchItem[], recent: string[], limit = 8): SearchItem[] {
  const byValue = new Map(items.map((i) => [i.value, i]));
  return recent
    .map((v) => byValue.get(v))
    .filter((i): i is SearchItem => !!i && i.kind !== "tab")
    .slice(0, limit);
}
