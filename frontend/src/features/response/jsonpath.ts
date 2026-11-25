/**
 * JSONPath (RFC 9535) over the JSON tool's tree (`parseJson`), so numbers
 * and strings keep their exact text. Supports `$`, `@`, `.name`, `['name']`,
 * `*`, `..`, indexes (negative too), slices `start:end:step`, and filters
 * `?<expr>` with `== != < <= > >=`, `&& || !`, parentheses, existence tests
 * and the functions `length`, `count`, `match`, `search` and `value`.
 * Pure: nothing here knows about the UI.
 */
import { parseJson, type JsonNode } from "@/features/tools/json/json";

export class JsonPathError extends Error {
  constructor(
    message: string,
    /** Offset in the expression (from 0). */
    readonly offset: number,
  ) {
    super(message);
  }
}

// ---- syntax tree ----

type Selector =
  | { kind: "name"; name: string }
  | { kind: "wildcard" }
  | { kind: "index"; index: number }
  | { kind: "slice"; start: number | null; end: number | null; step: number | null }
  | { kind: "filter"; expr: Expr };

interface Segment {
  descendant: boolean;
  selectors: Selector[];
}

interface Query {
  root: "$" | "@";
  segments: Segment[];
}

type Expr =
  | { kind: "or" | "and"; left: Expr; right: Expr }
  | { kind: "not"; expr: Expr }
  | { kind: "compare"; op: CompareOp; left: Operand; right: Operand }
  | { kind: "test"; operand: Exclude<Operand, { kind: "literal" }> };

type CompareOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

type Operand =
  | { kind: "literal"; node: JsonNode }
  | { kind: "query"; query: Query; singular: boolean }
  | { kind: "call"; name: FunctionName; args: Operand[]; at: number };

type FunctionName = "length" | "count" | "match" | "search" | "value";
const FUNCTIONS = new Set<string>(["length", "count", "match", "search", "value"]);

// ---- parser ----

const NAME_START = /[A-Za-z_\u0080-￿]/;
const NAME_CHAR = /[A-Za-z0-9_\u0080-￿]/;
const INT = /-?(?:0|[1-9]\d*)/y;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

class Parser {
  i = 0;
  constructor(readonly src: string) {}

  fail(message: string, at = this.i): never {
    throw new JsonPathError(message, at);
  }

  skip() {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
  }

  peek(s: string): boolean {
    return this.src.startsWith(s, this.i);
  }

  eat(s: string): boolean {
    if (!this.peek(s)) return false;
    this.i += s.length;
    return true;
  }

  expect(s: string, what = `"${s}"`) {
    this.skip();
    if (!this.eat(s)) this.fail(`Expected ${what} ${this.here()}.`);
  }

  here(): string {
    return this.i >= this.src.length ? "at the end" : `at "${this.src[this.i]}" (character ${this.i + 1})`;
  }

  query(): Query {
    this.skip();
    const c = this.src[this.i];
    if (c !== "$" && c !== "@") this.fail(`A JSONPath starts with $, e.g. $.items[0].`);
    this.i++;
    return { root: c, segments: this.segments() };
  }

  segments(): Segment[] {
    const out: Segment[] = [];
    for (;;) {
      const save = this.i;
      this.skip();
      if (this.eat("..")) {
        if (this.peek("[")) out.push({ descendant: true, selectors: this.bracket() });
        else out.push({ descendant: true, selectors: [this.dotSelector()] });
      } else if (this.eat(".")) {
        out.push({ descendant: false, selectors: [this.dotSelector()] });
      } else if (this.peek("[")) {
        out.push({ descendant: false, selectors: this.bracket() });
      } else {
        this.i = save;
        return out;
      }
    }
  }

  dotSelector(): Selector {
    if (this.eat("*")) return { kind: "wildcard" };
    const start = this.i;
    if (!NAME_START.test(this.src[this.i] ?? "")) this.fail(`Expected a member name or * ${this.here()}.`);
    while (this.i < this.src.length && NAME_CHAR.test(this.src[this.i])) this.i++;
    return { kind: "name", name: this.src.slice(start, this.i) };
  }

  bracket(): Selector[] {
    this.expect("[");
    const out: Selector[] = [];
    for (;;) {
      this.skip();
      out.push(this.selector());
      this.skip();
      if (this.eat("]")) return out;
      if (!this.eat(",")) this.fail(`Expected "," or "]" ${this.here()}.`);
    }
  }

  selector(): Selector {
    const c = this.src[this.i];
    if (c === "'" || c === '"') return { kind: "name", name: this.string() };
    if (this.eat("*")) return { kind: "wildcard" };
    if (this.eat("?")) return { kind: "filter", expr: this.or() };
    const start = this.int();
    this.skip();
    if (!this.peek(":")) {
      if (start === null) this.fail(`Expected a name, an index, a slice, * or a ?filter ${this.here()}.`);
      return { kind: "index", index: start };
    }
    this.i++;
    this.skip();
    const end = this.int();
    this.skip();
    let step: number | null = null;
    if (this.eat(":")) {
      this.skip();
      step = this.int();
    }
    return { kind: "slice", start, end, step };
  }

  int(): number | null {
    INT.lastIndex = this.i;
    const m = INT.exec(this.src);
    if (!m) return null;
    this.i += m[0].length;
    return Number(m[0]);
  }

  /** A quoted string; returns its value. */
  string(): string {
    const quote = this.src[this.i];
    const start = this.i;
    this.i++;
    let out = "";
    for (;;) {
      if (this.i >= this.src.length) this.fail("This string has no closing quote.", start);
      const c = this.src[this.i];
      if (c === quote) {
        this.i++;
        return out;
      }
      if (c === "\\") {
        const e = this.src[this.i + 1];
        const simple: Record<string, string> = {
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
          "/": "/",
          "\\": "\\",
        };
        if (e === quote) out += quote;
        else if (e !== undefined && e in simple) out += simple[e];
        else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(this.src.slice(this.i + 2, this.i + 6))) {
          out += String.fromCharCode(parseInt(this.src.slice(this.i + 2, this.i + 6), 16));
          this.i += 4;
        } else this.fail("Unknown escape in a string.", this.i);
        this.i += 2;
        continue;
      }
      out += c;
      this.i++;
    }
  }

  or(): Expr {
    let left = this.and();
    for (;;) {
      this.skip();
      if (!this.eat("||")) return left;
      left = { kind: "or", left, right: this.and() };
    }
  }

  and(): Expr {
    let left = this.basic();
    for (;;) {
      this.skip();
      if (!this.eat("&&")) return left;
      left = { kind: "and", left, right: this.basic() };
    }
  }

  basic(): Expr {
    this.skip();
    if (this.eat("!")) {
      this.skip();
      return { kind: "not", expr: this.peek("(") ? this.paren() : this.testOnly() };
    }
    if (this.peek("(")) return this.paren();
    const at = this.i;
    const left = this.operand();
    this.skip();
    const op = (["==", "!=", "<=", ">=", "<", ">"] as const).find((o) => this.peek(o));
    if (!op) {
      if (left.kind === "literal")
        this.fail("A filter needs a test or a comparison, e.g. ?@.price < 10.", at);
      return { kind: "test", operand: left };
    }
    this.i += op.length;
    const right = this.operand();
    for (const side of [left, right]) {
      if (side.kind === "query" && !side.singular)
        this.fail("A comparison needs a query that picks one value (names and indexes only).", at);
    }
    return { kind: "compare", op, left, right };
  }

  paren(): Expr {
    this.expect("(");
    const e = this.or();
    this.expect(")");
    return e;
  }

  testOnly(): Expr {
    const at = this.i;
    const operand = this.operand();
    if (operand.kind === "literal") this.fail("! needs a query or a test in parentheses.", at);
    return { kind: "test", operand };
  }

  operand(): Operand {
    this.skip();
    const c = this.src[this.i];
    if (c === "$" || c === "@") {
      const query = this.query();
      const singular = query.segments.every(
        (s) =>
          !s.descendant &&
          s.selectors.length === 1 &&
          (s.selectors[0].kind === "name" || s.selectors[0].kind === "index"),
      );
      return { kind: "query", query, singular };
    }
    if (c === "'" || c === '"') {
      return { kind: "literal", node: { type: "raw", text: JSON.stringify(this.string()) } };
    }
    for (const word of ["true", "false", "null"]) {
      if (this.src.startsWith(word, this.i) && !NAME_CHAR.test(this.src[this.i + word.length] ?? "")) {
        this.i += word.length;
        return { kind: "literal", node: { type: "raw", text: word } };
      }
    }
    NUMBER.lastIndex = this.i;
    const num = NUMBER.exec(this.src);
    if (num) {
      this.i += num[0].length;
      return { kind: "literal", node: { type: "raw", text: num[0] } };
    }
    const at = this.i;
    const name = /^[a-z][a-z0-9_]*/.exec(this.src.slice(this.i))?.[0];
    if (name && this.src[this.i + name.length] === "(") {
      if (!FUNCTIONS.has(name))
        this.fail(`Unknown function ${name}(); use length, count, match, search or value.`, at);
      this.i += name.length + 1;
      const args: Operand[] = [];
      this.skip();
      if (!this.eat(")")) {
        for (;;) {
          args.push(this.operand());
          this.skip();
          if (this.eat(")")) break;
          this.expect(",", '"," or ")"');
        }
      }
      const want = name === "match" || name === "search" ? 2 : 1;
      if (args.length !== want) this.fail(`${name}() takes ${want} argument${want === 1 ? "" : "s"}.`, at);
      return { kind: "call", name: name as FunctionName, args, at };
    }
    this.fail(`Expected a value, a query or a function ${this.here()}.`);
  }
}

/** Parses a JSONPath expression. Throws JsonPathError. */
export function parseJsonPath(expr: string): Query {
  const p = new Parser(expr);
  const q = p.query();
  if (q.root !== "$") p.fail("A JSONPath starts with $, e.g. $.items[0].", 0);
  p.skip();
  if (p.i < expr.length) p.fail(`Unexpected ${p.here()}.`);
  return q;
}

// ---- values ----

type Kind = "object" | "array" | "string" | "number" | "true" | "false" | "null";

function kindOf(n: JsonNode): Kind {
  if (n.type !== "raw") return n.type;
  const c = n.text[0];
  if (c === '"') return "string";
  if (n.text === "true" || n.text === "false" || n.text === "null") return n.text;
  return "number";
}

function stringValue(n: JsonNode): string {
  return JSON.parse((n as { text: string }).text) as string;
}

function equal(a: JsonNode, b: JsonNode): boolean {
  const ka = kindOf(a);
  if (ka !== kindOf(b)) return false;
  switch (ka) {
    case "number":
      return Number((a as { text: string }).text) === Number((b as { text: string }).text);
    case "string":
      return stringValue(a) === stringValue(b);
    case "array": {
      const x = (a as { items: JsonNode[] }).items;
      const y = (b as { items: JsonNode[] }).items;
      return x.length === y.length && x.every((v, i) => equal(v, y[i]));
    }
    case "object": {
      const x = (a as Extract<JsonNode, { type: "object" }>).entries;
      const y = (b as Extract<JsonNode, { type: "object" }>).entries;
      if (x.length !== y.length) return false;
      return x.every((e) => {
        const other = y.find((o) => o.key === e.key);
        return other !== undefined && equal(e.value, other.value);
      });
    }
    default:
      return true;
  }
}

function less(a: JsonNode, b: JsonNode): boolean {
  const k = kindOf(a);
  if (k !== kindOf(b)) return false;
  if (k === "number") return Number((a as { text: string }).text) < Number((b as { text: string }).text);
  if (k === "string") return stringValue(a) < stringValue(b);
  return false;
}

/** Nothing (no value) is undefined. */
function compare(op: CompareOp, a: JsonNode | undefined, b: JsonNode | undefined): boolean {
  const eq = () => (a === undefined || b === undefined ? a === b : equal(a, b));
  const lt = () => a !== undefined && b !== undefined && less(a, b);
  switch (op) {
    case "==":
      return eq();
    case "!=":
      return !eq();
    case "<":
      return lt();
    case ">":
      return a !== undefined && b !== undefined && less(b, a);
    case "<=":
      return lt() || eq();
    case ">=":
      return (a !== undefined && b !== undefined && less(b, a)) || eq();
  }
}

// ---- evaluation ----

function children(n: JsonNode): JsonNode[] {
  if (n.type === "array") return n.items;
  if (n.type === "object") return n.entries.map((e) => e.value);
  return [];
}

function descendants(n: JsonNode, out: JsonNode[] = []): JsonNode[] {
  // Iterative, document order: a node, then its children's subtrees.
  const stack: JsonNode[] = [n];
  while (stack.length) {
    const cur = stack.pop()!;
    out.push(cur);
    const kids = children(cur);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

function sliceIndexes(len: number, s: Extract<Selector, { kind: "slice" }>): number[] {
  const step = s.step ?? 1;
  if (step === 0) return [];
  const norm = (i: number) => (i >= 0 ? i : len + i);
  const out: number[] = [];
  if (step > 0) {
    const lo = Math.min(Math.max(norm(s.start ?? 0), 0), len);
    const hi = Math.min(Math.max(norm(s.end ?? len), 0), len);
    for (let i = lo; i < hi; i += step) out.push(i);
  } else {
    const hi = Math.min(Math.max(norm(s.start ?? len - 1), -1), len - 1);
    const lo = Math.min(Math.max(norm(s.end ?? -len - 1), -1), len - 1);
    for (let i = hi; i > lo; i += step) out.push(i);
  }
  return out;
}

class Evaluator {
  constructor(readonly root: JsonNode) {}

  query(q: Query, current: JsonNode): JsonNode[] {
    let nodes = [q.root === "$" ? this.root : current];
    for (const seg of q.segments) {
      const next: JsonNode[] = [];
      for (const n of nodes) {
        const targets = seg.descendant ? descendants(n) : [n];
        for (const t of targets) for (const sel of seg.selectors) this.select(sel, t, next);
      }
      nodes = next;
    }
    return nodes;
  }

  select(sel: Selector, n: JsonNode, out: JsonNode[]) {
    switch (sel.kind) {
      case "name":
        if (n.type === "object") {
          for (const e of n.entries) if (e.key === sel.name) out.push(e.value);
        }
        return;
      case "wildcard":
        out.push(...children(n));
        return;
      case "index":
        if (n.type === "array") {
          const i = sel.index < 0 ? n.items.length + sel.index : sel.index;
          if (i >= 0 && i < n.items.length) out.push(n.items[i]);
        }
        return;
      case "slice":
        if (n.type === "array") for (const i of sliceIndexes(n.items.length, sel)) out.push(n.items[i]);
        return;
      case "filter":
        for (const c of children(n)) if (this.test(sel.expr, c)) out.push(c);
    }
  }

  test(e: Expr, cur: JsonNode): boolean {
    switch (e.kind) {
      case "or":
        return this.test(e.left, cur) || this.test(e.right, cur);
      case "and":
        return this.test(e.left, cur) && this.test(e.right, cur);
      case "not":
        return !this.test(e.expr, cur);
      case "compare":
        return compare(e.op, this.value(e.left, cur), this.value(e.right, cur));
      case "test": {
        const o = e.operand;
        if (o.kind === "query") return this.query(o.query, cur).length > 0;
        const r = this.call(o, cur);
        return typeof r === "boolean" ? r : Array.isArray(r) ? r.length > 0 : r !== undefined;
      }
    }
  }

  /** The single value an operand stands for (undefined = Nothing). */
  value(o: Operand, cur: JsonNode): JsonNode | undefined {
    if (o.kind === "literal") return o.node;
    if (o.kind === "query") {
      const nodes = this.query(o.query, cur);
      return nodes.length === 1 ? nodes[0] : undefined;
    }
    const r = this.call(o, cur);
    if (typeof r === "boolean" || Array.isArray(r)) return undefined;
    return r;
  }

  call(o: Extract<Operand, { kind: "call" }>, cur: JsonNode): JsonNode | JsonNode[] | boolean | undefined {
    const nodes = (a: Operand) => (a.kind === "query" ? this.query(a.query, cur) : []);
    switch (o.name) {
      case "count":
        return { type: "raw", text: String(nodes(o.args[0]).length) };
      case "value": {
        const list = nodes(o.args[0]);
        return list.length === 1 ? list[0] : undefined;
      }
      case "length": {
        const v = this.value(o.args[0], cur);
        if (v === undefined) return undefined;
        const k = kindOf(v);
        if (k === "string") return { type: "raw", text: String([...stringValue(v)].length) };
        if (k === "array" || k === "object") return { type: "raw", text: String(children(v).length) };
        return undefined;
      }
      case "match":
      case "search": {
        const s = this.value(o.args[0], cur);
        const re = this.value(o.args[1], cur);
        if (!s || !re || kindOf(s) !== "string" || kindOf(re) !== "string") return false;
        let rx: RegExp;
        try {
          const src = stringValue(re);
          rx = new RegExp(o.name === "match" ? `^(?:${src})$` : src, "u");
        } catch {
          return false;
        }
        return rx.test(stringValue(s));
      }
    }
  }
}

/** Evaluates a parsed query against a document and returns the matches in order. */
export function evaluateJsonPath(q: Query, root: JsonNode): JsonNode[] {
  return new Evaluator(root).query(q, root);
}

export type FilterResult =
  { ok: true; matches: JsonNode[] } | { ok: false; error: string; offset?: number; badBody?: boolean };

/**
 * Filters JSON text with a JSONPath expression. The body is parsed once by
 * the caller via `parseBody`; errors are sentences for the UI.
 */
export function filterJson(body: JsonNode | null, expr: string): FilterResult {
  if (body === null)
    return { ok: false, error: "The body isn't valid JSON, so it can't be filtered.", badBody: true };
  let q: Query;
  try {
    q = parseJsonPath(expr);
  } catch (e) {
    if (e instanceof JsonPathError) return { ok: false, error: e.message, offset: e.offset };
    throw e;
  }
  return { ok: true, matches: evaluateJsonPath(q, body) };
}

/** Parses a body for filtering; null when it isn't JSON. */
export function parseBody(text: string): JsonNode | null {
  try {
    return parseJson(text);
  } catch {
    return null;
  }
}
