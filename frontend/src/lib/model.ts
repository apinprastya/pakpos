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
  | "network"
  /** {{variables}} couldn't be resolved (a loop, or nested too deeply). */
  | "variables";

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
}

/** How a request resolves, for the headers tab and variable hover. */
export interface ResolvePreview {
  headers: InheritedHeader[];
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
    auth: normalizeRequest({ auth: p.auth }).auth,
    authSource: p.authSource ? { ...p.authSource } : null,
    variables: (p.variables ?? []).map((v) => ({ ...v, value: v.secret ? "" : v.value })),
    unresolved: p.unresolved ?? [],
    secretsLocked: p.secretsLocked ?? false,
    environment: normalizeEnvRef(p.environment),
    error: p.error ?? "",
  };
}

/** A collection's settings: what its folders and requests inherit, plus its variables. */
export interface CollectionSettings {
  id: string;
  name: string;
  auth: Auth;
  headers: KeyValue[];
  variables: Variable[];
}

/** A folder's settings: what its folders and requests inherit. Folders have no variables. */
export interface FolderSettings {
  id: string;
  name: string;
  auth: Auth;
  headers: KeyValue[];
}

/** Fills defaults in a collection from Go. Nothing is above a collection, so an empty auth type is "none". */
export function normalizeCollection(input: unknown): CollectionSettings {
  const c = (input ?? {}) as {
    id?: string | null;
    name?: string | null;
    auth?: Loose<Auth> | null;
    headers?: Loose<KeyValue>[] | null;
    variables?: Loose<Variable>[] | null;
  };
  return {
    id: c.id ?? "",
    name: c.name ?? "",
    // `inherit` means nothing on a collection, the same as an empty type.
    auth: containerAuth(c.auth?.type === "inherit" ? { ...c.auth, type: "" as AuthType } : c.auth, "none"),
    headers: kvList(c.headers),
    variables: varList(c.variables),
  };
}

export function normalizeFolder(input: unknown): FolderSettings {
  const f = (input ?? {}) as {
    id?: string | null;
    name?: string | null;
    auth?: Loose<Auth> | null;
    headers?: Loose<KeyValue>[] | null;
  };
  return {
    id: f.id ?? "",
    name: f.name ?? "",
    auth: containerAuth(f.auth, "inherit"),
    headers: kvList(f.headers),
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
}

/** Limits matching internal/core/settings. */
export const SETTINGS_LIMITS = {
  maxTimeoutMs: 10 * 60 * 1000,
  maxRedirects: 50,
  maxHistoryRetention: 100_000,
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
};
