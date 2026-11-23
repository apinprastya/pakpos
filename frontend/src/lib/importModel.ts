/**
 * Postman import types (Go `internal/importer`, `core/postman` and
 * `service.ImportService`) and their normalizers.
 */

type Loose<T> = { [K in keyof T]?: T[K] | null };
/** The binding's shape: `kind` is a TS enum there. */
type Raw<T> = Omit<Loose<T>, "kind"> & { kind?: string | null };

export type ImportKind = "collection" | "environment" | "globals";

export interface ImportOptions {
  /** Keep variables that look like credentials (token, password, apiKey...) in the secret store. */
  guessSecrets: boolean;
}

/** Something that won't work as it did in Postman. `where` names the item, "" for the whole file. */
export interface ImportWarning {
  where: string;
  message: string;
}

/** What importing a file adds (PreviewPostman) or added (ImportPostman). */
export interface ImportSummary {
  kind: ImportKind;
  name: string;
  folders: number;
  requests: number;
  examples: number;
  variables: number;
  secrets: number;
  /** A secret has a value to store, so the secret store must be ready. */
  secretValues: boolean;
  /** Existing globals the import replaces. */
  replaced: string[];
  warnings: ImportWarning[];
}

export interface ImportResult extends ImportSummary {
  /** The new collection's or environment's id ("" for globals). */
  id: string;
}

const KINDS: readonly ImportKind[] = ["collection", "environment", "globals"];

export function normalizeImportSummary(s: Raw<ImportSummary> | null | undefined): ImportSummary {
  const kind = KINDS.find((k) => k === s?.kind) ?? "collection";
  return {
    kind,
    name: s?.name ?? "",
    folders: s?.folders ?? 0,
    requests: s?.requests ?? 0,
    examples: s?.examples ?? 0,
    variables: s?.variables ?? 0,
    secrets: s?.secrets ?? 0,
    secretValues: !!s?.secretValues,
    replaced: s?.replaced ?? [],
    warnings: (s?.warnings ?? []).map((w) => ({ where: w?.where ?? "", message: w?.message ?? "" })),
  };
}

export function normalizeImportResult(r: Raw<ImportResult> | null | undefined): ImportResult {
  return { ...normalizeImportSummary(r), id: r?.id ?? "" };
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "12 requests in 3 folders, 4 examples, 5 variables (2 secret)". */
export function describeImport(s: ImportSummary): string {
  const parts: string[] = [];
  if (s.kind === "collection") {
    let reqs = count(s.requests, "request", "requests");
    if (s.folders > 0) reqs += ` in ${count(s.folders, "folder", "folders")}`;
    parts.push(reqs);
    if (s.examples > 0) parts.push(count(s.examples, "example", "examples"));
  }
  if (s.variables > 0 || s.kind !== "collection") {
    let vars = count(s.variables, "variable", "variables");
    if (s.secrets > 0) vars += ` (${s.secrets} secret)`;
    parts.push(vars);
  }
  return parts.join(", ");
}

/** What the import makes, for the preview's heading. */
export function importTarget(s: ImportSummary): string {
  switch (s.kind) {
    case "environment":
      return `New environment "${s.name}"`;
    case "globals":
      return "Variables merged into the globals";
    default:
      return `New collection "${s.name}"`;
  }
}
