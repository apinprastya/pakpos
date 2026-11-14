// Formatting for the update dialog.

/** A byte count as MB with one decimal. */
export function megabytes(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** An RFC 3339 date as a local calendar date ("" when absent or invalid). */
export function releaseDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

/** Percent done, or null when the total isn't known. */
export function percent(done: number, total: number): number | null {
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
}
