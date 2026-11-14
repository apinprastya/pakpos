/**
 * `{{variable}}` references in text: a port of the scanner in Go's
 * `internal/core/vars` (`expand` and `refName`), so the editor marks exactly
 * what the resolver will replace. Keep the two in step.
 *
 * - A reference is `{{` … `}}`; the name is the text between, trimmed, so
 *   `{{ name }}` works. Names can't be empty or contain braces or line breaks.
 * - Scanning goes from a `{{` to the next `}}`. When another `{{` comes
 *   before that `}}`, the reference starts at the last one (`{{{{a}}` is `a`).
 * - An unterminated `{{` is plain text.
 */

export interface VarToken {
  /** Offset of the opening `{{`. */
  from: number;
  /** Offset just after the closing `}}`. */
  to: number;
  /** The trimmed name. */
  name: string;
}

/** Finds every reference in text. Offsets are relative to `text`, plus `offset`. */
export function varTokens(text: string, offset = 0): VarToken[] {
  const out: VarToken[] = [];
  let pos = 0;
  for (;;) {
    const start = text.indexOf("{{", pos);
    if (start < 0) break;
    const end = text.indexOf("}}", start + 2);
    if (end < 0) break;
    const inner = text.slice(start + 2, end);
    const nested = inner.lastIndexOf("{{");
    if (nested >= 0) {
      pos = start + 2 + nested;
      continue;
    }
    pos = end + 2;
    const name = refName(inner);
    if (name) out.push({ from: offset + start, to: offset + end + 2, name });
  }
  return out;
}

/** The name between the braces, or "" when it isn't a valid reference. */
function refName(inner: string): string {
  const name = inner.trim();
  return name === "" || /[{}\r\n]/.test(name) ? "" : name;
}

/** The reference covering pos (inclusive at both ends), if any. */
export function tokenAt(text: string, pos: number, offset = 0): VarToken | null {
  return varTokens(text, offset).find((t) => t.from <= pos && pos <= t.to) ?? null;
}

/** A piece of text for a static renderer: plain text or a reference. */
export type VarPart = { text: string; token: VarToken | null };

/** Splits text into plain and reference parts, in order, covering all of it. */
export function splitVars(text: string): VarPart[] {
  const parts: VarPart[] = [];
  let pos = 0;
  for (const t of varTokens(text)) {
    if (t.from > pos) parts.push({ text: text.slice(pos, t.from), token: null });
    parts.push({ text: text.slice(t.from, t.to), token: t });
    pos = t.to;
  }
  if (pos < text.length) parts.push({ text: text.slice(pos), token: null });
  return parts;
}
