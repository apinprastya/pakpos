import type {
  Webhook,
  WebhookRequestDetail,
  WebhookRequestSummary,
  WebhookRule,
  WebhookStatus,
} from "@/lib/webhookModel";
import { emptyAuth, emptyRequest } from "@/lib/model";
import {
  emptyRunSummary,
  type DataPreview,
  type RunListItem,
  type RunReport,
  type RunResult,
  type RunSummary,
} from "@/lib/runModel";
import type {
  UpdateInfo,
  CodeResult,
  Example,
  ExampleSummary,
  SaveExampleResult,
  Environment,
  PreviewVariable,
  ResolvePreview,
  Variable,
  CollectionNode,
  FolderNode,
  HistorySummary,
  RequestSummary,
  Response,
  SendResult,
  Hop,
  TreeChild,
  ConsoleEntry,
  OverlayValue,
  ScriptSource,
  TestResult,
  OAuth2Status,
} from "@/lib/model";

/** A send result with no response, error or variable notes; patch what the test needs. */
export function makeResult(patch: Partial<SendResult> = {}): SendResult {
  return {
    response: null,
    error: null,
    historyId: 0,
    unresolved: [],
    secretsLocked: false,
    environment: null,
    hops: [],
    tests: [],
    console: [],
    skipped: false,
    scriptError: null,
    ...patch,
  };
}

/** A history row; patch what the test needs. */
export function makeHistorySummary(id: number, patch: Partial<HistorySummary> = {}): HistorySummary {
  return {
    id,
    createdAt: "2026-11-14T10:00:00Z",
    workspaceId: "",
    requestId: "",
    requestName: "",
    method: "GET",
    url: `https://x/${id}`,
    status: 200,
    durationMs: 1,
    size: 1,
    errorKind: "",
    errorMessage: "",
    environmentName: "",
    ...patch,
  };
}

export function makeResponse(patch: Partial<Response> = {}): Response {
  return {
    statusCode: 200,
    statusText: "200 OK",
    proto: "HTTP/1.1",
    url: "https://api.example.com/users/42",
    headers: [
      { key: "Content-Type", value: "application/json", enabled: true },
      { key: "X-Request-Id", value: "abc123", enabled: true },
    ],
    cookies: [],
    contentType: "application/json",
    kind: "json",
    body: '{"id":42,"name":"Ada"}',
    encoding: "utf8",
    size: 22,
    truncated: false,
    bodyPath: "",
    timings: { dns: 3, connect: 10, tls: 25, ttfb: 80, total: 123, reusedConn: false },
    ...patch,
  };
}

/** Tree fixtures: `col("c1", "Users", [req("r1", "List"), folder("f1", "Auth", [...])])`. */
export function req(id: string, name = id, method = "GET", url = `https://api/${id}`): RequestSummary {
  return { kind: "request", id, name, method, url, seq: 0, parentId: "" };
}

export function folder(id: string, name = id, children: TreeChild[] = []): FolderNode {
  return { kind: "folder", id, name, seq: 0, parentId: "", children: withParent(children, id) };
}

export function col(id: string, name = id, children: TreeChild[] = []): CollectionNode {
  return { kind: "collection", id, name, seq: 0, children: withParent(children, id) };
}

function withParent(children: TreeChild[], parentId: string): TreeChild[] {
  return children.map((c, i) => ({ ...c, parentId, seq: i + 1 }));
}

/** A variable row; `secret` rows never carry a value. */
export function makeVar(key: string, value = "", patch: Partial<Variable> = {}): Variable {
  const v = { key, value, enabled: true, secret: false, ...patch };
  return v.secret ? { ...v, value: "" } : v;
}

export function makeEnv(id: string, name = id, variables: Variable[] = []): Environment {
  return { id, name, seq: 0, variables };
}

/** A resolve preview with nothing inherited; patch what the test needs. */
export function makePreview(patch: Partial<ResolvePreview> = {}): ResolvePreview {
  return {
    headers: [],
    overridden: [],
    auth: emptyAuth(),
    authSource: null,
    variables: [],
    unresolved: [],
    secretsLocked: false,
    environment: null,
    error: "",
    ...patch,
  };
}

/** A visible variable as Go's preview returns it (secret values are always ""). */
export function makePreviewVar(
  key: string,
  value = "",
  patch: Partial<PreviewVariable> = {},
): PreviewVariable {
  const v: PreviewVariable = {
    key,
    value,
    secret: false,
    scope: "environment",
    scopeId: "e1",
    scopeName: "Dev",
    set: true,
    overlay: "",
    ...patch,
  };
  return v.secret ? { ...v, value: "" } : v;
}

export function makeCodeResult(patch: Partial<CodeResult> = {}): CodeResult {
  return {
    code: "",
    unresolved: [],
    masked: [],
    secretsLocked: false,
    warnings: [],
    environment: null,
    ...patch,
  };
}

/** An example summary of request `requestId`; patch what the test needs. */
export function makeExampleSummary(
  id: string,
  requestId: string,
  patch: Partial<ExampleSummary> = {},
): ExampleSummary {
  return {
    id,
    requestId,
    name: "200 OK",
    savedAt: "2026-11-14T10:00:00Z",
    statusCode: 200,
    statusText: "200 OK",
    ...patch,
  };
}

/** A full example with a JSON response; patch what the test needs. */
export function makeExample(id: string, patch: Partial<Example> = {}): Example {
  return {
    id,
    name: "200 OK",
    savedAt: "2026-11-14T10:00:00Z",
    request: { ...emptyRequest(), name: "Get user", url: "{{baseUrl}}/users/42" },
    response: {
      statusCode: 200,
      statusText: "200 OK",
      headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
      contentType: "application/json",
      kind: "json",
      body: '{"id":42,"example":true}',
      encoding: "utf8",
      size: 24,
    },
    ...patch,
  };
}

/** What `saveExample` returns when it saved `summary`. */
export function savedExample(summary: ExampleSummary): SaveExampleResult {
  return { example: summary, secretsFound: [], secretsLocked: false };
}

/** A newer, installable release (override fields per test). */
export function makeUpdateInfo(over: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    current: "26.11.1",
    latest: "26.11.2",
    available: true,
    name: "Pakpos 26.11.2",
    notes: "Fixes",
    url: "https://github.com/apinprastya/pakpos/releases/tag/v26.11.2",
    publishedAt: "2026-11-10T00:00:00Z",
    canInstall: true,
    reason: "",
    ...over,
  };
}

/** One wire exchange (a 200 over TLS); patch what the test needs. */
export function makeHop(patch: Partial<Hop> = {}): Hop {
  return {
    method: "GET",
    url: "https://api.example/users",
    requestHeaders: [{ key: "Host", value: "api.example", enabled: true }],
    requestBody: "",
    requestBodyEncoding: "utf8",
    requestBodySize: 0,
    requestBodyTruncated: false,
    requestBodyNote: "",
    remoteAddr: "10.0.0.1:443",
    reusedConn: false,
    tls: "TLS 1.3",
    proto: "HTTP/1.1",
    statusCode: 200,
    statusText: "OK",
    responseHeaders: [{ key: "Content-Type", value: "application/json", enabled: true }],
    error: "",
    ...patch,
  };
}

/** Where a test or console line came from: the request's pre-request script unless patched. */
export function makeScriptSource(patch: Partial<ScriptSource> = {}): ScriptSource {
  return { kind: "request", id: "", name: "Get user", event: "prerequest", ...patch };
}

/** A passing pm.test from the request's test script; patch what the test needs. */
export function makeTestResult(name: string, patch: Partial<TestResult> = {}): TestResult {
  return {
    name,
    passed: true,
    skipped: false,
    error: "",
    source: makeScriptSource({ event: "test" }),
    ...patch,
  };
}

/** A console.log line from the request's pre-request script. */
export function makeConsoleEntry(text: string, patch: Partial<ConsoleEntry> = {}): ConsoleEntry {
  return { level: "log", text, source: makeScriptSource(), ...patch };
}

/** A value a script set on a scope this session (secret values are always ""). */
export function makeOverlayValue(key: string, value = "", patch: Partial<OverlayValue> = {}): OverlayValue {
  const v: OverlayValue = { key, value, state: "set", secret: false, ...patch };
  return v.secret ? { ...v, value: "" } : v;
}

/** A sent request of a run: 200 OK, no tests or console. */
export function makeRunResult(name: string, patch: Partial<RunResult> = {}): RunResult {
  return {
    iteration: 0,
    index: 0,
    requestId: `r-${name}`,
    name,
    method: "GET",
    startedAt: "2026-11-19T09:30:00Z",
    status: 200,
    statusText: "OK",
    durationMs: 12,
    size: 128,
    tests: [],
    console: [],
    error: null,
    skipped: false,
    secretsLocked: false,
    response: null,
    ...patch,
  };
}

/** An all-zero summary; patch the counts the test needs. */
export function makeRunSummary(patch: Partial<RunSummary> = {}): RunSummary {
  return { ...emptyRunSummary(), ...patch };
}

/** A finished run of collection `c1` ("API") with no results. */
export function makeRunReport(patch: Partial<RunReport> = {}): RunReport {
  return {
    id: "run-1",
    workspaceId: "ws1",
    target: { id: "c1", kind: "collection", name: "API", path: ["API"] },
    environmentId: "",
    environmentName: "",
    iterations: 1,
    delayMs: 0,
    dataFile: "",
    options: { stopOnFailure: false, keepVariables: true, saveResponses: false, recordHistory: false },
    requests: [],
    startedAt: "2026-11-19T09:30:00Z",
    finishedAt: "2026-11-19T09:30:01Z",
    outcome: "passed",
    error: "",
    results: [],
    summary: makeRunSummary(),
    ...patch,
  };
}

/** A stored run of collection `c1` in the past runs list. */
export function makeRunListItem(id: string, patch: Partial<RunListItem> = {}): RunListItem {
  return {
    id,
    createdAt: "2026-11-19T09:30:00Z",
    target: { id: "c1", kind: "collection", name: "API", path: [] },
    environmentName: "Dev",
    iterations: 1,
    dataFile: "",
    outcome: "passed",
    durationMs: 1000,
    totals: { requests: 2, errors: 0, skipped: 0, testsPassed: 2, testsFailed: 0 },
    ...patch,
  };
}

/** A data file preview with `user` and `pass` columns. */
export function makeDataPreview(patch: Partial<DataPreview> = {}): DataPreview {
  return {
    name: "users.csv",
    rows: 2,
    columns: ["user", "pass"],
    sample: [
      ["ana", "a1"],
      ["bo", "b2"],
    ],
    ...patch,
  };
}

export function makeOAuth2Status(patch: Partial<OAuth2Status> = {}): OAuth2Status {
  return {
    hasToken: true,
    locked: false,
    tokenType: "Bearer",
    scope: "read",
    expiresAt: 0,
    obtainedAt: 0,
    hasRefreshToken: true,
    hasIdToken: false,
    ...patch,
  };
}

export function makeWebhook(id = "h1", name = "Payments", patch: Partial<Webhook> = {}): Webhook {
  return {
    id,
    name,
    seq: 1,
    defaultResponse: {
      status: 200,
      headers: [{ key: "Content-Type", value: "application/json", enabled: true }],
      body: '{"ok": true}\n',
      delayMs: 0,
    },
    rules: [],
    ...patch,
  };
}

export function makeWebhookRule(id = "r1", patch: Partial<WebhookRule> = {}): WebhookRule {
  return {
    id,
    name: "Declined",
    enabled: true,
    match: { method: "POST", path: "/stripe/*", conditions: [] },
    response: { status: 400, headers: [], body: '{"error": "declined"}', delayMs: 0 },
    ...patch,
  };
}

export function makeWebhookStatus(patch: Partial<WebhookStatus> = {}): WebhookStatus {
  return {
    workspaceId: "w1",
    webhookId: "h1",
    name: "Payments",
    workspaceName: "Shop",
    state: "running",
    tunnel: true,
    localUrl: "http://127.0.0.1:40123",
    publicUrl: "https://brave-fox.trycloudflare.com",
    message: "",
    startedAt: "2026-11-21T10:00:00Z",
    ...patch,
  };
}

export function makeWebhookRequest(
  id = "q1",
  patch: Partial<WebhookRequestSummary> = {},
): WebhookRequestSummary {
  return {
    id,
    workspaceId: "w1",
    webhookId: "h1",
    receivedAt: "2026-11-21T10:00:05Z",
    method: "POST",
    path: "/stripe/events",
    query: "",
    bodySize: 15,
    truncated: false,
    remoteAddr: "203.0.113.7",
    ruleId: "",
    ruleName: "",
    status: 200,
    durationMs: 1.2,
    error: "",
    ...patch,
  };
}

export function makeWebhookDetail(
  entry: WebhookRequestSummary = makeWebhookRequest(),
  patch: Partial<WebhookRequestDetail> = {},
): WebhookRequestDetail {
  return {
    entry,
    headers: [
      { name: "Host", value: "brave-fox.trycloudflare.com" },
      { name: "Content-Type", value: "application/json" },
      { name: "Stripe-Signature", value: "t=1,v1=abc" },
    ],
    body: { text: '{"type":"paid"}', base64: "", binary: false, truncated: false },
    responseHeaders: [{ name: "Content-Type", value: "application/json" }],
    responseBody: { text: '{"ok": true}\n', base64: "", binary: false, truncated: false },
    ...patch,
  };
}
