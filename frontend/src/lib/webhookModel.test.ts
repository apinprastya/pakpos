import { makeWebhook, makeWebhookDetail, makeWebhookRequest, makeWebhookStatus } from "@/test/fixtures";
import {
  compactWebhook,
  curlFor,
  formatSize,
  headerValue,
  isRunning,
  languageFor,
  newCondition,
  newRule,
  normalizeCloudflared,
  normalizeProblem,
  normalizeRequestDetail,
  normalizeRequestSummary,
  normalizeStatus,
  normalizeWebhook,
  replayHeaders,
  requestFor,
  requestTarget,
  ruleFromRequest,
  statusKey,
  webhookUrl,
  webhooksEqual,
} from "./webhookModel";

describe("webhook normalizers", () => {
  it("fills missing fields and null slices", () => {
    expect(normalizeWebhook(null)).toEqual({
      id: "",
      name: "",
      seq: 0,
      defaultResponse: { status: 200, headers: [], body: "", delayMs: 0 },
      rules: [],
    });
    const w = normalizeWebhook({
      id: "h",
      name: "Hook",
      seq: 2,
      defaultResponse: { status: 204, headers: null, body: "x", delayMs: 5 },
      rules: [
        {
          id: "r",
          enabled: true,
          match: { method: "", path: "/a", conditions: [{ source: "cookie", op: "nope" }, null] },
          response: { status: 0, headers: [{ key: "X", value: "1", enabled: true }, null] },
        },
      ],
    });
    expect(w.defaultResponse).toEqual({ status: 204, headers: [], body: "x", delayMs: 5 });
    const r = w.rules[0];
    expect(r.match.method).toBe("ANY");
    expect(r.match.conditions).toEqual([
      { source: "header", name: "", op: "equals", value: "" },
      { source: "header", name: "", op: "equals", value: "" },
    ]);
    expect(r.response.status).toBe(200);
    expect(r.response.headers).toEqual([
      { key: "X", value: "1", enabled: true },
      { key: "", value: "", enabled: false },
    ]);
    expect(r.name).toBe("");
  });

  it("normalizes statuses, log rows, details and cloudflared", () => {
    expect(normalizeStatus({ state: "weird" }).state).toBe("stopped");
    expect(normalizeStatus(makeWebhookStatus({ state: "tunnel-failed" })).state).toBe("tunnel-failed");
    expect(normalizeRequestSummary({ path: "" }).path).toBe("/");
    expect(normalizeRequestSummary(undefined)).toMatchObject({ id: "", status: 0, truncated: false });
    const d = normalizeRequestDetail({ entry: makeWebhookRequest(), headers: null, body: null });
    expect(d.headers).toEqual([]);
    expect(d.body).toEqual({ text: "", base64: "", binary: false, truncated: false });
    expect(normalizeRequestDetail({ headers: [{ name: "A", value: "b" }, null] }).headers).toEqual([
      { name: "A", value: "b" },
      { name: "", value: "" },
    ]);
    expect(normalizeCloudflared(null)).toMatchObject({ found: false, canDownload: false, path: "" });
    expect(normalizeProblem(null)).toBeNull();
    expect(normalizeProblem({ ruleId: "r", field: "path", message: "Bad" })).toEqual({
      ruleId: "r",
      field: "path",
      message: "Bad",
    });
  });
});

describe("webhook helpers", () => {
  it("keys and URLs of statuses", () => {
    expect(statusKey("w", "h")).toBe("w:h");
    expect(webhookUrl(undefined)).toBe("");
    expect(webhookUrl(makeWebhookStatus())).toBe("https://brave-fox.trycloudflare.com");
    expect(webhookUrl(makeWebhookStatus({ publicUrl: "" }))).toBe("http://127.0.0.1:40123");
    expect(isRunning(undefined)).toBe(false);
    expect(isRunning(makeWebhookStatus({ state: "stopped" }))).toBe(false);
    expect(isRunning(makeWebhookStatus({ state: "tunnel-failed" }))).toBe(true);
  });

  it("compares webhooks ignoring blank header rows", () => {
    const a = makeWebhook();
    const b = makeWebhook();
    b.defaultResponse.headers = [...b.defaultResponse.headers, { key: "", value: "", enabled: true }];
    expect(webhooksEqual(a, b)).toBe(true);
    expect(compactWebhook(b).defaultResponse.headers).toHaveLength(1);
    b.rules = [newRule()];
    b.rules[0].response.headers = [{ key: "", value: "", enabled: false }];
    expect(compactWebhook(b).rules[0].response.headers).toEqual([]);
    expect(webhooksEqual(a, b)).toBe(false);
  });

  it("makes new rules and conditions", () => {
    const r1 = newRule();
    const r2 = newRule({ method: "POST" });
    expect(r1.id).not.toBe(r2.id);
    expect(r1.match).toEqual({ method: "ANY", path: "/", conditions: [] });
    expect(r2.match.method).toBe("POST");
    expect(newCondition()).toEqual({ source: "header", name: "", op: "equals", value: "" });
    const fromReq = ruleFromRequest(makeWebhookRequest("q", { method: "PUT", path: "/a/b" }));
    expect(fromReq).toMatchObject({
      name: "PUT /a/b",
      enabled: true,
      match: { method: "PUT", path: "/a/b" },
    });
    expect(ruleFromRequest(makeWebhookRequest("q", { method: "", path: "" })).match).toMatchObject({
      method: "ANY",
      path: "/",
    });
  });

  it("builds the request target and replay headers", () => {
    expect(requestTarget({ path: "/a", query: "" })).toBe("/a");
    expect(requestTarget({ path: "/a", query: "x=1" })).toBe("/a?x=1");
    expect(
      replayHeaders([
        { name: "Host", value: "x" },
        { name: "CF-Ray", value: "1" },
        { name: "X-Keep", value: "y" },
      ]),
    ).toEqual([{ name: "X-Keep", value: "y" }]);
    expect(headerValue([{ name: "content-type", value: "a/b" }], "Content-Type")).toBe("a/b");
    expect(headerValue([], "X")).toBe("");
  });

  it("writes a cURL command for a logged request", () => {
    const d = makeWebhookDetail(makeWebhookRequest("q", { query: "a=1" }));
    d.body.text = "it's";
    expect(curlFor(d, "https://x.example/")).toBe(
      [
        "curl",
        "-X POST",
        "'https://x.example/stripe/events?a=1'",
        "-H 'Content-Type: application/json'",
        "-H 'Stripe-Signature: t=1,v1=abc'",
        "--data-raw 'it'\\''s'",
      ].join(" \\\n  "),
    );
    const get = makeWebhookDetail(makeWebhookRequest("q", { method: "GET" }), {
      headers: [],
      body: { text: "", base64: "AA==", binary: true, truncated: false },
    });
    expect(curlFor(get, "http://h")).toBe("curl \\\n  'http://h/stripe/events'");
  });

  it("turns a logged request into a request tab draft", () => {
    const r = requestFor(makeWebhookDetail(), "http://localhost:3000/");
    expect(r).toMatchObject({
      method: "POST",
      url: "http://localhost:3000/stripe/events",
      name: "POST /stripe/events",
      body: { type: "raw", raw: '{"type":"paid"}', language: "json" },
    });
    expect(r.headers.map((h) => h.key)).toEqual(["Content-Type", "Stripe-Signature"]);
    const bin = requestFor(
      makeWebhookDetail(makeWebhookRequest("q", { method: "" }), {
        body: { text: "", base64: "AA==", binary: true, truncated: false },
      }),
      "",
    );
    expect(bin.method).toBe("GET");
    expect(bin.url).toBe("http://localhost/stripe/events");
    expect(bin.body.type).toBe("none");
  });

  it("picks an editor language and formats sizes", () => {
    expect(languageFor("application/json; charset=utf-8", "")).toBe("json");
    expect(languageFor("text/html", "")).toBe("html");
    expect(languageFor("application/xml", "")).toBe("xml");
    expect(languageFor("application/javascript", "")).toBe("javascript");
    expect(languageFor("", "  [1]")).toBe("json");
    expect(languageFor("", "<a/>")).toBe("xml");
    expect(languageFor("text/plain", "hi")).toBe("text");
    expect(formatSize(12)).toBe("12 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
