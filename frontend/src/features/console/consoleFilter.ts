import type { ConsoleLevel, ScriptSource } from "@/lib/model";
import type { ConsoleGroup } from "@/stores/console";

/** "pre-request script of folder Auth", for a line's source. */
export function sourceLabel(s: ScriptSource): string {
  const ev = s.event === "prerequest" ? "Pre-request" : "Test";
  return `${ev} · ${s.kind} ${s.name}`.trim();
}

/** Keeps the lines that pass the level filter and contain the search text (case-insensitive). */
export function filterGroups(
  groups: ConsoleGroup[],
  levels: ReadonlySet<ConsoleLevel>,
  search: string,
): ConsoleGroup[] {
  const q = search.trim().toLowerCase();
  return groups
    .map((g) => ({
      ...g,
      lines: g.lines.filter((l) => levels.has(l.level) && (!q || l.text.toLowerCase().includes(q))),
    }))
    .filter((g) => g.lines.length > 0);
}
