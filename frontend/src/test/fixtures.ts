import { emptyAuth } from "@/lib/model";
import type {
  Environment,
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
