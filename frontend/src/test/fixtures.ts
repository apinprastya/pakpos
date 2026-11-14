import type { CollectionNode, FolderNode, RequestSummary, Response, TreeChild } from "@/lib/model";

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
