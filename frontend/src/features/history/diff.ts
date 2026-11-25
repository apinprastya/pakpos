/**
 * Line diffs (Myers' O(ND) algorithm) and their grouping into hunks with
 * context. Pure.
 */

export interface DiffLine {
  op: "same" | "add" | "del";
  text: string;
  /** 1-based line numbers in the old (a) and new (b) text. */
  a?: number;
  b?: number;
}

/** Past this many changed lines a diff is reported as too large (null). */
export const MAX_EDITS = 4000;

/**
 * The lines of a and b as a list of kept, deleted and added lines, or null
 * when they differ in more than maxEdits lines.
 */
export function diffLines(a: string[], b: string[], maxEdits = MAX_EDITS): DiffLine[] | null {
  // Common prefix and suffix first: most diffs are small changes in big texts.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const middle = myers(a.slice(start, endA), b.slice(start, endB), maxEdits);
  if (middle === null) return null;
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ op: "same", text: a[i], a: i + 1, b: i + 1 });
  let ai = start;
  let bi = start;
  for (const m of middle) {
    if (m.op === "same") out.push({ op: "same", text: m.text, a: ++ai, b: ++bi });
    else if (m.op === "del") out.push({ op: "del", text: m.text, a: ++ai });
    else out.push({ op: "add", text: m.text, b: ++bi });
  }
  for (let i = endA; i < a.length; i++) out.push({ op: "same", text: a[i], a: ++ai, b: ++bi });
  return out;
}

function myers(a: string[], b: string[], maxEdits: number): DiffLine[] | null {
  const n = a.length;
  const m = b.length;
  // trace[d][k + d] is the furthest x on diagonal k after d edits.
  const trace: Int32Array[] = [];
  let done = false;
  for (let d = 0; d <= Math.min(n + m, maxEdits) && !done; d++) {
    const v = new Int32Array(2 * d + 1);
    const prev = trace[d - 1];
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (d === 0) x = 0;
      else if (k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1])) x = prev[k + 1 + d - 1];
      else x = prev[k - 1 + d - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + d] = x;
      if (x >= n && y >= m) {
        done = true;
        break;
      }
    }
    trace.push(v);
  }
  if (!done) return null;

  const out: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[prevK + d - 1];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ op: "same", text: a[--x] });
      y--;
    }
    if (down) out.push({ op: "add", text: b[--y] });
    else out.push({ op: "del", text: a[--x] });
  }
  while (x > 0 && y > 0) {
    out.push({ op: "same", text: a[--x] });
    y--;
  }
  return out.reverse();
}

export type Hunk =
  | { kind: "lines"; lines: DiffLine[] }
  /** Unchanged lines hidden between changes (or at either end). */
  | { kind: "gap"; lines: DiffLine[] };

/** Groups a diff into changed lines with `context` unchanged lines around them, and gaps. */
export function toHunks(lines: DiffLine[], context = 3): Hunk[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.op === "same") return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true;
  });
  const out: Hunk[] = [];
  for (let i = 0; i < lines.length;) {
    const kind = keep[i] ? "lines" : "gap";
    let j = i;
    while (j < lines.length && (keep[j] ? "lines" : "gap") === kind) j++;
    out.push({ kind, lines: lines.slice(i, j) });
    i = j;
  }
  return out;
}

/** How many lines were added and deleted. */
export function diffStats(lines: DiffLine[]): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const l of lines) {
    if (l.op === "add") added++;
    else if (l.op === "del") deleted++;
  }
  return { added, deleted };
}
