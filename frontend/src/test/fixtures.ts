import { emptyAuth, emptyRequest } from "@/lib/model";
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
  TreeChild,
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
