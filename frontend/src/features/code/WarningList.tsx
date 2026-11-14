import type { CurlWarning } from "@/lib/model";

const SHOWN_WARNINGS = 3;

/** The warnings of an import, as a toast description: the first few, then a count. */
export function WarningList({ warnings }: { warnings: CurlWarning[] }) {
  const shown = warnings.slice(0, SHOWN_WARNINGS);
  const more = warnings.length - shown.length;
  return (
    <ul aria-label="Import warnings" className="mt-1 list-disc space-y-0.5 pl-4">
      {shown.map((w, i) => (
        <li key={i}>{w.message}</li>
      ))}
      {more > 0 && <li>{more === 1 ? "1 more warning" : `${more} more warnings`}</li>}
    </ul>
  );
}
