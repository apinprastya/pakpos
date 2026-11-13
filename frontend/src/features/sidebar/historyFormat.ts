import type { HistorySummary } from "@/lib/model";

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const DAY = 24 * 60 * 60 * 1000;

/** "Today", "Yesterday", or a short date. */
export function dayLabel(date: Date, now: Date = new Date()): string {
  const diff = Math.round((startOfDay(now) - startOfDay(date)) / DAY);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/** Relative time for today ("just now", "5m ago", "3h ago"), clock time for older days. */
export function timeLabel(date: Date, now: Date = new Date()): string {
  const secs = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (startOfDay(date) === startOfDay(now)) {
    if (secs < 60) return "just now";
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    return `${Math.floor(secs / 3600)}h ago`;
  }
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export interface HistoryGroup {
  label: string;
  items: HistorySummary[];
}

/** Groups newest-first entries by calendar day, keeping order. */
export function groupByDay(items: HistorySummary[], now: Date = new Date()): HistoryGroup[] {
  const groups: HistoryGroup[] = [];
  for (const item of items) {
    const label = dayLabel(new Date(item.createdAt), now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/** Short status text: the code, or a word for failed sends. */
export function statusLabel(item: Pick<HistorySummary, "status" | "errorKind">): string {
  if (item.status > 0) return String(item.status);
  if (item.errorKind === "canceled") return "Canceled";
  return "Failed";
}

/** URL without its scheme, so the host and path fit in a narrow row. */
export function displayUrl(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
}
