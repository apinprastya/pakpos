/**
 * Recently used palette items (requests, folders, environments, actions…),
 * newest first, per workspace in localStorage. A UI convenience: losing it
 * only changes the order of results.
 */
export const MAX_RECENT = 20;

const keyFor = (workspaceId: string) => `pakpos-palette-recent:${workspaceId || "none"}`;

export function readRecent(workspaceId: string): string[] {
  try {
    const raw = localStorage.getItem(keyFor(workspaceId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Moves `id` to the front of the workspace's recent list and returns the new list. */
export function pushRecent(workspaceId: string, id: string): string[] {
  const next = [id, ...readRecent(workspaceId).filter((x) => x !== id)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(keyFor(workspaceId), JSON.stringify(next));
  } catch {
    /* storage unavailable: the order just isn't remembered */
  }
  return next;
}
