import {
  compactRequest,
  emptyAuth,
  emptyRequest,
  isUntouchedAuth,
  normalizeEnvironment,
  normalizeGlobals,
  normalizePreview,
  normalizeRequest,
  normalizeSecretsStatus,
  normalizeSendResult,
  normalizeVariables,
  requestsEqual,
  type Auth,
} from "./model";

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
    expect(normalizeSendResult(null)).toEqual({
      response: null,
      error: null,
      historyId: 0,
      unresolved: [],
      secretsLocked: false,
      environment: null,
    });
    expect(
      normalizeSendResult({ unresolved: ["a"], secretsLocked: true, environment: { id: "e", name: "Dev" } }),
    ).toMatchObject({ unresolved: ["a"], secretsLocked: true, environment: { id: "e", name: "Dev" } });
    expect(normalizeSendResult({ environment: {} }).environment).toEqual({ id: "", name: "" });
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
    expect(historyToResult(empty)).toEqual({
      response: null,
      error: null,
      historyId: 0,
      unresolved: [],
      secretsLocked: false,
      environment: null,
    });
    expect(empty.environmentName).toBe("");
    const withEnv = normalizeHistoryEntry({ id: 9, environmentName: "Prod" });
    expect(historyToResult(withEnv).environment).toEqual({ id: "", name: "Prod" });

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

describe("auth defaults", () => {
  it.each<[string, Partial<Auth>, boolean]>([
    ["a new request's auth", {}, true],
    ["an empty API key location", { apiIn: "" as Auth["apiIn"] }, true],
    ["inherit", { type: "inherit" }, false],
    ["bearer", { type: "bearer" }, false],
    ["a username", { username: "u" }, false],
    ["a password", { password: "p" }, false],
    ["a token", { token: "t" }, false],
    ["a prefix", { prefix: "Token" }, false],
    ["an API key name", { apiKey: "k" }, false],
    ["an API key value", { apiValue: "v" }, false],
    ["the key sent in the query", { apiIn: "query" }, false],
  ])("isUntouchedAuth with %s is %s", (_name, patch, want) => {
    expect(isUntouchedAuth({ ...emptyAuth(), ...patch })).toBe(want);
  });
});

describe("environment model", () => {
  it("normalizes environments, globals and variables from Go", () => {
    expect(normalizeEnvironment(null)).toEqual({ id: "", name: "", seq: 0, variables: [] });
    expect(
      normalizeEnvironment({
        id: "e",
        name: "Dev",
        seq: 2,
        variables: [{ key: "a", value: null, secret: true }],
      }),
    ).toEqual({
      id: "e",
      name: "Dev",
      seq: 2,
      variables: [{ key: "a", value: "", enabled: false, secret: true }],
    });
    expect(normalizeGlobals({ id: "g", variables: null })).toEqual({ id: "g", variables: [] });
    expect(normalizeGlobals(undefined)).toEqual({ id: "", variables: [] });
    expect(normalizeVariables(null)).toEqual([]);
    expect(normalizeVariables([{}])).toEqual([{ key: "", value: "", enabled: false, secret: false }]);
  });

  it("normalizes the secret store status", () => {
    expect(normalizeSecretsStatus(null)).toEqual({ backend: "keychain", hasPassword: false, locked: false });
    expect(normalizeSecretsStatus({ backend: "file", hasPassword: true, locked: true })).toEqual({
      backend: "file",
      hasPassword: true,
      locked: true,
    });
  });

  it("normalizes a resolve preview and never keeps a secret value", () => {
    const empty = normalizePreview(null);
    expect(empty).toEqual({
      headers: [],
      auth: emptyAuth(),
      authSource: null,
      variables: [],
      unresolved: [],
      secretsLocked: false,
      environment: null,
      error: "",
    });
    const src = { kind: "folder", id: "f", name: "Admin" };
    const p = normalizePreview({
      headers: [{ key: "X", value: "1", source: src }],
      auth: { type: "bearer", token: "{{token}}" },
      authSource: src,
      variables: [
        {
          key: "token",
          value: "leak",
          secret: true,
          scope: "collection",
          scopeId: "c",
          scopeName: "API",
          set: true,
        },
        {
          key: "host",
          value: "h",
          secret: false,
          scope: "global",
          scopeId: "g",
          scopeName: "Globals",
          set: true,
        },
      ],
      unresolved: ["x"],
      secretsLocked: true,
      environment: { id: "e", name: "Dev" },
      error: "loop",
    });
    expect(p.headers[0].source).toEqual(src);
    expect(p.auth).toMatchObject({ type: "bearer", token: "{{token}}", apiIn: "header" });
    expect(p.authSource).toEqual(src);
    expect(p.variables.map((v) => v.value)).toEqual(["", "h"]);
    expect(p).toMatchObject({
      unresolved: ["x"],
      secretsLocked: true,
      environment: { name: "Dev" },
      error: "loop",
    });
  });
});

describe("collection and folder settings", () => {
  it("fills defaults; empty or inherit auth on a collection is none, empty on a folder is inherit", async () => {
    const { normalizeCollection, normalizeFolder } = await import("./model");
    expect(normalizeCollection(null)).toMatchObject({ id: "", name: "", headers: [], variables: [] });
    expect(normalizeCollection({ auth: { type: "" } }).auth.type).toBe("none");
    expect(normalizeCollection({ auth: { type: "inherit" } }).auth.type).toBe("none");
    expect(
      normalizeCollection({
        id: "c",
        auth: { type: "bearer", token: "t" },
        variables: [{ key: "k", secret: true }],
      }),
    ).toMatchObject({
      id: "c",
      auth: { type: "bearer", token: "t" },
      variables: [{ key: "k", value: "", enabled: false, secret: true }],
    });
    expect(normalizeFolder(undefined).auth.type).toBe("inherit");
    expect(
      normalizeFolder({ id: "f", name: "F", auth: { type: "none" }, headers: [{ key: "a" }] }),
    ).toMatchObject({
      id: "f",
      auth: { type: "none" },
      headers: [{ key: "a", value: "", enabled: false }],
    });
  });
});
