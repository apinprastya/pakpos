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

export type AuthType =
  | "none"
  | "inherit"
  | "basic"
  | "bearer"
  | "apikey"
  | "oauth2"
  | "digest"
  | "awsv4"
  | "jwt"
  | "hawk"
  | "ntlm";
export type APIKeyLocation = "header" | "query";

export type OAuth2Grant = "authorization_code" | "client_credentials" | "password" | "implicit";

/**
 * OAuth 2.0 settings (Go model.OAuth2). Empty enums mean the default:
 * grant authorization_code, clientAuth basic, placement header, pkceMethod S256.
 * Tokens are never here: they live in the secret store (AuthService).
 */
export interface OAuth2 {
  grant: OAuth2Grant | "";
  authUrl: string;
  tokenUrl: string;
  /** "" = loopback on 127.0.0.1 with a random port; else a fixed http://127.0.0.1|localhost:<port>/<path>. */
  redirectUrl: string;
  clientId: string;
  clientSecret: string;
  clientAuth: "basic" | "body" | "";
  scope: string;
  username: string;
  password: string;
  disablePkce: boolean;
  pkceMethod: "S256" | "plain" | "";
  placement: "header" | "query" | "";
  headerPrefix: string;
  queryParam: string;
  disableAutoRefresh: boolean;
  /** Added to the authorization and token requests (audience, resource…). */
  extraParams: KeyValue[];
}

export function emptyOAuth2(): OAuth2 {
  return {
    grant: "authorization_code",
    authUrl: "",
    tokenUrl: "",
    redirectUrl: "",
    clientId: "",
    clientSecret: "",
    clientAuth: "",
    scope: "",
    username: "",
    password: "",
    disablePkce: false,
    pkceMethod: "",
    placement: "",
    headerPrefix: "",
    queryParam: "",
    disableAutoRefresh: false,
    extraParams: [],
  };
}

export function normalizeOAuth2(input: unknown): OAuth2 {
  const o = (input ?? {}) as Loose<OAuth2>;
  return {
    grant: o.grant ?? "",
    authUrl: o.authUrl ?? "",
    tokenUrl: o.tokenUrl ?? "",
    redirectUrl: o.redirectUrl ?? "",
    clientId: o.clientId ?? "",
    clientSecret: o.clientSecret ?? "",
    clientAuth: o.clientAuth ?? "",
    scope: o.scope ?? "",
    username: o.username ?? "",
    password: o.password ?? "",
    disablePkce: o.disablePkce ?? false,
    pkceMethod: o.pkceMethod ?? "",
    placement: o.placement ?? "",
    headerPrefix: o.headerPrefix ?? "",
    queryParam: o.queryParam ?? "",
    disableAutoRefresh: o.disableAutoRefresh ?? false,
    extraParams: kvList(o.extraParams),
  };
}

/** HTTP Digest settings (Go model.Digest). Empty algorithm/qop: the server's choice. */
export interface Digest {
  username: string;
  password: string;
  algorithm: "" | "MD5" | "MD5-sess" | "SHA-256" | "SHA-256-sess";
  qop: "" | "auth-int";
}

/** AWS Signature v4 settings (Go model.AWSV4). */
export interface AWSV4 {
  accessKey: string;
  secretKey: string;
  sessionToken: string;
  region: string;
  service: string;
  unsignedPayload: boolean;
}

export type JWTAlgorithm =
  | "HS256"
  | "HS384"
  | "HS512"
  | "RS256"
  | "RS384"
  | "RS512"
  | "PS256"
  | "PS384"
  | "PS512"
  | "ES256"
  | "ES384"
  | "ES512"
  | "EdDSA";

/** JWT generator settings (Go model.JWT). Empty algorithm = HS256. */
export interface JWT {
  algorithm: JWTAlgorithm | "";
  /** HMAC secret or PEM private key. */
  secret: string;
  secretBase64: boolean;
  /** Extra header fields as a JSON object. */
  header: string;
  /** Claims as a JSON object. */
  payload: string;
  disableIssuedAt: boolean;
  lifetimeSeconds: number;
  addJti: boolean;
  placement: "header" | "query" | "";
  headerPrefix: string;
  queryParam: string;
}

/** Hawk settings (Go model.Hawk). Empty algorithm = sha256. */
export interface Hawk {
  id: string;
  key: string;
  algorithm: "" | "sha256" | "sha1";
  ext: string;
  app: string;
  dlg: string;
  payloadHash: boolean;
}

/** NTLM settings (Go model.NTLM). */
export interface NTLM {
  username: string;
  password: string;
  domain: string;
  workstation: string;
}

export const emptyDigest = (): Digest => ({ username: "", password: "", algorithm: "", qop: "" });
export const emptyAWSV4 = (): AWSV4 => ({
  accessKey: "",
  secretKey: "",
  sessionToken: "",
  region: "",
  service: "",
  unsignedPayload: false,
});
export const emptyJWT = (): JWT => ({
  algorithm: "",
  secret: "",
  secretBase64: false,
  header: "",
  payload: "",
  disableIssuedAt: false,
  lifetimeSeconds: 0,
  addJti: false,
  placement: "",
  headerPrefix: "",
  queryParam: "",
});
export const emptyHawk = (): Hawk => ({
  id: "",
  key: "",
  algorithm: "",
  ext: "",
  app: "",
  dlg: "",
  payloadHash: false,
});
export const emptyNTLM = (): NTLM => ({ username: "", password: "", domain: "", workstation: "" });

/** Fills the missing fields of a settings block from Go with the empty block's. */
function fill<T extends object>(empty: T, input: unknown): T {
  const out = { ...empty } as Record<string, unknown>;
  const src = (input ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(out)) {
    if (src[k] !== undefined && src[k] !== null) out[k] = src[k];
  }
  return out as T;
}

/** The settings blocks of the Tier 3 auth types other than OAuth 2.0, by type. */
export const AUTH_BLOCKS = {
  digest: emptyDigest,
  awsv4: emptyAWSV4,
  jwt: emptyJWT,
  hawk: emptyHawk,
  ntlm: emptyNTLM,
} as const;
export type BlockAuthType = keyof typeof AUTH_BLOCKS;

export function isBlockAuthType(t: AuthType): t is BlockAuthType {
  return t in AUTH_BLOCKS;
}

/** What Go knows about a stored OAuth 2.0 token, never its values (AuthService). */
export interface OAuth2Status {
  hasToken: boolean;
  /** The secret store is locked, so nothing is known. */
  locked: boolean;
  tokenType: string;
  scope: string;
  /** Unix ms; 0 when the server gave no expiry. */
  expiresAt: number;
  obtainedAt: number;
  hasRefreshToken: boolean;
  hasIdToken: boolean;
}

export function normalizeOAuth2Status(input: unknown): OAuth2Status {
  const s = (input ?? {}) as Loose<OAuth2Status>;
  return {
    hasToken: s.hasToken ?? false,
    locked: s.locked ?? false,
    tokenType: s.tokenType ?? "",
    scope: s.scope ?? "",
    expiresAt: s.expiresAt ?? 0,
    obtainedAt: s.obtainedAt ?? 0,
    hasRefreshToken: s.hasRefreshToken ?? false,
    hasIdToken: s.hasIdToken ?? false,
  };
}

export interface Auth {
  type: AuthType;
  username: string;
  password: string;
  token: string;
  prefix: string;
  apiKey: string;
  apiValue: string;
  apiIn: APIKeyLocation;
  /** OAuth 2.0 settings; only present once set (Go omits it otherwise). */
  oauth2?: OAuth2;
  /** Settings of the other Tier 3 types; each only present once set. */
  digest?: Digest;
  awsv4?: AWSV4;
  jwt?: JWT;
  hawk?: Hawk;
  ntlm?: NTLM;
}

/**
 * Per-request overrides of the app's network settings (Go model.RequestSettings).
 * A missing field means "use the app setting".
 */
export interface RequestSettings {
  /** Whole-request timeout; 0 means no timeout. */
  timeoutMs?: number;
  followRedirects?: boolean;
  maxRedirects?: number;
  verifyTls?: boolean;
}

/**
 * JavaScript run before a send (`preRequest`) and after its response (`test`),
 * on a request, folder or collection (Go model.Scripts). "" means none.
 */
export interface Scripts {
  preRequest: string;
  test: string;
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
  settings: RequestSettings;
  scripts: Scripts;
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
  /** The proxy couldn't be reached, refused the credentials, or its settings are unusable. */
  | "proxy"
  | "timeout"
  | "canceled"
  | "too_many_redirects"
  | "network"
  /** The body didn't match its Content-Encoding (gzip, deflate, br). */
  | "decode"
  /** {{variables}} couldn't be resolved (a loop, or nested too deeply). */
  | "variables"
  /** A pre-request script failed (an exception, a syntax error or a timeout); nothing was sent. */
  | "script"
  /** No usable OAuth 2.0 access token (none, expired, or getting/refreshing one failed); nothing was sent. */
  | "auth";

/**
 * One HTTP exchange of a send as it went over the wire: the request, then one
 * per redirect followed. Secret values are masked as `{{name}}`.
 */
export interface Hop {
  method: string;
  url: string;
  /** Header fields in the order they were written, including Host, Content-Length and cookies. */
  requestHeaders: KeyValue[];
  /** The start of the body sent: text, or base64 when `requestBodyEncoding` says so. */
  requestBody: string;
  requestBodyEncoding: BodyEncoding;
  requestBodySize: number;
  requestBodyTruncated: boolean;
  /** Why the body isn't shown, if it isn't. */
  requestBodyNote: string;
  remoteAddr: string;
  reusedConn: boolean;
  /** e.g. "TLS 1.3"; empty for plain HTTP. */
  tls: string;
  proto: string;
  /** 0 when the hop failed. */
  statusCode: number;
  statusText: string;
  responseHeaders: KeyValue[];
  error: string;
}

export interface SendError {
  kind: SendErrorKind;
  message: string;
}

/** An environment by id and name. */
export interface EnvRef {
  id: string;
  name: string;
}

export interface SendResult {
  response: Response | null;
  error: SendError | null;
  /** 0 when the send was not recorded in history. */
  historyId: number;
  /** `{{names}}` that had no value; they were sent as written. */
  unresolved: string[];
  /** The request uses secrets that couldn't be read because the secret store is locked. */
  secretsLocked: boolean;
  /** Environment the request was sent with, or null for none. */
  environment: EnvRef | null;
  /** What went over the wire. Empty when nothing was sent or for history entries (never stored). */
  hops: Hop[];
  /** pm.test results of the pre-request and test scripts, collection first (masked, never stored). */
  tests: TestResult[];
  /** Script console output, collection first (masked, never stored). */
  console: ConsoleEntry[];
  /** A pre-request script called pm.execution.skipRequest(): nothing was sent. */
  skipped: boolean;
  /** Where a pre-request script failed (error kind "script"); null otherwise. */
  scriptError: ScriptErrorInfo | null;
}

/** The script and position of a pre-request script error (Go service.ScriptErrorInfo). */
export interface ScriptErrorInfo {
  source: ScriptSource;
  /** 1-based; 0 when unknown (a timeout). */
  line: number;
  column: number;
}

export type ScriptEvent = "prerequest" | "test";
export type ScriptLevelKind = "collection" | "folder" | "request";

/** The script a test or console line came from (Go script.Source). */
export interface ScriptSource {
  kind: ScriptLevelKind;
  id: string;
  name: string;
  event: ScriptEvent;
}

/** One pm.test (Go script.TestResult). Secret values read as [secret:name]. */
export interface TestResult {
  name: string;
  passed: boolean;
  skipped: boolean;
  /** e.g. "AssertionError: expected 404 to equal 200"; "" when passed. */
  error: string;
  source: ScriptSource;
}

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

/** One console line of a script (Go script.ConsoleEntry). */
export interface ConsoleEntry {
  level: ConsoleLevel;
  text: string;
  source: ScriptSource;
}

/** Payload of the `script:console` event: one script run's output while a send runs. */
export interface ScriptConsoleEvent {
  sendId: string;
  entries: ConsoleEntry[];
}

function normalizeSource(input: Loose<ScriptSource> | null | undefined): ScriptSource {
  const s = input ?? {};
  return {
    kind: s.kind || "request",
    id: s.id ?? "",
    name: s.name ?? "",
    event: s.event || "prerequest",
  };
}

export function normalizeTestResult(input: unknown): TestResult {
  const t = (input ?? {}) as Omit<Loose<TestResult>, "source"> & { source?: Loose<ScriptSource> | null };
  return {
    name: t.name ?? "",
    passed: t.passed ?? false,
    skipped: t.skipped ?? false,
    error: t.error ?? "",
    source: normalizeSource(t.source),
  };
}

export function normalizeConsoleEntry(input: unknown): ConsoleEntry {
  const e = (input ?? {}) as Omit<Loose<ConsoleEntry>, "source"> & { source?: Loose<ScriptSource> | null };
  return { level: e.level || "log", text: e.text ?? "", source: normalizeSource(e.source) };
}

/** A saved request in the sidebar tree. */
export interface RequestSummary {
  kind: "request";
  id: string;
  name: string;
  method: string;
  url: string;
  seq: number;
  /** Collection or folder holding the request. */
  parentId: string;
}

/** A folder: a subdirectory of a collection or of another folder. */
export interface FolderNode {
  kind: "folder";
  id: string;
  name: string;
  seq: number;
  /** Collection or folder holding this folder. */
  parentId: string;
  /** Folders and requests, in one shared order. */
  children: TreeChild[];
}

export type TreeChild = FolderNode | RequestSummary;

export interface CollectionNode {
  kind: "collection";
  id: string;
  name: string;
  seq: number;
  /** Folders and requests, in one shared order. */
  children: TreeChild[];
}

/** Something requests and folders can live in. */
export type ContainerNode = CollectionNode | FolderNode;
export type TreeNode = CollectionNode | TreeChild;

/** A workspace file that couldn't be loaded (e.g. hand-edited invalid YAML). */
export interface Problem {
  path: string;
  message: string;
}

export interface WorkspaceTree {
  collections: CollectionNode[];
  problems: Problem[];
}

export interface RecentWorkspace {
  path: string;
  name: string;
  lastOpened: string;
}

export interface HistorySummary {
  id: number;
  createdAt: string;
  workspaceId: string;
  requestId: string;
  requestName: string;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  size: number;
  errorKind: string;
  errorMessage: string;
  /** Environment selected when the request was sent ("" for none). */
  environmentName: string;
}

export interface HistoryEntry extends HistorySummary {
  request: Request;
  response: Response | null;
}

/** History is per workspace: Go lists the open workspace's entries (or those sent without one). */
export interface HistoryFilter {
  text: string;
  offset: number;
  limit: number;
}

export interface HistoryPage {
  items: HistorySummary[];
  total: number;
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
    settings: {},
    scripts: emptyScripts(),
  };
}

export function emptyScripts(): Scripts {
  return { preRequest: "", test: "" };
}

export function normalizeScripts(input: unknown): Scripts {
  const s = (input ?? {}) as Loose<Scripts>;
  return { preRequest: s.preRequest ?? "", test: s.test ?? "" };
}

/** Keeps only the set fields, in a fixed order (so requests compare by JSON). */
export function normalizeRequestSettings(input: unknown): RequestSettings {
  const s = (input ?? {}) as Record<string, unknown>;
  const out: RequestSettings = {};
  if (typeof s.timeoutMs === "number") out.timeoutMs = s.timeoutMs;
  if (typeof s.followRedirects === "boolean") out.followRedirects = s.followRedirects;
  if (typeof s.maxRedirects === "number") out.maxRedirects = s.maxRedirects;
  if (typeof s.verifyTls === "boolean") out.verifyTls = s.verifyTls;
  return out;
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
      ...(a.oauth2 ? { oauth2: normalizeOAuth2(a.oauth2) } : {}),
      ...(a.digest ? { digest: fill(emptyDigest(), a.digest) } : {}),
      ...(a.awsv4 ? { awsv4: fill(emptyAWSV4(), a.awsv4) } : {}),
      ...(a.jwt ? { jwt: fill(emptyJWT(), a.jwt) } : {}),
      ...(a.hawk ? { hawk: fill(emptyHawk(), a.hawk) } : {}),
      ...(a.ntlm ? { ntlm: fill(emptyNTLM(), a.ntlm) } : {}),
    },
    settings: normalizeRequestSettings(r.settings),
    scripts: normalizeScripts(r.scripts),
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

function normalizeEnvRef(input: Loose<EnvRef> | null | undefined): EnvRef | null {
  return input ? { id: input.id ?? "", name: input.name ?? "" } : null;
}

export function normalizeSendResult(input: unknown): SendResult {
  const r = (input ?? {}) as Loose<SendResult>;
  return {
    response: r.response ? normalizeResponse(r.response) : null,
    error: r.error ? { kind: r.error.kind, message: r.error.message } : null,
    historyId: r.historyId ?? 0,
    unresolved: r.unresolved ?? [],
    secretsLocked: r.secretsLocked ?? false,
    environment: normalizeEnvRef(r.environment),
    hops: (r.hops ?? []).map(normalizeHop),
    tests: (r.tests ?? []).map(normalizeTestResult),
    console: (r.console ?? []).map(normalizeConsoleEntry),
    skipped: r.skipped ?? false,
    scriptError: normalizeScriptError(r.scriptError),
  };
}

function normalizeScriptError(input: Loose<ScriptErrorInfo> | null | undefined): ScriptErrorInfo | null {
  if (!input) return null;
  return { source: normalizeSource(input.source), line: input.line ?? 0, column: input.column ?? 0 };
}

export function normalizeHop(input: unknown): Hop {
  const h = (input ?? {}) as Loose<Hop>;
  return {
    method: h.method ?? "",
    url: h.url ?? "",
    requestHeaders: kvList(h.requestHeaders),
    requestBody: h.requestBody ?? "",
    requestBodyEncoding: h.requestBodyEncoding ?? "utf8",
    requestBodySize: h.requestBodySize ?? 0,
    requestBodyTruncated: h.requestBodyTruncated ?? false,
    requestBodyNote: h.requestBodyNote ?? "",
    remoteAddr: h.remoteAddr ?? "",
    reusedConn: h.reusedConn ?? false,
    tls: h.tls ?? "",
    proto: h.proto ?? "",
    statusCode: h.statusCode ?? 0,
    statusText: h.statusText ?? "",
    responseHeaders: kvList(h.responseHeaders),
    error: h.error ?? "",
  };
}

interface LooseNode {
  kind?: string | null;
  id?: string | null;
  name?: string | null;
  seq?: number | null;
  parentId?: string | null;
  method?: string | null;
  url?: string | null;
  children?: LooseNode[] | null;
}

function normalizeChild(n: LooseNode, parentId: string): TreeChild {
  const base = { id: n.id ?? "", name: n.name ?? "", seq: n.seq ?? 0, parentId: n.parentId || parentId };
  if (n.kind === "folder") {
    return { kind: "folder", ...base, children: (n.children ?? []).map((c) => normalizeChild(c, base.id)) };
  }
  return { kind: "request", ...base, method: n.method || "GET", url: n.url ?? "" };
}

/** Fills defaults in the recursive tree from Go (null children, empty fields). */
export function normalizeTree(input: unknown): WorkspaceTree {
  const t = (input ?? {}) as { collections?: LooseNode[] | null; problems?: Problem[] | null };
  return {
    collections: (t.collections ?? []).map((c) => {
      const id = c.id ?? "";
      return {
        kind: "collection",
        id,
        name: c.name ?? "",
        seq: c.seq ?? 0,
        children: (c.children ?? []).map((n) => normalizeChild(n, id)),
      };
    }),
    problems: t.problems ?? [],
  };
}

/** Turns a history entry into what a tab shows: the request plus its stored result. */
export function historyToResult(entry: HistoryEntry): SendResult {
  return {
    response: entry.response,
    error: entry.errorKind ? { kind: entry.errorKind as SendErrorKind, message: entry.errorMessage } : null,
    historyId: entry.id,
    unresolved: [],
    secretsLocked: false,
    environment: entry.environmentName ? { id: "", name: entry.environmentName } : null,
    hops: [],
    tests: [],
    console: [],
    skipped: false,
    scriptError: null,
  };
}

export function normalizeHistoryEntry(input: unknown): HistoryEntry {
  const e = (input ?? {}) as Loose<HistoryEntry>;
  return {
    id: e.id ?? 0,
    createdAt: e.createdAt ?? "",
    workspaceId: e.workspaceId ?? "",
    requestId: e.requestId ?? "",
    requestName: e.requestName ?? "",
    method: e.method || "GET",
    url: e.url ?? "",
    status: e.status ?? 0,
    durationMs: e.durationMs ?? 0,
    size: e.size ?? 0,
    errorKind: e.errorKind ?? "",
    errorMessage: e.errorMessage ?? "",
    environmentName: e.environmentName ?? "",
    request: normalizeRequest(e.request),
    response: e.response ? normalizeResponse(e.response) : null,
  };
}

/**
 * True when auth is still what a new request starts with: type none and every
 * field empty (the API key location at its default). Such a draft switches to
 * `inherit` when it's saved into a collection or folder; auth the user set is
 * never changed.
 */
export function isUntouchedAuth(a: Auth): boolean {
  return (
    a.type === "none" &&
    !a.username &&
    !a.password &&
    !a.token &&
    !a.prefix &&
    !a.apiKey &&
    !a.apiValue &&
    (a.apiIn === "header" || !a.apiIn)
  );
}

/* ---- Environments, variables and secrets (EnvService) ---- */

export type ScopeKind = "global" | "collection" | "environment" | "local";

/** A variable row. Secret values are never sent from Go (value is ""). */
export interface Variable {
  key: string;
  value: string;
  enabled: boolean;
  secret: boolean;
  /**
   * Editor only, never sent to Go: the key a secret row had when its key was
   * first edited, so a save can move its stored value (see `SecretRename`).
   */
  origin?: string;
}

/** A secret variable renamed in a save: Go moves its stored value from `from` to `to`. */
export interface SecretRename {
  from: string;
  to: string;
}

export interface Environment {
  id: string;
  name: string;
  seq: number;
  variables: Variable[];
}

export interface Globals {
  id: string;
  variables: Variable[];
}

/** A scope that stores variables: the globals (id ignored), a collection or an environment. */
export interface ScopeRef {
  kind: ScopeKind;
  id: string;
}

/** Which secret variables of a scope have a value on this machine. */
export interface SecretStatus {
  set: string[];
  /** The store is locked, so `set` can't be known. */
  locked: boolean;
}

/** The secret store in use. `hasPassword` and `locked` apply to the file store only. */
export interface SecretsStatus {
  backend: "keychain" | "file";
  hasPassword: boolean;
  locked: boolean;
}

export interface InheritSource {
  kind: "collection" | "folder";
  id: string;
  name: string;
}

export interface InheritedHeader {
  key: string;
  value: string;
  source: InheritSource;
}

/** A variable visible to a request (the winning definition). Secret values are always "". */
export interface PreviewVariable {
  key: string;
  value: string;
  secret: boolean;
  scope: ScopeKind;
  scopeId: string;
  scopeName: string;
  /** False for a secret with no value on this machine. */
  set: boolean;
  /** "set" when a script replaced the file's value this session, "new" when only a script defined it. */
  overlay: OverlayState;
}

/** How the script overlay changes a variable ("" = the file's value). */
export type OverlayState = "" | "set" | "new" | "unset";

/** A value scripts set on a scope this session (Go pipeline.OverlayValue). Secret values are "". */
export interface OverlayValue {
  key: string;
  value: string;
  state: Exclude<OverlayState, "">;
  secret: boolean;
}

export function normalizeOverlayValue(input: unknown): OverlayValue {
  const v = (input ?? {}) as Loose<OverlayValue>;
  const state = v.state === "new" || v.state === "unset" ? v.state : "set";
  return { key: v.key ?? "", value: v.secret ? "" : (v.value ?? ""), state, secret: v.secret ?? false };
}

function previewVariable(v: Loose<PreviewVariable>): PreviewVariable {
  return {
    key: v.key ?? "",
    value: v.secret ? "" : (v.value ?? ""),
    secret: v.secret ?? false,
    scope: v.scope || "global",
    scopeId: v.scopeId ?? "",
    scopeName: v.scopeName ?? "",
    set: v.set ?? false,
    overlay: v.overlay ?? "",
  };
}

/** How a request resolves, for the headers tab and variable hover. */
export interface ResolvePreview {
  headers: InheritedHeader[];
  /** Inherited headers the request's own enabled headers replace (never sent). */
  overridden: InheritedHeader[];
  auth: Auth;
  authSource: InheritSource | null;
  variables: PreviewVariable[];
  unresolved: string[];
  secretsLocked: boolean;
  environment: EnvRef | null;
  /** Why variables can't be resolved (a loop), or "". */
  error: string;
}

function varList(rows: Loose<Variable>[] | null | undefined): Variable[] {
  return (rows ?? []).map((r) => ({
    key: r.key ?? "",
    value: r.value ?? "",
    enabled: r.enabled ?? false,
    secret: r.secret ?? false,
  }));
}

export function normalizeVariables(input: unknown): Variable[] {
  return varList(input as Loose<Variable>[] | null | undefined);
}

export function normalizeEnvironment(input: unknown): Environment {
  const e = (input ?? {}) as Omit<Loose<Environment>, "variables"> & { variables?: Loose<Variable>[] | null };
  return { id: e.id ?? "", name: e.name ?? "", seq: e.seq ?? 0, variables: varList(e.variables) };
}

export function normalizeGlobals(input: unknown): Globals {
  const g = (input ?? {}) as { id?: string | null; variables?: Loose<Variable>[] | null };
  return { id: g.id ?? "", variables: varList(g.variables) };
}

export function normalizeSecretsStatus(input: unknown): SecretsStatus {
  const s = (input ?? {}) as Loose<SecretsStatus>;
  return {
    backend: s.backend === "file" ? "file" : "keychain",
    hasPassword: s.hasPassword ?? false,
    locked: s.locked ?? false,
  };
}

export function normalizePreview(input: unknown): ResolvePreview {
  const p = (input ?? {}) as Omit<Loose<ResolvePreview>, "auth"> & { auth?: Loose<Auth> | null };
  return {
    headers: (p.headers ?? []).map((h) => ({ key: h.key, value: h.value, source: { ...h.source } })),
    overridden: (p.overridden ?? []).map((h) => ({ key: h.key, value: h.value, source: { ...h.source } })),
    auth: normalizeRequest({ auth: p.auth }).auth,
    authSource: p.authSource ? { ...p.authSource } : null,
    variables: (p.variables ?? []).map(previewVariable),
    unresolved: p.unresolved ?? [],
    secretsLocked: p.secretsLocked ?? false,
    environment: normalizeEnvRef(p.environment),
    error: p.error ?? "",
  };
}

/** The variables an editor can reference (no request needed); secret values are always "". */
export interface VisibleVariables {
  variables: PreviewVariable[];
  /**
   * Definitions that lose to a higher scope, by key and then highest
   * precedence first: what wins once a visible definition goes away.
   */
  shadowed: PreviewVariable[];
  environment: EnvRef | null;
}

export function normalizeVisible(input: unknown): VisibleVariables {
  const p = (input ?? {}) as Loose<VisibleVariables>;
  return {
    variables: (p.variables ?? []).map(previewVariable),
    shadowed: (p.shadowed ?? []).map(previewVariable),
    environment: normalizeEnvRef(p.environment),
  };
}

/** A collection's settings: what its folders and requests inherit, plus its variables. */
export interface CollectionSettings {
  id: string;
  name: string;
  auth: Auth;
  headers: KeyValue[];
  variables: Variable[];
  /** Run for every request in the collection, before the folders' and the request's own. */
  scripts: Scripts;
}

/** A folder's settings: what its folders and requests inherit. Folders have no variables. */
export interface FolderSettings {
  id: string;
  name: string;
  auth: Auth;
  headers: KeyValue[];
  scripts: Scripts;
}

/** Fills defaults in a collection from Go. Nothing is above a collection, so an empty auth type is "none". */
export function normalizeCollection(input: unknown): CollectionSettings {
  const c = (input ?? {}) as {
    id?: string | null;
    name?: string | null;
    auth?: Loose<Auth> | null;
    headers?: Loose<KeyValue>[] | null;
    variables?: Loose<Variable>[] | null;
    scripts?: Loose<Scripts> | null;
  };
  return {
    id: c.id ?? "",
    name: c.name ?? "",
    // `inherit` means nothing on a collection, the same as an empty type.
    auth: containerAuth(c.auth?.type === "inherit" ? { ...c.auth, type: "" as AuthType } : c.auth, "none"),
    headers: kvList(c.headers),
    variables: varList(c.variables),
    scripts: normalizeScripts(c.scripts),
  };
}

export function normalizeFolder(input: unknown): FolderSettings {
  const f = (input ?? {}) as {
    id?: string | null;
    name?: string | null;
    auth?: Loose<Auth> | null;
    headers?: Loose<KeyValue>[] | null;
    scripts?: Loose<Scripts> | null;
  };
  return {
    id: f.id ?? "",
    name: f.name ?? "",
    auth: containerAuth(f.auth, "inherit"),
    headers: kvList(f.headers),
    scripts: normalizeScripts(f.scripts),
  };
}

/**
 * On a folder an empty auth type counts as `inherit` (Go's core/inherit); on a
 * collection it means nothing is set, which requests see as `none`.
 */
function containerAuth(a: Loose<Auth> | null | undefined, empty: AuthType): Auth {
  const auth = normalizeRequest({ auth: a }).auth;
  return a?.type ? auth : { ...auth, type: empty };
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
    settings: normalizeRequestSettings(req.settings),
    scripts: normalizeScripts(req.scripts),
  };
}

/** Structural equality of two requests, ignoring blank editor rows. */
export function requestsEqual(a: Request, b: Request): boolean {
  return JSON.stringify(compactRequest(a)) === JSON.stringify(compactRequest(b));
}

export type ThemeSetting = "light" | "dark" | "system";
export type LayoutSetting = "vertical" | "horizontal";

/** App settings, stored in Go (SQLite). Mirrors internal/core/settings.Settings. */
export interface AppSettings {
  theme: ThemeSetting;
  /** Whole-request timeout; 0 means no timeout. */
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  verifyTls: boolean;
  /** History entries to keep; 0 keeps all. */
  historyRetention: number;
  layout: LayoutSetting;
  /** Look for a new release at startup and once a day. */
  checkForUpdates: boolean;
  proxy: ProxySettings;
  /** PEM bundle trusted in addition to the system roots; "" for none. */
  caFile: string;
  /** Tried in order; the first whose host matches is sent. */
  clientCerts: ClientCert[];
  /** A pre-request or test script running longer is stopped (1–60 s). */
  scriptTimeoutMs: number;
  /** cloudflared for webhook tunnels; "" finds it (Pakpos's download, then PATH). */
  cloudflaredPath: string;
}

export type ProxyMode = "none" | "system" | "custom";

export interface ProxySettings {
  mode: ProxyMode;
  /** http://, https:// or socks5://host:port (custom only). */
  url: string;
  username: string;
  /** Hosts reached directly, as typed (commas or new lines). */
  bypass: string;
}

/** A client certificate: a PEM certificate and key, or a PKCS#12 file. */
export interface ClientCert {
  id: string;
  /** Host pattern: api.example.com, *.example.com, 10.0.0.0/8 or *. */
  host: string;
  certFile: string;
  keyFile: string;
  pfxFile: string;
}

/** Which network passwords are stored on this machine (never the values). */
export interface NetworkSecretStatus {
  /** The secret store must be unlocked to tell. */
  locked: boolean;
  proxyPassword: boolean;
  /** Ids of client certificates with a stored passphrase. */
  certPassphrases: string[];
}

/** A cookie in the jar (Go cookies.Cookie). Its identity is domain + path + name. */
export interface StoredCookie {
  name: string;
  value: string;
  /** Without a leading dot. */
  domain: string;
  path: string;
  /** Sent to `domain` only, not its subdomains. */
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "" | "lax" | "strict" | "none";
  /** Unix milliseconds; 0 for a session cookie (gone when Pakpos quits). */
  expiresAt: number;
  createdAt: number;
}

export interface CookieRef {
  domain: string;
  path: string;
  name: string;
}

export function cookieRef(c: Pick<StoredCookie, "domain" | "path" | "name">): CookieRef {
  return { domain: c.domain, path: c.path, name: c.name };
}

export function normalizeStoredCookie(input: unknown): StoredCookie {
  const c = (input ?? {}) as Loose<StoredCookie>;
  const sameSite = c.sameSite === "lax" || c.sameSite === "strict" || c.sameSite === "none" ? c.sameSite : "";
  return {
    name: c.name ?? "",
    value: c.value ?? "",
    domain: c.domain ?? "",
    path: c.path || "/",
    hostOnly: c.hostOnly ?? false,
    secure: c.secure ?? false,
    httpOnly: c.httpOnly ?? false,
    sameSite,
    expiresAt: c.expiresAt ?? 0,
    createdAt: c.createdAt ?? 0,
  };
}

/** Limits matching internal/core/settings. */
export const SETTINGS_LIMITS = {
  maxTimeoutMs: 10 * 60 * 1000,
  maxRedirects: 50,
  maxHistoryRetention: 100_000,
  minScriptTimeoutMs: 1_000,
  maxScriptTimeoutMs: 60_000,
} as const;

export interface BuildInfo {
  version: string;
  commit: string;
  os: string;
  arch: string;
}

/** Fills gaps in settings from Go (zero-value enums) with defaults. */
export function normalizeSettings(
  input: Partial<AppSettings> | null | undefined,
  defaults: AppSettings,
): AppSettings {
  const s = input ?? {};
  return {
    theme: s.theme === "light" || s.theme === "dark" || s.theme === "system" ? s.theme : defaults.theme,
    timeoutMs: typeof s.timeoutMs === "number" ? s.timeoutMs : defaults.timeoutMs,
    followRedirects: typeof s.followRedirects === "boolean" ? s.followRedirects : defaults.followRedirects,
    maxRedirects: typeof s.maxRedirects === "number" ? s.maxRedirects : defaults.maxRedirects,
    verifyTls: typeof s.verifyTls === "boolean" ? s.verifyTls : defaults.verifyTls,
    historyRetention: typeof s.historyRetention === "number" ? s.historyRetention : defaults.historyRetention,
    layout: s.layout === "vertical" || s.layout === "horizontal" ? s.layout : defaults.layout,
    checkForUpdates: typeof s.checkForUpdates === "boolean" ? s.checkForUpdates : defaults.checkForUpdates,
    proxy: normalizeProxy(s.proxy, defaults.proxy),
    caFile: typeof s.caFile === "string" ? s.caFile : defaults.caFile,
    clientCerts: (Array.isArray(s.clientCerts) ? s.clientCerts : defaults.clientCerts).map((c) => ({
      id: c?.id ?? "",
      host: c?.host ?? "",
      certFile: c?.certFile ?? "",
      keyFile: c?.keyFile ?? "",
      pfxFile: c?.pfxFile ?? "",
    })),
    scriptTimeoutMs:
      typeof s.scriptTimeoutMs === "number" && s.scriptTimeoutMs > 0
        ? s.scriptTimeoutMs
        : defaults.scriptTimeoutMs,
    cloudflaredPath: typeof s.cloudflaredPath === "string" ? s.cloudflaredPath : defaults.cloudflaredPath,
  };
}

function normalizeProxy(p: Partial<ProxySettings> | null | undefined, d: ProxySettings): ProxySettings {
  const mode = p?.mode === "none" || p?.mode === "system" || p?.mode === "custom" ? p.mode : d.mode;
  return {
    mode,
    url: p?.url ?? d.url,
    username: p?.username ?? d.username,
    bypass: p?.bypass ?? d.bypass,
  };
}

/** Defaults of a fresh install (same as Go settings.Defaults). Used before Go answers. */
export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  timeoutMs: 30_000,
  followRedirects: true,
  maxRedirects: 10,
  verifyTls: true,
  historyRetention: 500,
  layout: "vertical",
  checkForUpdates: true,
  proxy: { mode: "system", url: "", username: "", bypass: "" },
  caFile: "",
  clientCerts: [],
  scriptTimeoutMs: 5_000,
  cloudflaredPath: "",
};

/** Result of a check for updates (Go service.UpdateInfo). */
export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  name: string;
  notes: string;
  url: string;
  /** RFC 3339, or "". */
  publishedAt: string;
  /** Install can replace this installation; otherwise `reason` says why not. */
  canInstall: boolean;
  reason: string;
}

/** Update download progress in bytes (Go service.UpdateProgress). */
export interface UpdateProgress {
  done: number;
  total: number;
}

/** Something in a curl command that was ignored or imported differently from what curl would do. */
export interface CurlWarning {
  /** The option it is about (e.g. "--insecure"), or "". */
  option: string;
  message: string;
}

/** A request read from a curl command. The request has no id or name. */
export interface CurlImport {
  request: Request;
  warnings: CurlWarning[];
}

export function normalizeCurlImport(input: unknown): CurlImport {
  const c = (input ?? {}) as Loose<CurlImport>;
  return {
    request: normalizeRequest(c.request),
    warnings: (c.warnings ?? []).map((w) => ({ option: w?.option ?? "", message: w?.message ?? "" })),
  };
}

/** A code generator: `editor` is the CodeMirror language that highlights its output. */
export interface CodeLanguage {
  id: string;
  label: string;
  editor: string;
}

export interface CodeOptions {
  /** Replace `{{variables}}` with their values (inheritance is applied either way). */
  resolveVariables: boolean;
  /** Put secret values in the code; otherwise secrets stay `{{name}}`. Ignored when not resolving. */
  revealSecrets: boolean;
}

export interface CodeResult {
  code: string;
  /** `{{names}}` with no value; they are in the code as written. */
  unresolved: string[];
  /** Secret variables left as `{{name}}` because secrets weren't revealed. */
  masked: string[];
  secretsLocked: boolean;
  /** What the code leaves out or does differently. */
  warnings: string[];
  environment: EnvRef | null;
}

export function normalizeCodeResult(input: unknown): CodeResult {
  const c = (input ?? {}) as Loose<CodeResult>;
  return {
    code: c.code ?? "",
    unresolved: c.unresolved ?? [],
    masked: c.masked ?? [],
    secretsLocked: c.secretsLocked ?? false,
    warnings: c.warnings ?? [],
    environment: c.environment ? { id: c.environment.id ?? "", name: c.environment.name ?? "" } : null,
  };
}

/* ---------- examples ---------- */

/** A saved example of a request, as lists show it. */
export interface ExampleSummary {
  id: string;
  requestId: string;
  name: string;
  /** RFC 3339. */
  savedAt: string;
  statusCode: number;
  statusText: string;
}

/** The saved part of a response (no final URL, cookies or timings). */
export interface ExampleResponse {
  statusCode: number;
  statusText: string;
  headers: KeyValue[];
  contentType: string;
  kind: BodyKind;
  body: string;
  encoding: BodyEncoding;
  size: number;
}

/** A saved example: the request as written when it was sent, and the response. */
export interface Example {
  id: string;
  name: string;
  savedAt: string;
  request: Request;
  response: ExampleResponse;
}

/**
 * What saving an example did. `example` is null when nothing was saved:
 * `secretsFound` names secrets whose values are in it (never the values),
 * or `secretsLocked` says the check couldn't run.
 */
export interface SaveExampleResult {
  example: ExampleSummary | null;
  secretsFound: string[];
  secretsLocked: boolean;
}

export function normalizeSaveExampleResult(input: unknown): SaveExampleResult {
  const r = (input ?? {}) as Loose<SaveExampleResult>;
  return {
    example: r.example ? normalizeExampleSummary(r.example) : null,
    secretsFound: r.secretsFound ?? [],
    secretsLocked: r.secretsLocked ?? false,
  };
}

/** Largest response body (decoded) an example can hold, as Go enforces it. */
export const MAX_EXAMPLE_BODY = 1 << 20;

export function normalizeExampleSummary(input: unknown): ExampleSummary {
  const e = (input ?? {}) as Loose<ExampleSummary>;
  return {
    id: e.id ?? "",
    requestId: e.requestId ?? "",
    name: e.name ?? "",
    savedAt: e.savedAt ?? "",
    statusCode: e.statusCode ?? 0,
    statusText: e.statusText ?? "",
  };
}

export function normalizeExample(input: unknown): Example {
  const e = (input ?? {}) as Omit<Loose<Example>, "response"> & { response?: Loose<ExampleResponse> | null };
  const r = e.response ?? {};
  return {
    id: e.id ?? "",
    name: e.name ?? "",
    savedAt: e.savedAt ?? "",
    request: normalizeRequest(e.request),
    response: {
      statusCode: r.statusCode ?? 0,
      statusText: r.statusText ?? "",
      headers: kvList(r.headers),
      contentType: r.contentType ?? "",
      kind: r.kind ?? "",
      body: r.body ?? "",
      encoding: r.encoding ?? "",
      size: r.size ?? 0,
    },
  };
}

/** An example's response in the shape the response viewers take. */
export function exampleToResponse(r: ExampleResponse): Response {
  return {
    ...r,
    proto: "",
    url: "",
    cookies: [],
    truncated: false,
    bodyPath: "",
    timings: { dns: 0, connect: 0, tls: 0, ttfb: 0, total: 0, reusedConn: false },
  };
}

/** "200 OK" from a status code and Go's status text (which usually starts with the code). */
export function statusName(code: number, text: string): string {
  const t = text.trim();
  if (!t) return code ? String(code) : "";
  return t.startsWith(String(code)) || !code ? t : `${code} ${t}`;
}
