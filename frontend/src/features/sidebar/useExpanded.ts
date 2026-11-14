import { useCallback, useMemo } from "react";
import { readExpandState, useTreeStore } from "@/stores/tree";
import { isExpandedIn } from "./treeModel";

/**
 * Expanded/collapsed collections and folders, by tree key, remembered per
 * workspace (`stores/tree.ts`, which `revealInTree` also changes).
 * Collections start expanded, folders collapsed.
 */
export function useExpanded(workspaceId: string) {
  const stored = useTreeStore((s) => s.states[workspaceId]);
  const state = useMemo(() => stored ?? readExpandState(workspaceId), [stored, workspaceId]);

  const isExpanded = useCallback((key: string) => isExpandedIn(state, key), [state]);
  const setExpanded = useCallback(
    (key: string, expanded: boolean) => useTreeStore.getState().setExpanded(workspaceId, key, expanded),
    [workspaceId],
  );

  return { isExpanded, setExpanded };
}
