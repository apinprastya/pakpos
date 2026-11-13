import { useCallback, useState } from "react";

const keyFor = (workspaceId: string) => `pakpos-tree-collapsed:${workspaceId}`;

function read(workspaceId: string): Set<string> {
  try {
    const raw = localStorage.getItem(keyFor(workspaceId));
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function write(workspaceId: string, collapsed: Set<string>) {
  try {
    localStorage.setItem(keyFor(workspaceId), JSON.stringify([...collapsed]));
  } catch {
    /* storage unavailable: expansion just isn't remembered */
  }
}

/**
 * Expanded/collapsed collections, remembered per workspace. Collections start expanded.
 * Mount the user with `key={workspaceId}` so switching workspaces re-reads the state.
 */
export function useExpanded(workspaceId: string) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => read(workspaceId));

  const isExpanded = useCallback((id: string) => !collapsed.has(id), [collapsed]);

  const setExpanded = useCallback(
    (id: string, expanded: boolean) => {
      setCollapsed((prev) => {
        if (prev.has(id) === !expanded) return prev;
        const next = new Set(prev);
        if (expanded) next.delete(id);
        else next.add(id);
        write(workspaceId, next);
        return next;
      });
    },
    [workspaceId],
  );

  return { isExpanded, setExpanded };
}
