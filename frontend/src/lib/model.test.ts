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

describe("sidebar model helpers", () => {
  it("normalizeTree fills nulls and defaults", async () => {
    const { normalizeTree } = await import("./model");
    expect(normalizeTree(null)).toEqual({ collections: [], problems: [] });
    expect(
      normalizeTree({
        collections: [
          {
            id: "c",
            name: "C",
            seq: 1,
            children: [
              { kind: "request", id: "r", name: "R", method: "", seq: 2 },
              { kind: "folder", id: "f", name: "F", seq: 3, children: [{ kind: "request", id: "r2" }] },
              { kind: "folder", id: "g", parentId: "c", children: null },
            ],
          },
          {},
        ],
        problems: [{ path: "x.yaml", message: "bad" }],
      }),
    ).toEqual({
      collections: [
        {
          kind: "collection",
          id: "c",
          name: "C",
          seq: 1,
          children: [
            { kind: "request", id: "r", name: "R", method: "GET", url: "", seq: 2, parentId: "c" },
            {
              kind: "folder",
              id: "f",
              name: "F",
              seq: 3,
              parentId: "c",
              children: [
                { kind: "request", id: "r2", name: "", method: "GET", url: "", seq: 0, parentId: "f" },
              ],
            },
            { kind: "folder", id: "g", name: "", seq: 0, parentId: "c", children: [] },
          ],
        },
        { kind: "collection", id: "", name: "", seq: 0, children: [] },
      ],
      problems: [{ path: "x.yaml", message: "bad" }],
    });
  });

  it("normalizeHistoryEntry and historyToResult", async () => {
    const { normalizeHistoryEntry, historyToResult } = await import("./model");
    const empty = normalizeHistoryEntry(undefined);
    expect(empty.method).toBe("GET");
    expect(empty.response).toBeNull();
    expect(historyToResult(empty)).toEqual({ response: null, error: null, historyId: 0 });

    const ok = normalizeHistoryEntry({
      id: 7,
      method: "POST",
      url: "https://x",
      status: 201,
      request: { method: "POST", url: "https://x" },
      response: { statusCode: 201 },
    });
    expect(ok.request.method).toBe("POST");
    expect(historyToResult(ok)).toMatchObject({ response: { statusCode: 201 }, error: null, historyId: 7 });

    const failed = normalizeHistoryEntry({ id: 8, errorKind: "dns", errorMessage: "no such host" });
    expect(historyToResult(failed).error).toEqual({ kind: "dns", message: "no such host" });
  });
});
