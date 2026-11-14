import { create } from "zustand";
import { ancestorsOf, findNode } from "@/lib/tree";
import {
  nodeKey,
  parseExpandState,
  serializeExpandState,
  withExpanded,
  type ExpandState,
} from "@/features/sidebar/treeModel";
import { useLayoutStore } from "@/stores/layout";
import { useWorkspaceStore } from "@/stores/workspace";

const keyFor = (workspaceId: string) => `pakpos-tree:${workspaceId}`;
/** Tier 1 storage: an array of collapsed collection ids. Read once, then replaced. */
const legacyKeyFor = (workspaceId: string) => `pakpos-tree-collapsed:${workspaceId}`;

function parse(raw: string | null): unknown {
  try {
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/** The stored expand state of a workspace's tree (defaults when there is none). */
export function readExpandState(workspaceId: string): ExpandState {
  try {
    return parseExpandState(
      parse(localStorage.getItem(keyFor(workspaceId))),
      parse(localStorage.getItem(legacyKeyFor(workspaceId))),
    );
  } catch {
    return parseExpandState(null);
  }
}

function write(workspaceId: string, state: ExpandState) {
  try {
    localStorage.setItem(keyFor(workspaceId), JSON.stringify(serializeExpandState(state)));
  } catch {
    /* storage unavailable: expansion just isn't remembered */
  }
}

/** A row the tree should scroll to (and focus, when `focus`) once it's rendered. */
export interface RevealRequest {
  /** Tree key (`c:`, `f:` or `r:` plus the id). */
  key: string;
  focus: boolean;
  /** Changes on every request, so revealing the same row twice works. */
  nonce: number;
}

interface TreeState {
  /** Expand state by workspace id, once it was read or changed. */
  states: Record<string, ExpandState>;
  reveal: RevealRequest | null;

  setExpanded: (workspaceId: string, key: string, expanded: boolean) => void;
  /**
   * Shows a request, folder or collection of the open workspace in the
   * sidebar tree: expands its ancestors (and a folder or collection itself),
   * then scrolls the row into view. The row gets focus only when the
   * collections view is showing, or with `show`, which switches to it first.
   * Returns false when the id isn't in the tree.
   */
  revealInTree: (id: string, opts?: { show?: boolean }) => boolean;
  /** Called by the tree once it handled a reveal. */
  revealDone: (nonce: number) => void;
}

let nonce = 0;

export const useTreeStore = create<TreeState>()((set, get) => {
  const current = (workspaceId: string) => get().states[workspaceId] ?? readExpandState(workspaceId);
  const update = (workspaceId: string, next: ExpandState) => {
    write(workspaceId, next);
    set((s) => ({ states: { ...s.states, [workspaceId]: next } }));
  };

  return {
    states: {},
    reveal: null,

    setExpanded: (workspaceId, key, expanded) => {
      const prev = current(workspaceId);
      const next = withExpanded(prev, key, expanded);
      if (next !== prev) update(workspaceId, next);
    },

    revealInTree: (id, opts = {}) => {
      const { workspace, collections } = useWorkspaceStore.getState();
      const node = workspace ? findNode(collections, id) : undefined;
      if (!workspace || !node) return false;
      const keys = ancestorsOf(collections, node.kind, node.id).map(nodeKey);
      if (node.kind !== "request") keys.push(nodeKey(node));
      let state = current(workspace.id);
      const before = state;
      for (const key of keys) state = withExpanded(state, key, true);
      if (state !== before) update(workspace.id, state);

      const layout = useLayoutStore.getState();
      if (opts.show) layout.setSidebarView("collections");
      const focus = useLayoutStore.getState().sidebarView === "collections";
      nonce += 1;
      set({ reveal: { key: nodeKey(node), focus, nonce } });
      return true;
    },

    revealDone: (n) => {
      if (get().reveal?.nonce === n) set({ reveal: null });
    },
  };
});
