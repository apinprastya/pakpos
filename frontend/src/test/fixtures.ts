import type { Response } from "@/lib/model";

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
