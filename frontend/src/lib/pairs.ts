import type { KeyValue } from "./model";

/**
 * Parses pasted text into rows. Accepts "Key: value" lines, "k=v" lines and
 * "a=1&b=2" query strings. Returns null when the text is a plain value that
 * should be pasted as-is.
 */
export function parsePastedPairs(text: string): KeyValue[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length > 1) return lines.map(parseLine);
  const line = lines[0];
  if (/^[^\s:=&]+:\s/.test(line)) return [parseLine(line)];
  if (line.includes("&") && line.includes("=")) {
    return line
      .replace(/^\?/, "")
      .split("&")
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf("=");
        return eq < 0
          ? { key: part, value: "", enabled: true }
          : { key: part.slice(0, eq), value: part.slice(eq + 1), enabled: true };
      });
  }
  return null;
}

function parseLine(line: string): KeyValue {
  const l = line.trim();
  const colon = l.indexOf(":");
  const eq = l.indexOf("=");
  const sep = colon >= 0 && (eq < 0 || colon < eq) ? colon : eq;
  if (sep < 0) return { key: l, value: "", enabled: true };
  return { key: l.slice(0, sep).trim(), value: l.slice(sep + 1).trim(), enabled: true };
}

/** Rows as "Key: value" lines; disabled rows are prefixed with "//". */
export function rowsToBulk(rows: KeyValue[]): string {
  return rows
    .filter((r) => r.key !== "" || r.value !== "")
    .map((r) => `${r.enabled ? "" : "//"}${r.key}: ${r.value}`)
    .join("\n");
}

export function bulkToRows(text: string): KeyValue[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const disabled = l.trimStart().startsWith("//");
      const row = parseLine(disabled ? l.trimStart().slice(2) : l);
      return { ...row, enabled: !disabled };
    });
}
