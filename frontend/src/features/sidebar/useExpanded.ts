import { useCallback, useState } from "react";
import {
  isExpandedIn,
  parseExpandState,
  serializeExpandState,
  withExpanded,
  type ExpandState,
} from "./treeModel";

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

function read(workspaceId: string): ExpandState {
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

/**
 * Expanded/collapsed collections and folders, by tree key, remembered per
 * workspace. Collections start expanded, folders collapsed. Mount the user
 * with `key={workspaceId}` so switching workspaces re-reads the state.
 */
export function useExpanded(workspaceId: string) {
  const [state, setState] = useState<ExpandState>(() => read(workspaceId));

  const isExpanded = useCallback((key: string) => isExpandedIn(state, key), [state]);

  const setExpanded = useCallback(
    (key: string, expanded: boolean) => {
      setState((prev) => {
        const next = withExpanded(prev, key, expanded);
        if (next !== prev) write(workspaceId, next);
        return next;
      });
    },
    [workspaceId],
  );

  return { isExpanded, setExpanded };
}
