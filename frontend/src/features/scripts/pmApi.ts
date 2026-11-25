import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import type { ScriptEvent } from "@/lib/model";

/**
 * A static description of what Pakpos scripts can use (Go
 * `internal/core/script/prelude.js` and `expect.js`), for completions.
 * Keep it in step with the prelude when the `pm` API changes.
 */
export interface ApiEntry {
  name: string;
  kind: "property" | "method";
  /** Shown beside the name, e.g. "(key, value)". */
  detail: string;
  /** One short sentence. */
  doc: string;
  /** What the property holds or the method returns, when it has members. */
  type?: TypeName;
  /** Only valid in this script; omitted when valid in both. */
  only?: ScriptEvent;
}

export type TypeName =
  | "pm"
  | "scope"
  | "environment"
  | "request"
  | "url"
  | "requestHeaders"
  | "body"
  | "response"
  | "responseHeaders"
  | "info"
  | "iterationData"
  | "execution"
  | "test"
  | "assertion"
  | "responseAssertion"
  | "console"
  | "postman"
  | "cookies"
  | "cookieJar";

const prop = (name: string, doc: string, type?: TypeName, only?: ScriptEvent): ApiEntry => ({
  name,
  kind: "property",
  detail: "",
  doc,
  type,
  only,
});
const fn = (name: string, detail: string, doc: string, type?: TypeName, only?: ScriptEvent): ApiEntry => ({
  name,
  kind: "method",
  detail,
  doc,
  type,
  only,
});

const SCOPE: ApiEntry[] = [
  fn("get", "(key)", "The variable's value as a string, or undefined."),
  fn("set", "(key, value)", "Sets the variable for this session. Objects are stored as JSON."),
  fn("unset", "(key)", "Hides the variable for this session (the file keeps it)."),
  fn("has", "(key)", "True when the variable is defined."),
  fn("toObject", "()", "Every variable of the scope as an object."),
  fn("replaceIn", "(text)", "Replaces {{variables}} in the text."),
];

const HEADERS_READ: ApiEntry[] = [
  fn("get", "(name)", "The header's value, or undefined (case-insensitive)."),
  fn("has", "(name, value?)", "True when the header is present (with that value, if given)."),
  fn("each", "(fn)", "Calls fn({key, value}) for each header."),
  fn("all", "()", "The headers as a list of {key, value}."),
  fn("count", "()", "How many headers there are."),
  fn("toObject", "()", "The headers as an object."),
];

const ASSERTION_WORDS = [
  "to",
  "be",
  "been",
  "is",
  "that",
  "which",
  "and",
  "has",
  "have",
  "with",
  "at",
  "of",
  "same",
  "does",
  "but",
  "also",
  "still",
  "not",
  "deep",
  "own",
  "any",
  "all",
];

const ASSERTION: ApiEntry[] = [
  ...ASSERTION_WORDS.map((w) => prop(w, "Reads well; chains on.", "assertion")),
  fn("equal", "(value)", "Strictly equal (===).", "assertion"),
  fn("eql", "(value)", "Deeply equal.", "assertion"),
  fn("a", "(type)", "Of the type, e.g. 'string', 'object', 'array'.", "assertion"),
  fn("an", "(type)", "Of the type, e.g. 'object', 'array'.", "assertion"),
  fn("include", "(value)", "Contains the value (string, array or object subset).", "assertion"),
  fn("contain", "(value)", "Same as include.", "assertion"),
  fn("string", "(text)", "A string containing the text.", "assertion"),
  fn("property", "(name, value?)", "Has the property (with that value, if given).", "assertion"),
  fn("ownProperty", "(name)", "Has the property itself, not inherited.", "assertion"),
  fn("lengthOf", "(n)", "Has a length of n.", "assertion"),
  fn("above", "(n)", "Greater than n.", "assertion"),
  fn("below", "(n)", "Less than n.", "assertion"),
  fn("least", "(n)", "At least n.", "assertion"),
  fn("most", "(n)", "At most n.", "assertion"),
  fn("within", "(low, high)", "Between low and high, inclusive.", "assertion"),
  fn("closeTo", "(value, delta)", "Within delta of value.", "assertion"),
  fn("match", "(regexp)", "A string matching the pattern.", "assertion"),
  fn("oneOf", "(list)", "One of the listed values.", "assertion"),
  fn("keys", "(...names)", "Has exactly these keys (any, with .any).", "assertion"),
  fn("members", "(list)", "Has the same members as the list.", "assertion"),
  fn("instanceOf", "(constructor)", "An instance of the constructor.", "assertion"),
  fn("satisfy", "(fn)", "fn(value) returns true.", "assertion"),
  fn("jsonSchema", "(schema)", "Matches the JSON schema (draft-07 unless $schema says otherwise)."),
  fn("throw", "(error?)", "The function throws.", "assertion"),
  fn("fail", "(message?)", "Always fails."),
  prop("ok", "Truthy."),
  prop("true", "Exactly true."),
  prop("false", "Exactly false."),
  prop("null", "Exactly null."),
  prop("undefined", "Exactly undefined."),
  prop("NaN", "Not a number."),
  prop("exist", "Neither null nor undefined."),
  prop("empty", "An empty string, array or object."),
];

const RESPONSE_ASSERTION: ApiEntry[] = [
  prop("to", "Reads well; chains on.", "responseAssertion"),
  prop("be", "Reads well; chains on.", "responseAssertion"),
  prop("have", "Reads well; chains on.", "responseAssertion"),
  prop("not", "Negates what follows.", "responseAssertion"),
  fn("status", "(code | reason)", "Has the status code (200) or reason phrase ('OK')."),
  fn("header", "(name, value?)", "Has the header (with that value, if given)."),
  fn("jsonBody", "(path?, value?)", "The body is JSON (with the path, and value, if given)."),
  fn("body", "(text?)", "Has a body (equal to the text, if given)."),
  fn("jsonSchema", "(schema)", "The JSON body matches the schema (draft-07 unless $schema says otherwise)."),
  prop("ok", "Status code 200."),
  prop("success", "A 2xx status code."),
  prop("error", "A 4xx or 5xx status code."),
  prop("clientError", "A 4xx status code."),
  prop("serverError", "A 5xx status code."),
  prop("json", "The body is valid JSON."),
];

/** Members of each type. */
export const TYPES: Record<TypeName, ApiEntry[]> = {
  pm: [
    prop("environment", "Variables of the selected environment.", "environment"),
    prop("collectionVariables", "Variables of the request's collection.", "scope"),
    prop("globals", "Global variables of the workspace.", "scope"),
    prop("variables", "Every visible variable; set() writes a local value for this send only.", "scope"),
    prop("request", "The request as it will be sent; changeable in pre-request scripts.", "request"),
    prop("response", "The response.", "response", "test"),
    prop("info", "About this run: event, request name and id, iteration.", "info"),
    prop("iterationData", "The runner's current data row.", "iterationData"),
    prop("execution", "Skip this request, or pick the runner's next one.", "execution"),
    fn("test", "(name, fn)", "Records a test: it passes unless fn throws.", "test"),
    fn("expect", "(value)", "Starts an assertion, e.g. pm.expect(x).to.equal(1).", "assertion"),
    fn(
      "sendRequest",
      "(request, callback?)",
      "Sends a request (a URL or {url, method, header, body, auth}); the callback gets (err, response), or await the promise it returns.",
    ),
    prop("cookies", "Cookies sent to the request's URL; jar() reads and changes any URL's.", "cookies"),
  ],
  scope: SCOPE,
  environment: [...SCOPE, prop("name", "The selected environment's name.")],
  request: [
    prop("url", "The URL. Assign a string to change it.", "url"),
    prop("method", "The HTTP method. Assign to change it."),
    prop("headers", "The request's enabled headers.", "requestHeaders"),
    prop("body", "The request body.", "body"),
    prop("id", "The saved request's id."),
    prop("name", "The request's name."),
  ],
  url: [
    fn("toString", "()", "The URL as text."),
    fn("getQueryString", "()", "The query string without the leading ?."),
    fn(
      "addQueryParams",
      "(params)",
      "Adds query parameters ('a=1', {key, value} or a list).",
      undefined,
      "prerequest",
    ),
    fn("removeQueryParams", "(names)", "Removes query parameters by name.", undefined, "prerequest"),
  ],
  requestHeaders: [
    ...HEADERS_READ,
    fn("add", "({key, value})", "Adds a header.", undefined, "prerequest"),
    fn(
      "upsert",
      "({key, value})",
      "Sets a header, replacing one with the same name.",
      undefined,
      "prerequest",
    ),
    fn("remove", "(name)", "Removes every header with the name.", undefined, "prerequest"),
  ],
  body: [
    prop("mode", "raw, urlencoded, formdata, file or none."),
    prop("raw", "The raw body text. Assign to replace it."),
    fn("update", "(text)", "Replaces the body with raw text.", undefined, "prerequest"),
    fn("toString", "()", "The body as text (raw or urlencoded)."),
  ],
  response: [
    prop("code", "The status code, e.g. 200."),
    prop("status", "The reason phrase, e.g. 'OK'."),
    prop("responseTime", "How long the request took, in milliseconds."),
    prop("responseSize", "The body size in bytes."),
    prop("headers", "The response headers.", "responseHeaders"),
    fn("text", "()", "The body as text."),
    fn("json", "()", "The body parsed as JSON (throws if it isn't JSON)."),
    prop("to", "Assertions on the response, e.g. pm.response.to.have.status(200).", "responseAssertion"),
  ],
  responseHeaders: HEADERS_READ,
  info: [
    prop("eventName", "'prerequest' or 'test'."),
    prop("requestName", "The request's name."),
    prop("requestId", "The saved request's id."),
    prop("iteration", "The runner iteration, from 0."),
    prop("iterationCount", "How many iterations the runner does."),
  ],
  iterationData: [
    fn("get", "(key)", "The value in the current data row."),
    fn("has", "(key)", "True when the data row has the key."),
    fn("toObject", "()", "The data row as an object."),
  ],
  execution: [
    fn(
      "skipRequest",
      "()",
      "Doesn't send this request; later pre-request scripts don't run.",
      undefined,
      "prerequest",
    ),
    fn("setNextRequest", "(name | null)", "The runner goes to this request next (null stops it)."),
  ],
  test: [fn("skip", "(name)", "Records a skipped test.")],
  assertion: ASSERTION,
  responseAssertion: RESPONSE_ASSERTION,
  console: [
    fn("log", "(...values)", "Writes to the console."),
    fn("info", "(...values)", "Writes an info line to the console."),
    fn("warn", "(...values)", "Writes a warning to the console."),
    fn("error", "(...values)", "Writes an error to the console."),
    fn("debug", "(...values)", "Writes a debug line to the console."),
  ],
  postman: [fn("setNextRequest", "(name | null)", "Same as pm.execution.setNextRequest.")],
  cookies: [
    fn("get", "(name)", "The cookie's value, or undefined."),
    fn("has", "(name, value?)", "True when the cookie is sent (with that value, if given)."),
    fn("all", "()", "The cookies as a list of {name, value, domain, path, …}."),
    fn("count", "()", "How many cookies are sent."),
    fn("each", "(fn)", "Calls fn(cookie) for each cookie."),
    fn("toObject", "()", "The cookies as an object of name → value."),
    fn("jar", "()", "The cookie jar, for cookies of any URL.", "cookieJar"),
  ],
  cookieJar: [
    fn("get", "(url, name, callback?)", "The value of a cookie sent to the URL."),
    fn("getAll", "(url, callback?)", "Every cookie sent to the URL."),
    fn(
      "set",
      "(url, name, value, callback?)",
      "Sets a cookie for the URL (or pass {name, value, path, expires, …}).",
    ),
    fn("unset", "(url, name, callback?)", "Deletes the cookie sent to the URL."),
    fn("clear", "(url, callback?)", "Deletes every cookie sent to the URL."),
  ],
};

/** Names a script can start with. */
export const GLOBALS: ApiEntry[] = [
  prop("pm", "The Pakpos scripting API (Postman-compatible).", "pm"),
  prop("console", "Writes to the console drawer.", "console"),
  prop("postman", "Legacy Postman helpers.", "postman"),
  fn("btoa", "(text)", "Encodes Latin-1 text as base64."),
  fn("atob", "(base64)", "Decodes base64 to Latin-1 text."),
];

/** One step of a member path: a name, and whether it's called (`expect(…)`). */
interface Step {
  name: string;
  call: boolean;
}

/**
 * The member path before a `.` that ends at `end` in `text`, outermost
 * first, e.g. `pm.expect(a.b).to.` → pm, expect(), to. Null when the
 * expression isn't a plain chain of names and calls.
 */
export function pathBefore(text: string, end: number): Step[] | null {
  const steps: Step[] = [];
  let i = end;
  for (;;) {
    // i points just past a segment: a name, optionally followed by (...).
    let call = false;
    if (text[i - 1] === ")") {
      let depth = 0;
      let j = i - 1;
      for (; j >= 0; j--) {
        if (text[j] === ")") depth++;
        else if (text[j] === "(" && --depth === 0) break;
      }
      if (j < 0) return null;
      call = true;
      i = j;
    }
    const m = /[\w$]+$/.exec(text.slice(0, i));
    if (!m) return null;
    steps.unshift({ name: m[0], call });
    i -= m[0].length;
    if (text[i - 1] !== ".") break;
    i -= 1;
  }
  return steps;
}

/** Whether an entry applies to scripts of `event`. */
function validIn(entry: ApiEntry, event: ScriptEvent): boolean {
  return !entry.only || entry.only === event;
}

/** The members after `path` (from `pathBefore`), or null when it's not part of the API. */
export function membersAt(path: Step[], event: ScriptEvent): ApiEntry[] | null {
  let list: ApiEntry[] = GLOBALS;
  for (const step of path) {
    const entry = list.find((e) => e.name === step.name && validIn(e, event));
    if (!entry?.type) return null;
    // A method's members exist only on its result; a property's only without a call.
    if ((entry.kind === "method") !== step.call) return null;
    list = TYPES[entry.type];
  }
  return list.filter((e) => validIn(e, event));
}

function toCompletion(e: ApiEntry, boost = 0): Completion {
  return {
    label: e.name,
    type: e.kind === "method" ? "method" : "property",
    detail: e.detail || undefined,
    info: e.doc,
    boost,
  };
}

/**
 * A CodeMirror completion source for `pm` and the other script globals, for
 * scripts of `event` (members valid only in the other script are left out).
 */
export function pmCompletions(event: ScriptEvent): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    const word = /[\w$]*$/.exec(before)![0];
    const from = ctx.pos - word.length;
    const at = before.length - word.length;
    if (before[at - 1] === ".") {
      const path = pathBefore(before, at - 1);
      const members = path && membersAt(path, event);
      if (!members) return null;
      return { from, options: members.map((e) => toCompletion(e)), validFor: /^[\w$]*$/ };
    }
    // A bare name: offer the globals while typing one (or on Ctrl+Space).
    if (!word && !ctx.explicit) return null;
    // Not after a word character or a quote: inside strings and numbers isn't a name.
    if (/[\w$'"`]$/.test(before.slice(0, at))) return null;
    return { from, options: GLOBALS.map((e) => toCompletion(e, 1)), validFor: /^[\w$]*$/ };
  };
}
