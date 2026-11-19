/**
 * The JSON tool's logic: a small parser that keeps numbers and strings as
 * they're written (so 12345678901234567890 keeps every digit), with errors
 * that carry a position, plus format, minify, sort keys and string
 * escape/unescape. Pure; nothing here knows about the UI.
 */

export type JsonNode =
  | { type: "object"; entries: { key: string; raw: string; value: JsonNode }[] }
  | { type: "array"; items: JsonNode[] }
  /** Strings, numbers, true, false and null, exactly as written. */
  | { type: "raw"; text: string };

/** Where the text stops being JSON. Line and column start at 1; `offset` at 0. */
export interface JsonError {
  message: string;
  offset: number;
  line: number;
  column: number;
}

export class JsonParseError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

/** Line and column (both from 1) of an offset in text. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let start = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      start = i + 1;
    }
  }
  return { line, column: offset - start + 1 };
}

const WS = new Set([" ", "\t", "\n", "\r"]);
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

/** Describes the character at `i` for an error message. */
function found(text: string, i: number): string {
  if (i >= text.length) return "the end of the text";
  const c = text[i];
  return c === "\n" ? "a line break" : `"${c}"`;
}

/** Parses JSON text (RFC 8259, no comments or trailing commas). Throws JsonParseError. */
export function parseJson(text: string): JsonNode {
  let i = 0;
  // Nesting is walked with an explicit stack so deep documents can't overflow the call stack.
  const skip = () => {
    while (i < text.length && WS.has(text[i])) i++;
  };

  const string = (): string => {
    const start = i;
    i++; // opening quote
    for (;;) {
      if (i >= text.length) throw new JsonParseError("This string has no closing quote.", start);
      const c = text[i];
      if (c === '"') {
        i++;
        return text.slice(start, i);
      }
      if (c === "\\") {
        const e = text[i + 1];
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6)))
            throw new JsonParseError('"\\u" must be followed by four hex digits.', i);
          i += 6;
        } else if (e !== undefined && ESCAPES.has(e)) {
          i += 2;
        } else {
          throw new JsonParseError(`"\\${e ?? ""}" isn't a valid escape in a JSON string.`, i);
        }
        continue;
      }
      if (c < " ") {
        throw new JsonParseError(
          c === "\n"
            ? "Strings can't span lines; write the line break as \\n."
            : "Strings can't hold control characters; escape them.",
          i,
        );
      }
      i++;
    }
  };

  const scalar = (): JsonNode => {
    const c = text[i];
    if (c === '"') return { type: "raw", text: string() };
    for (const word of ["true", "false", "null"]) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return { type: "raw", text: word };
      }
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (!m) throw new JsonParseError("This number isn't valid JSON.", i);
      // "01" or "1." stop early; the next character then gets the error below.
      i += m[0].length;
      return { type: "raw", text: m[0] };
    }
    if (c === "'") throw new JsonParseError("JSON strings use double quotes.", i);
    throw new JsonParseError(`Expected a value, found ${found(text, i)}.`, i);
  };

  type ObjectNode = Extract<JsonNode, { type: "object" }>;
  type ArrayNode = Extract<JsonNode, { type: "array" }>;
  /** An open container; for objects, the key whose value comes next. */
  type Frame = { node: ObjectNode | ArrayNode; key: { key: string; raw: string } | null };

  const stack: Frame[] = [];
  let root: JsonNode | null = null;

  /** Puts a finished value into its parent (or makes it the root). */
  const place = (value: JsonNode) => {
    const top = stack[stack.length - 1];
    if (!top) root = value;
    else if (top.node.type === "array") top.node.items.push(value);
    else {
      top.node.entries.push({ ...top.key!, value });
      top.key = null;
    }
  };

  /** Reads a key and its colon inside an object. */
  const readKey = (frame: Frame) => {
    skip();
    if (text[i] !== '"') {
      if (text[i] === "}")
        throw new JsonParseError("Remove the comma before }: JSON has no trailing commas.", i);
      throw new JsonParseError(`Expected a key in double quotes, found ${found(text, i)}.`, i);
    }
    const raw = string();
    skip();
    if (text[i] !== ":") throw new JsonParseError(`Expected ":" after the key, found ${found(text, i)}.`, i);
    i++;
    frame.key = { key: JSON.parse(raw) as string, raw };
  };

  /**
   * Reads the start of a value: a scalar is placed; an opened container is
   * pushed and, unless empty, the loop goes on to its first child.
   */
  const startValue = () => {
    for (;;) {
      skip();
      const c = text[i];
      if (c !== "{" && c !== "[") {
        place(scalar());
        return;
      }
      i++;
      const frame: Frame = {
        node: c === "{" ? { type: "object", entries: [] } : { type: "array", items: [] },
        key: null,
      };
      stack.push(frame);
      skip();
      if (text[i] === (c === "{" ? "}" : "]")) {
        i++;
        stack.pop();
        place(frame.node);
        return;
      }
      if (c === "{") readKey(frame);
    }
  };

  skip();
  if (i >= text.length) throw new JsonParseError("There's no JSON to read.", i);
  startValue();
  // After each value inside a container: a comma (next item) or the closing bracket.
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    skip();
    const close = top.node.type === "object" ? "}" : "]";
    if (text[i] === ",") {
      i++;
      if (top.node.type === "object") {
        readKey(top);
      } else {
        skip();
        if (text[i] === "]")
          throw new JsonParseError("Remove the comma before ]: JSON has no trailing commas.", i);
      }
      startValue();
    } else if (text[i] === close) {
      i++;
      stack.pop();
      place(top.node);
    } else {
      throw new JsonParseError(`Expected "," or "${close}", found ${found(text, i)}.`, i);
    }
  }
  skip();
  if (i < text.length) {
    throw new JsonParseError(`Unexpected ${found(text, i)} after the JSON value.`, i);
  }
  return root!;
}

export type Indent = "2" | "4" | "tab";

const INDENT_TEXT: Record<Indent, string> = { "2": "  ", "4": "    ", tab: "\t" };

/** Orders keys by their decoded text (UTF-16 order, like most tools); stable for duplicates. */
function sorted(entries: Extract<JsonNode, { type: "object" }>["entries"]) {
  return [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Writes a parsed document: indented with `indent`, or on one line with no
 * spaces when `indent` is null. Iterative, so deep documents are fine.
 */
export function stringifyJson(root: JsonNode, indent: Indent | null, sortKeys = false): string {
  const unit = indent === null ? "" : INDENT_TEXT[indent];
  const parts: string[] = [];
  // Work items: a node to write at a depth, or literal text.
  const work: ({ node: JsonNode; depth: number } | string)[] = [{ node: root, depth: 0 }];
  while (work.length > 0) {
    const item = work.pop()!;
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const { node, depth } = item;
    if (node.type === "raw") {
      parts.push(node.text);
      continue;
    }
    const [open, close] = node.type === "object" ? ["{", "}"] : ["[", "]"];
    const children =
      node.type === "object"
        ? (sortKeys ? sorted(node.entries) : node.entries).map((e) => ({
            prefix: e.raw + (unit ? ": " : ":"),
            value: e.value,
          }))
        : node.items.map((value) => ({ prefix: "", value }));
    if (children.length === 0) {
      parts.push(open + close);
      continue;
    }
    const inner = unit ? "\n" + unit.repeat(depth + 1) : "";
    const outer = unit ? "\n" + unit.repeat(depth) : "";
    // Pushed in reverse: the stack pops them in order.
    work.push(outer + close);
    for (let k = children.length - 1; k >= 0; k--) {
      work.push({ node: children[k].value, depth: depth + 1 });
      work.push((k === 0 ? open + inner : "," + inner) + children[k].prefix);
    }
  }
  return parts.join("");
}

export type JsonMode = "format" | "minify" | "escape" | "unescape";

export interface JsonOptions {
  mode: JsonMode;
  indent: Indent;
  sortKeys: boolean;
}

export type JsonResult = { ok: true; output: string } | { ok: false; error: JsonError };

function failure(text: string, message: string, offset: number): JsonResult {
  return { ok: false, error: { message, offset, ...lineColumn(text, offset) } };
}

/**
 * Runs the tool on `input`:
 * - format / minify: parse, optionally sort keys, write back;
 * - escape: turn any text into a JSON string literal (for JSON embedded in a string field);
 * - unescape: read a JSON string literal (the quotes are optional) back into its text.
 * Empty input gives empty output.
 */
export function transformJson(input: string, opts: JsonOptions): JsonResult {
  if (input.trim() === "") return { ok: true, output: "" };
  switch (opts.mode) {
    case "escape":
      return { ok: true, output: JSON.stringify(input) };
    case "unescape":
      return unescapeJson(input);
    default:
      try {
        const root = parseJson(input);
        return {
          ok: true,
          output: stringifyJson(root, opts.mode === "minify" ? null : opts.indent, opts.sortKeys),
        };
      } catch (e) {
        if (e instanceof JsonParseError) return failure(input, e.message, e.offset);
        throw e;
      }
  }
}

/** Offset of the first quote not escaped by a backslash, or -1. */
function strayQuote(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i;
  }
  return -1;
}

function unescapeJson(input: string): JsonResult {
  const trimmed = input.trim();
  const lead = input.indexOf(trimmed);
  const quoted = trimmed.startsWith('"');
  if (!quoted) {
    // Read as a string's contents: a bare quote would end it early.
    const q = strayQuote(trimmed);
    if (q >= 0) return failure(input, 'Escape the quote as \\" inside the string.', lead + q);
  }
  const literal = quoted ? trimmed : `"${trimmed}"`;
  // Offsets in `literal` → offsets in `input` (an added opening quote shifts them by one).
  const shift = quoted ? lead : lead - 1;
  try {
    parseJson(literal);
    return { ok: true, output: JSON.parse(literal) as string };
  } catch (e) {
    if (!(e instanceof JsonParseError)) throw e;
    const message = e.message.startsWith("Unexpected")
      ? 'Text follows the closing quote. Escape quotes inside the string as \\".'
      : e.message;
    return failure(input, message, Math.min(Math.max(e.offset + shift, lead), input.length));
  }
}
