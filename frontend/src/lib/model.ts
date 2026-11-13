/**
 * Frontend view of the Go DTOs (internal/core/model, internal/service).
 *
 * The generated bindings type enum fields as TS enums, which plain string
 * literals can't be assigned to. These mirror the same JSON shapes with
 * string unions and non-null arrays; `@/lib/api` converts at the boundary.
 */

export interface KeyValue {
  key: string;
  value: string;
  enabled: boolean;
}

export type BodyType = "none" | "raw" | "form-data" | "urlencoded" | "binary";
export type RawLanguage = "json" | "xml" | "text" | "html" | "javascript";
export type FormFieldKind = "text" | "file";

export interface FormField {
  key: string;
  kind: FormFieldKind;
  value: string;
  filePath: string;
  contentType: string;
  enabled: boolean;
}

export interface Body {
  type: BodyType;
  raw: string;
  language: RawLanguage;
  formData: FormField[];
  urlEncoded: KeyValue[];
  binaryPath: string;
}

export type AuthType = "none" | "inherit" | "basic" | "bearer" | "apikey";
export type APIKeyLocation = "header" | "query";

export interface Auth {
  type: AuthType;
  username: string;
  password: string;
  token: string;
  prefix: string;
  apiKey: string;
  apiValue: string;
  apiIn: APIKeyLocation;
}

export interface Request {
  id: string;
  name: string;
  seq: number;
  method: string;
  url: string;
  pathParams: KeyValue[];
  query: KeyValue[];
  headers: KeyValue[];
  body: Body;
  auth: Auth;
}

export type BodyKind = "json" | "xml" | "html" | "image" | "text" | "binary" | "empty" | "";
export type BodyEncoding = "utf8" | "base64" | "";

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: string;
  maxAge: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

export interface Timings {
  dns: number;
  connect: number;
  tls: number;
  ttfb: number;
  total: number;
  reusedConn: boolean;
}

export interface Response {
  statusCode: number;
  statusText: string;
  proto: string;
  url: string;
  headers: KeyValue[];
  cookies: Cookie[];
  contentType: string;
  kind: BodyKind;
  body: string;
  encoding: BodyEncoding;
  size: number;
  truncated: boolean;
  bodyPath: string;
  timings: Timings;
}

export type SendErrorKind =
  | "invalid_url"
  | "invalid_request"
  | "file_not_found"
  | "dns"
  | "connection_refused"
  | "tls"
  | "timeout"
  | "canceled"
  | "too_many_redirects"
  | "network";

export interface SendError {
  kind: SendErrorKind;
  message: string;
}

export interface SendResult {
  response: Response | null;
  error: SendError | null;
  /** 0 when the send was not recorded in history. */
  historyId: number;
}

export interface CollectionNode {
  id: string;
  name: string;
  seq: number;
  requests: { id: string; name: string; method: string; seq: number }[];
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
}

export function emptyAuth(): Auth {
  return {
    type: "none",
    username: "",
    password: "",
    token: "",
    prefix: "",
    apiKey: "",
    apiValue: "",
    apiIn: "header",
  };
}

export function emptyBody(): Body {
  return { type: "none", raw: "", language: "json", formData: [], urlEncoded: [], binaryPath: "" };
}

export function emptyRequest(): Request {
  return {
    id: "",
    name: "",
    seq: 0,
    method: "GET",
    url: "",
    pathParams: [],
    query: [],
    headers: [],
    body: emptyBody(),
    auth: emptyAuth(),
  };
}

/* Loose input shapes: Go sends null for empty slices and "" for zero enums. */
type Loose<T> = { [K in keyof T]?: T[K] | null };

function kvList(rows: Loose<KeyValue>[] | null | undefined): KeyValue[] {
  return (rows ?? []).map((r) => ({ key: r.key ?? "", value: r.value ?? "", enabled: r.enabled ?? false }));
}

/** Fills defaults and replaces nulls so the editor can rely on full shapes. */
export function normalizeRequest(input: unknown): Request {
  const r = (input ?? {}) as Omit<Loose<Request>, "body" | "auth"> & {
    body?: Omit<Loose<Body>, "formData"> & { formData?: Loose<FormField>[] | null };
    auth?: Loose<Auth> | null;
  };
  const b = r.body ?? ({} as NonNullable<typeof r.body>);
  const a = r.auth ?? ({} as Loose<Auth>);
  const base = emptyRequest();
  return {
    id: r.id ?? "",
    name: r.name ?? "",
    seq: r.seq ?? 0,
    method: r.method || base.method,
    url: r.url ?? "",
    pathParams: kvList(r.pathParams),
    query: kvList(r.query),
    headers: kvList(r.headers),
    body: {
      type: b.type || "none",
      raw: b.raw ?? "",
      language: b.language || "json",
      formData: (b.formData ?? []).map((f) => ({
        key: f.key ?? "",
        kind: f.kind || "text",
        value: f.value ?? "",
        filePath: f.filePath ?? "",
        contentType: f.contentType ?? "",
        enabled: f.enabled ?? false,
      })),
      urlEncoded: kvList(b.urlEncoded),
      binaryPath: b.binaryPath ?? "",
    },
    auth: {
      type: a.type || "none",
      username: a.username ?? "",
      password: a.password ?? "",
      token: a.token ?? "",
      prefix: a.prefix ?? "",
      apiKey: a.apiKey ?? "",
      apiValue: a.apiValue ?? "",
      apiIn: a.apiIn || "header",
    },
  };
}

export function normalizeResponse(input: unknown): Response {
  const r = (input ?? {}) as Loose<Response>;
  const t = (r.timings ?? {}) as Loose<Timings>;
  return {
    statusCode: r.statusCode ?? 0,
    statusText: r.statusText ?? "",
    proto: r.proto ?? "",
    url: r.url ?? "",
    headers: kvList(r.headers),
    cookies: (r.cookies ?? []) as Cookie[],
    contentType: r.contentType ?? "",
    kind: r.kind ?? "",
    body: r.body ?? "",
    encoding: r.encoding ?? "",
    size: r.size ?? 0,
    truncated: r.truncated ?? false,
    bodyPath: r.bodyPath ?? "",
    timings: {
      dns: t.dns ?? 0,
      connect: t.connect ?? 0,
      tls: t.tls ?? 0,
      ttfb: t.ttfb ?? 0,
      total: t.total ?? 0,
      reusedConn: t.reusedConn ?? false,
    },
  };
}

export function normalizeSendResult(input: unknown): SendResult {
  const r = (input ?? {}) as Loose<SendResult>;
  return {
    response: r.response ? normalizeResponse(r.response) : null,
    error: r.error ? { kind: r.error.kind, message: r.error.message } : null,
    historyId: r.historyId ?? 0,
  };
}

/** Drops table rows with neither key nor value (the editor's blank rows). */
export function compactRequest(req: Request): Request {
  const keep = <T extends { key: string; value: string }>(rows: T[]) =>
    rows.filter((r) => r.key !== "" || r.value !== "");
  return {
    ...req,
    query: keep(req.query),
    headers: keep(req.headers),
    body: {
      ...req.body,
      urlEncoded: keep(req.body.urlEncoded),
      formData: req.body.formData.filter((f) => f.key !== "" || f.value !== "" || f.filePath !== ""),
    },
  };
}

/** Structural equality of two requests, ignoring blank editor rows. */
export function requestsEqual(a: Request, b: Request): boolean {
  return JSON.stringify(compactRequest(a)) === JSON.stringify(compactRequest(b));
}
