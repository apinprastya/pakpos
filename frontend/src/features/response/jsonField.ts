/**
 * Finds the JSON field at a position in a JSON document, so the response body
 * can copy one field's value, key or path. A small tolerant scanner rather
 * than the CodeMirror syntax tree: it works in Raw mode too, before the JSON
 * language chunk has loaded, and on truncated bodies (fields that were parsed
 * completely before the cut are still found).
 */

export type PathSegment = string | number;

export interface JsonField {
  /** Segments from the root; empty for the root value. */
  path: PathSegment[];
  /** The value as you would paste it: strings unquoted, containers as JSON. */
  value: string;
  /** The property name, when the value belongs to an object. */
  key?: string;
}

interface Node {
  path: PathSegment[];
  start: number;
  end: number;
  keyStart?: number;
  keyEnd?: number;
}

class Scanner {
  i = 0;
  nodes: Node[] = [];
  constructor(readonly s: string) {}

  ws() {
    while (this.i < this.s.length && " \t\n\r".includes(this.s[this.i])) this.i++;
  }

  fail(): never {
    throw new Error("invalid JSON");
  }

  /** Returns the end of the string literal starting at `i`. */
  string(): number {
    if (this.s[this.i] !== '"') this.fail();
    this.i++;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === "\\") this.i += 2;
      else if (c === '"') return ++this.i;
      else this.i++;
    }
    return this.fail();
  }

  value(path: PathSegment[], key?: { start: number; end: number }) {
    this.ws();
    const start = this.i;
    const c = this.s[this.i];
    if (c === "{") {
      this.i++;
      this.ws();
      if (this.s[this.i] === "}") this.i++;
      else {
        for (;;) {
          this.ws();
          const ks = this.i;
          const ke = this.string();
          const name = JSON.parse(this.s.slice(ks, ke)) as string;
          this.ws();
          if (this.s[this.i] !== ":") this.fail();
          this.i++;
          this.value([...path, name], { start: ks, end: ke });
          this.ws();
          if (this.s[this.i] === ",") this.i++;
          else if (this.s[this.i] === "}") {
            this.i++;
            break;
          } else this.fail();
        }
      }
    } else if (c === "[") {
      this.i++;
      this.ws();
      if (this.s[this.i] === "]") this.i++;
      else {
        for (let n = 0; ; n++) {
          this.value([...path, n]);
          this.ws();
          if (this.s[this.i] === ",") this.i++;
          else if (this.s[this.i] === "]") {
            this.i++;
            break;
          } else this.fail();
        }
      }
    } else if (c === '"') {
      this.string();
    } else {
      const m = /^(?:-?\d[\d.eE+-]*|true|false|null)/.exec(this.s.slice(this.i, this.i + 400));
      if (!m) this.fail();
      this.i += m[0].length;
    }
    this.nodes.push({ path, start, end: this.i, keyStart: key?.start, keyEnd: key?.end });
  }
}

/** The innermost field at `offset` (on its key or its value), or null outside any JSON value. */
export function jsonFieldAt(text: string, offset: number): JsonField | null {
  const sc = new Scanner(text);
  try {
    sc.value([]);
  } catch {
    // Truncated or invalid: use the fields that were complete.
  }
  // On a key: that property (nothing inside its value can contain the offset).
  // Otherwise the smallest value around the offset is the innermost one.
  let best: Node | undefined = sc.nodes.find(
    (n) => n.keyStart !== undefined && offset >= n.keyStart && offset <= n.keyEnd!,
  );
  if (!best) {
    for (const n of sc.nodes) {
      if (offset < n.start || offset > n.end) continue;
      if (!best || n.end - n.start < best.end - best.start) best = n;
    }
  }
  if (!best) return null;
  const last = best.path[best.path.length - 1];
  return {
    path: best.path,
    value: copyValue(text, best),
    key: typeof last === "string" ? last : undefined,
  };
}

function copyValue(text: string, n: Node): string {
  const raw = text.slice(n.start, n.end);
  if (raw.startsWith('"')) return JSON.parse(raw) as string;
  if (!raw.startsWith("{") && !raw.startsWith("[")) return raw;
  // A nested container: drop the indentation of the line it sits on.
  const lineStart = text.lastIndexOf("\n", n.start - 1) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart, n.start))![0].length;
  if (!indent) return raw;
  const prefix = new RegExp(`^[ \\t]{0,${indent}}`);
  return raw
    .split("\n")
    .map((line, i) => (i === 0 ? line : line.replace(prefix, "")))
    .join("\n");
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** `data.items[0].id`, with `["odd key"]` for names that aren't identifiers. */
export function formatPath(path: PathSegment[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else if (IDENT.test(seg)) out += out ? `.${seg}` : seg;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}
