import { toast } from "sonner";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import type { ExportResult, ImportWarning } from "@/lib/importModel";

/** What to export to Postman. */
export type ExportTarget =
  { kind: "collection"; id: string } | { kind: "environment"; id: string } | { kind: "globals" };

const NOUNS: Record<ExportTarget["kind"], string> = {
  collection: "collection",
  environment: "environment",
  globals: "globals",
};

/** The warnings that fit in a toast: the first few, then "and N more". */
export function describeExportWarnings(warnings: ImportWarning[], max = 3): string {
  const lines = warnings.slice(0, max).map((w) => (w.where ? `${w.where}: ${w.message}` : w.message));
  if (warnings.length > max) lines.push(`And ${warnings.length - max} more.`);
  return lines.join("\n");
}

/**
 * Exports a collection, an environment or the globals as a Postman file
 * (Go asks where to save it). Secret values are never exported. Resolves
 * with the result, or null when the user cancelled or the export failed
 * (a toast says why).
 */
export async function exportToPostman(target: ExportTarget): Promise<ExportResult | null> {
  let res: ExportResult;
  try {
    res =
      target.kind === "collection"
        ? await api.exportCollection(target.id)
        : target.kind === "environment"
          ? await api.exportEnvironment(target.id)
          : await api.exportGlobals();
  } catch (e) {
    toast.error(`Couldn't export the ${NOUNS[target.kind]}`, { description: errorMessage(e) });
    return null;
  }
  if (!res.path) return null;
  const title = target.kind === "globals" ? "Exported the globals" : `Exported "${res.name}"`;
  if (res.warnings.length === 0) {
    toast.success(title, { description: res.path });
  } else {
    toast.warning(`${title}. Check these in Postman`, {
      description: describeExportWarnings(res.warnings),
      classNames: { description: "whitespace-pre-line" },
      duration: 15000,
    });
  }
  return res;
}
