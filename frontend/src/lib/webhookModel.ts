/**
 * Webhook test server types (Go core/webhook, hookserver, service) and pure
 * helpers. Kept apart from model.ts like runModel.ts.
 */
import { emptyRequest, type KeyValue, type RawLanguage, type Request } from "./model";

export const ANY_METHOD = "ANY";
export const CONDITION_SOURCES = ["header", "query", "body", "json"] as const;
export const CONDITION_OPS = ["equals", "contains", "exists", "matches"] as const;
export type ConditionSource = (typeof CONDITION_SOURCES)[number];
export type ConditionOp = (typeof CONDITION_OPS)[number];

/** Limits checked by Go's Validate (shown in the editor). */
export const MAX_DELAY_MS = 60_000;
export const MAX_RESPONSE_BODY = 1 << 20;

export interface Condition {
  source: ConditionSource;
  /** Header or query name, or the JSON dot path; unused for "body". */
  name: string;
  op: ConditionOp;
  /** Unused for "exists"; a Go regular expression for "matches". */
  value: string;
}

export interface WebhookMatch {
  /** "ANY" or one method. */
  method: string;
  /** "/", "/payments/*", "/orders/:id", "/hooks/**". */
  path: string;
  conditions: Condition[];
}

export interface WebhookResponse {
  status: number;
  headers: KeyValue[];
  body: string;
  delayMs: number;
}

export interface WebhookRule {
  id: string;
  name: string;
  enabled: boolean;
  match: WebhookMatch;
  response: WebhookResponse;
}

export interface Webhook {
  id: string;
  name: string;
  seq: number;
  defaultResponse: WebhookResponse;
  rules: WebhookRule[];
}

/** A problem Save found; `ruleId` "" is the webhook or its default response. */
export interface WebhookProblem {
  ruleId: string;
  field: string;
  message: string;
}

export type WebhookState = "running" | "tunnel-starting" | "tunnel-failed" | "stopped";

export interface WebhookStatus {
  workspaceId: string;
  webhookId: string;
  name: string;
  workspaceName: string;
  state: WebhookState;
  tunnel: boolean;
  localUrl: string;
  publicUrl: string;
  message: string;
  startedAt: string;
}

export interface WebhookHeader {
  name: string;
  value: string;
}

export interface WebhookRequestSummary {
  id: string;
  workspaceId: string;
  webhookId: string;
  receivedAt: string;
  method: string;
  path: string;
  query: string;
  bodySize: number;
  truncated: boolean;
  remoteAddr: string;
  ruleId: string;
  ruleName: string;
  status: number;
  durationMs: number;
  error: string;
}

export interface WebhookBody {
  text: string;
  base64: string;
  binary: boolean;
  truncated: boolean;
}

export interface WebhookRequestDetail {
  entry: WebhookRequestSummary;
  headers: WebhookHeader[];
  body: WebhookBody;
  responseHeaders: WebhookHeader[];
  responseBody: WebhookBody;
}

export interface CloudflaredStatus {
  found: boolean;
  path: string;
  /** "settings" | "downloaded" | "path" | "". */
  source: string;
  version: string;
  error: string;
  customPath: string;
  canDownload: boolean;
}

export interface InstallProgress {
  done: number;
  total: number;
}

// ---- normalizers (Go may send null slices) ----

type Loose<T> = { [K in keyof T]?: unknown } | null | undefined;

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const bool = (v: unknown): boolean => v === true;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function normalizeKV(v: unknown): KeyValue {
  const kv = (v ?? {}) as Loose<KeyValue>;
  return { key: str(kv?.key), value: str(kv?.value), enabled: bool(kv?.enabled) };
}

export function normalizeCondition(v: unknown): Condition {
  const c = (v ?? {}) as Loose<Condition>;
  const source = CONDITION_SOURCES.includes(c?.source as ConditionSource)
    ? (c!.source as ConditionSource)
    : "header";
  const op = CONDITION_OPS.includes(c?.op as ConditionOp) ? (c!.op as ConditionOp) : "equals";
  return { source, name: str(c?.name), op, value: str(c?.value) };
}

export function normalizeResponse(v: unknown): WebhookResponse {
  const r = (v ?? {}) as Loose<WebhookResponse>;
  return {
    status: num(r?.status, 200) || 200,
    headers: arr(r?.headers).map(normalizeKV),
    body: str(r?.body),
    delayMs: num(r?.delayMs),
  };
}

export function normalizeRule(v: unknown): WebhookRule {
  const r = (v ?? {}) as Loose<WebhookRule>;
  const m = (r?.match ?? {}) as Loose<WebhookMatch>;
  return {
    id: str(r?.id),
    name: str(r?.name),
    enabled: bool(r?.enabled),
    match: {
      method: str(m?.method, ANY_METHOD) || ANY_METHOD,
      path: str(m?.path),
      conditions: arr(m?.conditions).map(normalizeCondition),
    },
    response: normalizeResponse(r?.response),
  };
}

export function normalizeWebhook(v: unknown): Webhook {
  const w = (v ?? {}) as Loose<Webhook>;
  return {
    id: str(w?.id),
    name: str(w?.name),
    seq: num(w?.seq),
    defaultResponse: normalizeResponse(w?.defaultResponse),
    rules: arr(w?.rules).map(normalizeRule),
  };
}

export function normalizeProblem(v: unknown): WebhookProblem | null {
  if (!v || typeof v !== "object") return null;
  const p = v as { [K in keyof WebhookProblem]?: unknown };
  return { ruleId: str(p.ruleId), field: str(p.field), message: str(p.message) };
}

const STATES: WebhookState[] = ["running", "tunnel-starting", "tunnel-failed", "stopped"];

export function normalizeStatus(v: unknown): WebhookStatus {
  const s = (v ?? {}) as Loose<WebhookStatus>;
  return {
    workspaceId: str(s?.workspaceId),
    webhookId: str(s?.webhookId),
    name: str(s?.name),
    workspaceName: str(s?.workspaceName),
    state: STATES.includes(s?.state as WebhookState) ? (s!.state as WebhookState) : "stopped",
    tunnel: bool(s?.tunnel),
    localUrl: str(s?.localUrl),
    publicUrl: str(s?.publicUrl),
    message: str(s?.message),
    startedAt: str(s?.startedAt),
  };
}

export function normalizeRequestSummary(v: unknown): WebhookRequestSummary {
  const r = (v ?? {}) as Loose<WebhookRequestSummary>;
  return {
    id: str(r?.id),
    workspaceId: str(r?.workspaceId),
    webhookId: str(r?.webhookId),
    receivedAt: str(r?.receivedAt),
    method: str(r?.method),
    path: str(r?.path, "/") || "/",
    query: str(r?.query),
    bodySize: num(r?.bodySize),
    truncated: bool(r?.truncated),
    remoteAddr: str(r?.remoteAddr),
    ruleId: str(r?.ruleId),
    ruleName: str(r?.ruleName),
    status: num(r?.status),
    durationMs: num(r?.durationMs),
    error: str(r?.error),
  };
}

function normalizeBody(v: unknown): WebhookBody {
  const b = (v ?? {}) as Loose<WebhookBody>;
  return {
    text: str(b?.text),
    base64: str(b?.base64),
    binary: bool(b?.binary),
    truncated: bool(b?.truncated),
  };
}

function normalizeHeaders(v: unknown): WebhookHeader[] {
  return arr(v).map((h) => {
    const x = (h ?? {}) as Loose<WebhookHeader>;
    return { name: str(x?.name), value: str(x?.value) };
  });
}

export function normalizeRequestDetail(v: unknown): WebhookRequestDetail {
  const d = (v ?? {}) as Loose<WebhookRequestDetail>;
  return {
    entry: normalizeRequestSummary(d?.entry),
    headers: normalizeHeaders(d?.headers),
    body: normalizeBody(d?.body),
    responseHeaders: normalizeHeaders(d?.responseHeaders),
    responseBody: normalizeBody(d?.responseBody),
  };
}

export function normalizeCloudflared(v: unknown): CloudflaredStatus {
  const c = (v ?? {}) as Loose<CloudflaredStatus>;
  return {
    found: bool(c?.found),
    path: str(c?.path),
    source: str(c?.source),
    version: str(c?.version),
    error: str(c?.error),
    customPath: str(c?.customPath),
    canDownload: bool(c?.canDownload),
  };
}

// ---- helpers ----

/** Key of a running webhook in the statuses map (webhooks keep running across workspaces). */
export function statusKey(workspaceId: string, webhookId: string): string {
  return `${workspaceId}:${webhookId}`;
}

/** The URL senders should use: the public one when the tunnel is up, else the local one. */
export function webhookUrl(s: WebhookStatus | undefined): string {
  if (!s) return "";
  return s.publicUrl || s.localUrl;
}

export function isRunning(s: WebhookStatus | undefined): s is WebhookStatus {
  return !!s && s.state !== "stopped";
}

let ruleCounter = 0;
/** A temporary id for a rule added in the editor; Go keeps any non-empty id. */
export function newRuleId(): string {
  ruleCounter += 1;
  return `new-${Date.now().toString(36)}-${ruleCounter}`;
}

export function emptyResponse(): WebhookResponse {
  return { status: 200, headers: [], body: "", delayMs: 0 };
}

export function newRule(partial: Partial<WebhookMatch> = {}): WebhookRule {
  return {
    id: newRuleId(),
    name: "",
    enabled: true,
    match: { method: ANY_METHOD, path: "/", conditions: [], ...partial },
    response: emptyResponse(),
  };
}

export function newCondition(): Condition {
  return { source: "header", name: "", op: "equals", value: "" };
}

/** Drops blank header rows so they don't count as changes or get saved. */
function compactResponse(r: WebhookResponse): WebhookResponse {
  return { ...r, headers: r.headers.filter((h) => h.key !== "" || h.value !== "") };
}

export function compactWebhook(w: Webhook): Webhook {
  return {
    ...w,
    defaultResponse: compactResponse(w.defaultResponse),
    rules: w.rules.map((r) => ({ ...r, response: compactResponse(r.response) })),
  };
}

export function webhooksEqual(a: Webhook, b: Webhook): boolean {
  return JSON.stringify(compactWebhook(a)) === JSON.stringify(compactWebhook(b));
}

/** A rule matching a logged request's method and exact path. */
export function ruleFromRequest(entry: WebhookRequestSummary): WebhookRule {
  const rule = newRule({ method: entry.method || ANY_METHOD, path: entry.path || "/" });
  rule.name = `${entry.method} ${entry.path}`;
  return rule;
}

/** "/path?query" of a logged request. */
export function requestTarget(entry: Pick<WebhookRequestSummary, "path" | "query">): string {
  return entry.query ? `${entry.path}?${entry.query}` : entry.path;
}

/** Headers net/http or cloudflared add that a replayed request shouldn't copy. */
const SKIP_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "accept-encoding",
  "cdn-loop",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-warp-tag-id",
  "x-forwarded-for",
  "x-forwarded-proto",
]);

export function replayHeaders(headers: WebhookHeader[]): WebhookHeader[] {
  return headers.filter((h) => !SKIP_HEADERS.has(h.name.toLowerCase()));
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A cURL command that sends the logged request again to `baseUrl`. Binary bodies are left out. */
export function curlFor(detail: WebhookRequestDetail, baseUrl: string): string {
  const e = detail.entry;
  const url = baseUrl.replace(/\/+$/, "") + requestTarget(e);
  // One flag and its value per line.
  const lines = ["curl"];
  if (e.method !== "GET") lines.push(`-X ${e.method}`);
  lines.push(shellQuote(url));
  for (const h of replayHeaders(detail.headers)) lines.push(`-H ${shellQuote(`${h.name}: ${h.value}`)}`);
  if (!detail.body.binary && detail.body.text) lines.push(`--data-raw ${shellQuote(detail.body.text)}`);
  return lines.join(" \\\n  ");
}

export function languageFor(contentType: string, text: string): RawLanguage {
  const ct = contentType.toLowerCase();
  if (ct.includes("json")) return "json";
  if (ct.includes("html")) return "html";
  if (ct.includes("xml")) return "xml";
  if (ct.includes("javascript")) return "javascript";
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return "json";
  if (t.startsWith("<")) return "xml";
  return "text";
}

export function headerValue(headers: WebhookHeader[], name: string): string {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value ?? "";
}

/** A request tab draft for a logged request, sent to `baseUrl` (to replay it elsewhere). */
export function requestFor(detail: WebhookRequestDetail, baseUrl: string): Request {
  const e = detail.entry;
  const req = emptyRequest();
  req.method = e.method || "GET";
  req.url = (baseUrl.replace(/\/+$/, "") || "http://localhost") + requestTarget(e);
  req.name = `${e.method} ${e.path}`;
  req.headers = replayHeaders(detail.headers).map((h) => ({ key: h.name, value: h.value, enabled: true }));
  if (!detail.body.binary && detail.body.text) {
    req.body = {
      ...req.body,
      type: "raw",
      raw: detail.body.text,
      language: languageFor(headerValue(detail.headers, "Content-Type"), detail.body.text),
    };
  }
  return req;
}

/** Human size: "512 B", "1.5 KB", "2.0 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Template references for response completions and help (Go core/webhook render.go). */
export const TEMPLATE_REFS: { label: string; detail: string }[] = [
  { label: "$request.method", detail: "Request method" },
  { label: "$request.path", detail: "Request path" },
  { label: "$request.url", detail: "Path and query" },
  { label: "$request.body", detail: "The whole body" },
  { label: "$request.query.", detail: "A query parameter: .query.name" },
  { label: "$request.header.", detail: "A header: .header.X-Name" },
  { label: "$request.params.", detail: "A path parameter from :name" },
  { label: "$request.json.", detail: "A JSON value: .json.data.id" },
  { label: "$randomUUID", detail: "A random UUID" },
  { label: "$timestamp", detail: "Unix time in seconds" },
  { label: "$isoTimestamp", detail: "ISO 8601 time" },
  { label: "$randomInt", detail: "A random number 0–1000" },
];
