import { compactRequest, emptyRequest, normalizeRequest, normalizeSendResult, requestsEqual } from "./model";

describe("model", () => {
  it("normalizes nulls and zero enums from Go", () => {
    const r = normalizeRequest({
      id: "1",
      method: "",
      query: null,
      headers: [{ key: "A", value: "b", enabled: true }],
      body: { type: "", formData: [{ key: "f" }], urlEncoded: null },
      auth: { type: "", apiIn: "" },
    });
    expect(r.method).toBe("GET");
    expect(r.query).toEqual([]);
    expect(r.headers).toEqual([{ key: "A", value: "b", enabled: true }]);
    expect(r.body.type).toBe("none");
    expect(r.body.language).toBe("json");
    expect(r.body.formData[0]).toEqual({
      key: "f",
      kind: "text",
      value: "",
      filePath: "",
      contentType: "",
      enabled: false,
    });
    expect(r.auth).toMatchObject({ type: "none", apiIn: "header" });
    expect(normalizeRequest(null)).toEqual(emptyRequest());
  });

  it("normalizes send results", () => {
    expect(normalizeSendResult(null)).toEqual({ response: null, error: null, historyId: 0 });
    const res = normalizeSendResult({
      response: { statusCode: 200, headers: null, cookies: null, timings: { total: 5 } },
      error: null,
      historyId: 3,
    });
    expect(res.response?.statusCode).toBe(200);
    expect(res.response?.headers).toEqual([]);
    expect(res.response?.timings.total).toBe(5);
    expect(res.historyId).toBe(3);
    expect(normalizeSendResult({ error: { kind: "dns", message: "no host" } }).error).toEqual({
      kind: "dns",
      message: "no host",
    });
    expect(normalizeSendResult({ response: {} }).response?.timings).toEqual({
      dns: 0,
      connect: 0,
      tls: 0,
      ttfb: 0,
      total: 0,
      reusedConn: false,
    });
  });

  it("compacts blank rows and compares ignoring them", () => {
    const a = emptyRequest();
    const b = {
      ...emptyRequest(),
      headers: [{ key: "", value: "", enabled: true }],
      body: {
        ...emptyRequest().body,
        formData: [
          { key: "", kind: "text" as const, value: "", filePath: "", contentType: "", enabled: true },
        ],
      },
    };
    expect(compactRequest(b).headers).toEqual([]);
    expect(requestsEqual(a, b)).toBe(true);
    expect(requestsEqual(a, { ...a, url: "x" })).toBe(false);
  });
});
