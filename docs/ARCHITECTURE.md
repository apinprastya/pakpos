# Pakpos — Architecture

A desktop REST API client (Postman-style), REST only.

## 1. Decisions

| Area | Decision | Rationale |
|---|---|---|
| Platform | Go + **Wails v3** | Native binary, small footprint, Go does the networking |
| Targets | Linux (WebKitGTK), macOS (WKWebView), Windows (WebView2) | |
| Frontend | **React + TypeScript** (Vite) | Largest ecosystem |
| UI kit | **Tailwind CSS + shadcn/ui** (Radix primitives), lucide icons | Modern look, components owned in-repo |
| Editor | **CodeMirror 6** | Lightweight, fast on large responses, custom `{{var}}` highlighting |
| HTTP execution | **Go backend** (`net/http`) | No CORS; full control of TLS, proxy, cookies, timing |
| Storage | **Hybrid**: YAML files for workspace data, **SQLite** for history/app state | Git-friendly collections; queryable history |
| Workspace | **Open folder as workspace** (VS Code/Bruno style) + recent list | Collections can live in a git repo |
| Secrets | **OS keychain** (`zalando/go-keyring`), else an **encrypted file** unlocked with a master password | Files hold only references → safe to commit; works on Linux without a Secret Service |
| Scripting | **goja** (pure-Go JS engine) in backend, sandboxed | Works in UI and a future headless CLI |
| Import | cURL only for now (OpenAPI/HAR later) | |
| Code generation | In Go (`core/codegen`), golden-file tested | Reusable by the future CLI; one place masks secrets |
| Testing | Go `testing` + testify; Vitest + React Testing Library; ≥ 80% coverage on new code | |

## 2. High-level layout

```
┌──────────────────────── Wails v3 app ────────────────────────┐
│  Frontend (React/TS, webview)                                │
│   UI components ─ Zustand stores ─ generated Wails bindings  │
└──────────────────────────────┬───────────────────────────────┘
                               │ bound service calls + events
┌──────────────────────────────▼───────────────────────────────┐
│  Go services (thin, bound to Wails)                          │
│   WorkspaceService  RequestService  EnvService  HistoryService│
│   SettingsService   ExampleService  CookieService            │
│   RunnerService     AuthService     UIStateService           │
├──────────────────────────────────────────────────────────────┤
│  runner (collection runs: order, iterations, data files,     │
│  setNextRequest; report: JSON/HTML export; no Wails)         │
├──────────────────────────────────────────────────────────────┤
│  pipeline (send/preview/codegen preparation, scripts, secret │
│  bookkeeping; no Wails)                                      │
├──────────────────────────────────────────────────────────────┤
│  Core (pure Go, no Wails import → reusable by future CLI)    │
│   model · vars (resolve {{x}}) · inherit · httpexec          │
│   auth (+ oauth2, digest, awsv4, hawk) · jwtx · cookies (jar)│
│   curl (import/export) · codegen · script (goja)             │
│   store/fsstore (YAML) · store/sqlite · secrets              │
└──────────────────────────────────────────────────────────────┘
```

**Rule:** `internal/core/...` never imports Wails. Services are thin adapters. This keeps the core
unit-testable and allows a headless `pakpos run` CLI later.

## 3. Directory structure

```
pakpos/
├── main.go                     # Wails app bootstrap, service registration
├── build/                      # Wails build assets (icons, platform configs)
├── internal/
│   ├── service/                # Wails-bound services (adapters)
│   ├── pipeline/               # chain → inherit → scopes → secrets → resolve; scripts; secret bookkeeping
│   ├── runner/                 # collection runner (no Wails): order, iterations, data files, setNextRequest
│   │   └── report/             # JSON and standalone HTML run reports (golden files)
│   ├── core/
│   │   ├── model/              # Request, Auth, Body, Variable, Response…
│   │   ├── vars/               # variable scopes + {{var}} / {{$dynamic}} resolution
│   │   ├── inherit/            # auth and headers from collection and folders
│   │   ├── auth/               # Basic, Bearer, API Key, JWT; signing at the end of Build; Materialize for code
│   │   │   ├── oauth2/         # grants, PKCE, loopback callback
│   │   │   ├── digest/         # RFC 7616 challenge parsing and answers
│   │   │   ├── awsv4/          # AWS Signature Version 4 signer
│   │   │   └── hawk/           # Hawk header MACs and payload hashes
│   │   ├── jwtx/               # JWS sign/verify (HS/RS/PS/ES/EdDSA), shared with the tools plan
│   │   ├── httpexec/           # build http.Request, execute, timing, cancel, decode gzip/deflate/br
│   │   ├── curl/               # parse/generate cURL
│   │   ├── codegen/            # code generators (golden files)
│   │   ├── cookies/            # the app's cookie jar
│   │   └── script/             # goja sandbox + pm-like API
│   ├── store/
│   │   ├── fsstore/            # YAML workspace read/write + file watcher
│   │   └── sqlite/             # history, settings, recent workspaces, workspace state, cookies, runs (migrations)
│   ├── secrets/                # Store interface: keychain, encrypted file, fake for tests
│   └── testnet/                # test-only: CA, proxy, verifying Digest/NTLM/SigV4/Hawk/JWT servers
├── frontend/
│   ├── src/
│   │   ├── components/ui/      # shadcn components
│   │   ├── features/           # request-editor, response-viewer, sidebar, environments, history
│   │   ├── stores/             # Zustand stores
│   │   ├── lib/                # codemirror extensions, helpers
│   │   └── bindings/           # generated by wails3 (do not edit)
│   └── vite.config.ts
└── docs/
```

## 4. Workspace on disk

Manifest version 2 (Tier 2). Every change from v1 is additive: a Tier 1
workspace opens unchanged and its manifest stays at v1 until the first
v2-only write (a folder, an environment, the globals, an example or a
collection secret).

This build reads up to **version 3** (`fsstore.FormatVersion`), reserved
for Tier 3 data (scripts, the new auth types, per-request settings). It is
additive like v2: a v1 or v2 manifest is rewritten to v3 only by the first
v3-only write (`upgradeManifestLocked(FormatVersion)`: scripts, request
settings, or any Tier 3 auth type or settings block, `Auth.IsV3`); new
workspaces are created at v3. `fsstore.Open` refuses a manifest newer
than it knows (`ErrUnsupported`; the app says "This workspace was made with
a newer version of Pakpos. Update Pakpos to open it." and offers an update
check), so an older build never drops fields it doesn't know on save.

```
my-api-workspace/
├── pakpos.yaml                  # manifest: id, name, version: 2
├── collections/
│   └── users-api/
│       ├── _collection.yaml     # id, name, seq, auth, headers, variables
│       ├── auth/                # a folder (any depth)
│       │   ├── _folder.yaml     # id, name, seq, auth, headers
│       │   ├── login.yaml
│       │   └── login.examples.yaml   # saved responses for login.yaml
│       └── get-user.yaml
└── environments/
    ├── _globals.yaml            # id, variables (other _*.yaml names are reserved)
    ├── dev.yaml                 # id, name, seq, variables
    └── prod.yaml
```

- One request per file → clean git diffs, minimal merge conflicts. Folders
  and requests in one parent share one `seq:` order. IDs are ULIDs, stable
  across renames and moves; file and folder names are slugs.
- A subdirectory without `_folder.yaml`, a broken file, or an examples
  sidecar that is broken or belongs to another request is listed under
  Problems and left alone; the rest of the tree loads.
- Paths are derived from parent ids on every use, never cached, so renaming
  or moving a folder can't leave stale paths.

Example `get-user.yaml`:

```yaml
id: 01J9Z…            # ULID, stable across renames
name: Get user
seq: 2
method: GET
url: "{{baseUrl}}/users/:id"
pathParams:  [{ key: id, value: "42" }]
query:       [{ key: verbose, value: "true", enabled: false }]
headers:     [{ key: Accept, value: application/json }]
auth:        { type: inherit }
body:        { type: none }
```

Variable rows (environments, globals, collections) are
`{ key, value, enabled, secret }`. With `secret: true` the value is omitted
(and dropped if someone writes one by hand); see §5a.

An examples sidecar (`<request file stem>.examples.yaml`) holds
`{requestId, examples: [{id, name, savedAt, request, response}]}`: the request
as written for that send (`{{vars}}` unresolved) and the response status,
headers, content type and body (at most 1 MB). It follows its request on
rename, move, duplicate and delete. Before saving, the response is checked
for the values of visible secrets, including their base64 and URL-encoded
forms and Basic credentials; the user can save with `{{name}}` in their
place instead.

## 5. SQLite (app data dir)

Driver: `modernc.org/sqlite` (pure Go, no CGO → easy cross-compilation).
Migrations are numbered files (`0001_init.sql` … `0006_runs.sql`);
an applied one is never edited.

- `history`: id, timestamp, workspace_id, environment_name, the request **as
  written** (JSON, `{{vars}}` unresolved, so secrets stay out), response
  meta, body (inline, or a file in `<data>/bodies` when over 1 MB). The final
  response URL is stored as received: a secret sent in the query string
  shows up there (documented).
- History is **per workspace**: listing, clearing and the "Requests to keep"
  limit apply to the open workspace; entries sent without a workspace are
  their own group. A send prunes only its own group.
- `workspace_state`: per-workspace app state that isn't committed (the
  selected environment).
- `settings`: key/value. `recent_workspaces`: path, last_opened.
- `ui_state`: app-wide UI state (panel layouts, column splits), JSON values.
- `secret_index`: `(workspace_id, scope_id, key, written_at)`, the secret
  keys the app wrote to the secret store. Key **names only**, never values;
  see §5a.
- `cookies`: `(workspace_id, domain, path, name)` → value, host-only,
  secure, http-only, SameSite, `expires_at` and `created_at` (Unix ms). Only
  **persistent** cookies (Max-Age or Expires); session cookies live in the
  jar's memory and are gone on restart. Workspace `''` holds the cookies of
  sends made without a workspace. Expired rows are deleted when a jar loads.
  Cookies never go into workspace files.
- `runs` (`0006_runs.sql`): collection runner results per workspace, the
  newest `sqlite.MaxRuns` (20) kept (older ones pruned on insert). Columns for
  the list (target, environment name, iterations, data file **name**,
  outcome, duration, summary JSON) and `run_json`, the whole `runner.Report`:
  the requests as written (`{{vars}}` unresolved), per-request results with
  tests, console and errors masked (`[secret:name]`), and response bodies only
  when the run had "Save responses" on (text only, masked, 1 MB each, 32 MB
  per run). Never a data file's contents, never secret values.
- `settings` also holds the network settings (proxy mode, URL, user name,
  bypass list; CA file; client certificate paths). The proxy password and
  PKCS#12 passphrases are **not** there: they are app-level secret-store keys
  `pakpos/_app/proxy` and `pakpos/_app/cert/<id>` (§5a).

## 5a. Secrets

- A variable in any scope can be `secret: true`. The value lives in a
  `secrets.Store` under `pakpos/<workspaceId>/<scopeId>/<key>`; scope IDs
  rather than names, so renaming an environment or collection keeps values.
- App-level secrets (the proxy password, PKCS#12 passphrases) belong to no
  workspace: `pakpos/_app/proxy` and `pakpos/_app/cert/<certificate id>`
  (`secrets.AppKey`). They are set from Settings > Network, read lazily when
  a transport is built, and the passphrase is deleted with its certificate.
  They are not in the secret index (no pruning needed).
- At startup the OS keychain is probed (set/get/delete with a 3 s timeout).
  Without one (e.g. Linux without a Secret Service) the **file store** is
  used: `<data>/secrets.enc`, AES-256-GCM over the whole key→value map with a
  key derived by Argon2id from a **master password** (at least 8 characters,
  set on first use, unlocked once per session, never stored). A wrong
  password and a damaged file look the same to GCM and are reported alike.
- The pipeline owns the bookkeeping: values are deleted with their variable
  or scope, copied when an environment is duplicated, and moved by explicit
  `{from, to}` rename pairs. A value leaves the store only when the user
  reveals it or makes the variable plain.
- An unset or locked secret still shadows lower scopes; its name stays
  unresolved and the lower value is never sent.
- **Pruning orphans.** Keychains can't list their keys, so the session
  records every key it writes (set, rename, copy) in the SQLite
  `secret_index` and forgets the ones it deletes (`pipeline.WithSecretIndex`
  wraps the store). `Session.PruneSecrets` runs when a workspace opens and
  after the file store is unlocked: indexed keys whose scope or secret
  variable no longer exists are deleted from the store and the index. That
  covers deletes made while the store was locked, hand-edited files and
  values set on secret rows that were never saved. Keys written since the
  app started are skipped (an unsaved row may still be open), a workspace
  with load problems is skipped (a typo must not cost values), and the keys
  of current secret variables are adopted first, so values stored before the
  index existed become prunable too. Failures are logged, never fatal.
- **OAuth 2.0 tokens** live under `pakpos/<workspaceId>/<ownerId>/{oauth2}`,
  where the owner is the request, folder or collection whose auth got the
  token. The value is JSON (access and refresh token, token type, scope, ID
  token, expiry, obtained-at). The braces can't appear in a `{{variable}}`
  name, so the key never collides with a collection's secret variable (a
  collection id is also its variable scope id). Writes go through the
  session, so the secret index records them; pruning keeps a token while its
  owner exists and still uses OAuth 2.0 auth. Deleting a request, folder or
  collection deletes the tokens of everything deleted; duplicates start
  without one. Tokens leave Go only through `AuthService.RevealOAuth2Token`.

## 6. Request execution pipeline

As built (`internal/pipeline`, `Session.NewSend` → `Send.PreRequest` →
`Send.Prepare`, then `httpexec`, then `Send.Test`):

```
Request (as written) + parentId + selected environment
  → chain: the saved request's parents on disk (or the draft's parentId)
  → inherit (core/inherit): auth walks request → folders → collection
    (first non-`inherit` wins, else none); headers merge collection → folders
    → request, a deeper enabled header replacing the same name
  → scopes, lowest first: globals, collection, environment, local (empty;
    the runner seeds it with iteration data)
  → secret values from the store (unset/locked ones shadow but stay unresolved)
  → the script overlay laid over globals, collection and environment
  → pre-request scripts (core/script): collection → folders → request; they
    change the request and the scopes (local, overlay, secret store); an
    error or skipRequest stops here
  → resolve {{vars}} (core/vars): nesting up to 10 levels, cycles are errors,
    dynamic {{$guid}} {{$timestamp}}… fresh per occurrence; unresolved names
    are sent as written and reported
  → OAuth 2.0 (`Send.Authorize`): when the effective auth is OAuth 2.0, load
    the owner's token; refresh it first when it expires within 30 s (refresh
    token + auto refresh on; serialised per owner), or, for the client
    credentials and password grants, fetch one when there is none; never a
    browser flow. No usable token fails the send (`error.kind = "auth"`).
    The token becomes a bearer header or a query parameter and is masked
    (`[secret:oauth2AccessToken]`) from then on
  → build http.Request (body encoding, multipart files, Content-Type,
    User-Agent, Accept-Encoding: gzip, deflate, br), then apply auth last:
    basic/bearer/API key; JWT signed now; AWS SigV4 and Hawk computed over
    the final request (body buffered for the payload hash)
  → Digest: sent without auth, a 401 Digest challenge is answered once;
    NTLM: NEGOTIATE → CHALLENGE → AUTHENTICATE on a dedicated connection
  → execute with httptrace (DNS / connect / TLS / TTFB / total), cancellable
  → decode the body (gzip, deflate, br), cap it inline at 10 MB (the rest
    spills to a file)
  → test scripts: collection → folders → request (an error is a failed test)
  → history (request as written + environment name) → SendResult to the UI
    (tests, console and hops masked)
```

- Each send has an ID; `RequestService.Cancel(id)` cancels its context.
- OAuth 2.0 (`core/auth/oauth2`, standard library only): the authorization
  code grant (PKCE S256 by default, plain allowed), implicit, client
  credentials, password and refresh. Token requests go through
  `Executor.HTTPClient()`, i.e. the same cached transports as sends (proxy,
  CA, client certificates, TLS verification), without cookies or hops. The
  browser grants open the authorization URL through `AppControl.OpenURL`
  and wait on a single-use loopback server (`127.0.0.1`, random port and
  `/callback` by default, or a fixed `http://127.0.0.1|localhost:<port>/…`)
  that checks `state`, serves a small page (the implicit grant's page posts
  the URL fragment back to the same origin) and times out after 5 minutes
  (`AuthService.CancelOAuth2` stops it sooner). `AuthService` gets,
  refreshes, clears and (on request) reveals tokens and reports their status
  without values. Code generation writes the token as
  `{{oauth2AccessToken}}` unless secrets are revealed; examples, hops,
  console and runner reports mask it like a secret variable.
- Other auth (Tier 3 M7), all own code except NTLM:
  - **Digest** (`core/auth/digest`): MD5, MD5-sess, SHA-256, SHA-256-sess;
    qop auth or auth-int; userhash when the server asks. `httpexec.send`
    rebuilds the request (so any body replays) and retries once, only when
    the 401 came from the URL sent. Both exchanges are hops.
  - **AWS Signature v4** (`core/auth/awsv4`): signs host, Content-Type,
    Content-MD5 and every `X-Amz-*` header; the path is normalized and
    encoded twice except for S3; `X-Amz-Content-Sha256` for S3 and
    UNSIGNED-PAYLOAD. Tested with the AWS test-suite signatures.
  - **JWT** (`core/jwtx` + `auth.JWTToken`): HS/RS/PS/ES 256–512 and EdDSA;
    header extra fields and payload JSON resolved like raw JSON bodies; iat,
    exp (now + lifetime) and jti added unless set; header or query placement;
    a fresh token per send.
  - **Hawk** (`core/auth/hawk`): sha256/sha1, ext, app/dlg, optional payload
    hash, a new timestamp and nonce per send (README vectors).
  - **NTLM** (`Azure/go-ntlmssp`, MIT, NTLMv2 only): the handshake runs on a
    per-send transport (HTTP/1.1, one connection per host, closed after the
    send), outside the `Transports` cache, so no pooled connection is
    authenticated for other sends.
  - The user's own `Authorization` header always wins. Signing failures and
    unanswerable NTLM challenges are `error.kind = "auth"`. Resolved
    secret-bearing fields (Digest/NTLM passwords, AWS secret key and session
    token, JWT key, Hawk key) join the send's masks (`pipeline.AuthSecrets`),
    so even literal values read `[secret:<field>]` in hops and console.
  - Code generation (`auth.MaterializeWith`): cURL keeps Digest, NTLM and
    SigV4 as `--digest`/`--ntlm`/`--aws-sigv4`; Python keeps Digest
    (`HTTPDigestAuth`), PHP Digest and NTLM (`CURLAUTH_*`). Elsewhere SigV4,
    JWT and Hawk become headers computed now (with an expiry warning; skipped
    with a warning while a field is still a `{{reference}}`), and Digest/NTLM
    are left out with a warning. cURL import maps the same options.
- A variable cycle or too-deep nesting fails the send (`error.kind =
  "variables"`) before anything goes on the wire.
- The same preparation feeds the editor (`Preview`, `VisibleVariables`:
  inherited headers and auth, visible variables with secret values masked)
  and code generation. `Preview.overridden` lists the inherited headers the
  request's own enabled headers replace (shown struck through);
  `Visible.shadowed` lists the definitions that lose to a higher scope, so a
  settings tab that removes a row shows the lower-scope value that takes
  over. Code generation (`PrepareCode`: secrets kept as `{{name}}` unless
  revealed).
- Scripts (§7) run around the send. The request stored in history is the one
  the user wrote, without script changes; Debug hops show what was sent. Code
  generation and previews never run scripts (they do see overlay values).
- Per-workspace cookie jar (`core/cookies`, persistent cookies in SQLite):
  switching workspace loads that workspace's jar; the executor is rebuilt
  around it and the app settings.
- Effective options per send: the app settings (timeout, redirects, TLS
  verify) with the request's own `settings` applied on top
  (`model.RequestSettings`, nil = app setting). The timeout is a context
  deadline; redirect and TLS choices travel in the send's context.
- Transports come from a cache shared across executors
  (`httpexec.Transports`), keyed by network config (proxy, CA file, client
  certificates), TLS verification and the client certificate matched for the
  hop's host. Each hop (redirects too) picks its transport, so a request that
  turns verification off or needs a client certificate doesn't disturb other
  sends' pooled connections. A network settings change or a new proxy
  password/passphrase drops the cached transports (idle connections closed).
- Proxy: none, system (`HTTP(S)_PROXY`/`NO_PROXY`), or custom `http://`,
  `https://`, `socks5://` with credentials (password from the secret store)
  and a bypass list (names, `*.wildcards`, `.suffixes`, IPs, CIDRs). TLS: a
  PEM CA bundle added to the system roots, and client certificates (PEM pair
  or PKCS#12) chosen by host pattern.

## 7. Scripting (goja)

- `internal/core/script` (no Wails, no I/O): `script.Run(ctx, Input)` runs one
  script in a fresh goja runtime: timeout (`settings.scriptTimeoutMs`, 5 s by
  default, 1–60 s) and cancellation through `Runtime.Interrupt`, call depth
  capped (`SetMaxCallStackSize`), no `require`, filesystem, network or timers
  (those names throw an explanatory error). Console output is captured and
  capped per send (1000 entries / 1 MiB, then "Output truncated").
- The `pm` API, `console` and a chai subset are embedded JavaScript
  (`prelude.js`, `expect.js`): `pm.environment` / `collectionVariables` /
  `globals` / `variables` (get, set, unset, has, toObject, replaceIn),
  `pm.request` (mutable in pre-request scripts), `pm.response` (test scripts),
  `pm.test`, `pm.expect`, `pm.response.to.have/be…`, `pm.info`,
  `pm.iterationData`, `pm.execution.setNextRequest/skipRequest`. Postman
  snippets work unchanged where the API overlaps.
- Variables go through the `script.Vars` interface. `pipeline.Send` implements
  it: `pm.variables.set` writes the send's local scope; other scopes write the
  in-memory `pipeline.Overlay` (per open workspace, cleared on switch, close
  and restart; never stored unless the user persists a value through
  `EnvService.PersistOverlay`), or the secret store when the target is a
  secret variable.
- Errors carry the level (collection, folder, request), line and column. A
  pre-request error stops the send (`error.kind = "script"`, with
  `SendResult.scriptError {source, line, column}` so the UI can open that
  script); a test-script error becomes a failed test.
- Console lines, test names, errors and hops are masked (`[secret:name]`)
  with the send's secret values plus those scripts wrote. Console output also
  streams to the UI as `script:console` events; it is never persisted.

## 7a. Collection runner

- `internal/runner` (no Wails; the Tier 4 CLI reuses it): `runner.New(Config)`
  checks the configuration and resolves the order (the target's requests
  depth-first in tree order, optionally a subset), then `Runner.Run(ctx, Sink)`
  runs the iterations and returns a `runner.Report`; `runner.Run` does both.
  Each send is a `pipeline.Send` (same scopes, overlay, scripts and masking as
  a single send) executed by an `Executor` (`httpexec`).
- Per iteration the `local` scope starts from the data row (CSV with a header,
  or a JSON array of objects; `runner.LoadData`) and carries
  `pm.variables.set` values from request to request (`ScriptOptions.Local`,
  `Send.Local()`). `pm.info.iteration`/`iterationCount` and
  `pm.iterationData` are filled. `setNextRequest(name|id)` jumps within the
  run order (first name match, then id), `null` ends the iteration; more than
  1000 jumps in an iteration, or a name not in the run, ends the run with an
  error. `skipRequest` marks the result skipped.
- "Keep variable values" off runs on `Session.Isolated()` (a private copy of
  the overlay). Delay between requests via an injectable sleeper; ctx cancel
  stops between or within requests and keeps the results so far.
- Progress goes to a `Sink` (`started`, `requestStarted`, `requestFinished`,
  `iterationFinished`, `finished`); `RunnerService` forwards it as
  `runner:progress`, stores the report (`runs` table) and only then emits
  `finished`. One active run per workspace; a run keeps the workspace it
  started in.
- `internal/runner/report`: `JSON` (schema `version` 1, documented in
  `report.go`) and `HTML` (`html/template`, embedded CSS with light/dark via
  `prefers-color-scheme`, no scripts or external assets). Golden files in
  `testdata/` (`go test ./internal/runner/report -update`).
- Frontend: a lazy runner doc tab (`Tab.doc.kind = "runner"`, one per
  target) with the configuration (persisted with the tab), live results,
  summary, export and past runs (`stores/runner.ts`; results are never in
  localStorage). Runner console lines go to the shared console store, one
  group per request per iteration.

## 8. Frontend

- State: **Zustand** (tabs, active workspace, env selection); server data via bound service calls.
- Layout: resizable panes (`react-resizable-panels`), sidebar (collections / history / environments), tabbed editors.
- CodeMirror extensions: `{{var}}` highlight + hover tooltip + autocomplete (Mod+I from the keyboard), in the URL bar, bodies and every value cell (a cell is static text until focused, so large tables stay fast).
- Code splitting: every editor language (JSON, XML, HTML, JavaScript and the generated-code ones) is its own chunk, loaded on first use (plain text until then); the settings, code, import-cURL, cookie manager dialogs, the command palette, the Scripts section, the console drawer, the runner tab and the Digest/AWS/JWT/Hawk/NTLM auth fields load on first open (preloaded when idle).
- Theme: light/dark/system via CSS variables (shadcn tokens); command palette (`cmdk`), keyboard shortcuts.
- Drag & drop in tree: `dnd-kit`.
- Scripting UI (Tier 3 M4): a lazy **Scripts** tab (Pre-request / Tests) in request, collection and folder editors with `pm` completions from a static API description (`features/scripts/pmApi.ts`), snippets and a read-only view of the inherited scripts; a **Tests** tab in the response pane; a **console drawer** below the editors (lazy, Mod+J or the status bar), fed live by `script:console` and reconciled with `SendResult.console` per send, kept in memory only (`stores/console.ts`, 2000 lines); "Set by script" badges with Reset / Persist in variable tables (`EnvService.OverlayValues/ResetOverlay/PersistOverlay`), refreshed after every send.

## 9. Backend ↔ frontend contract

- Wails v3 services → generated TS bindings (`wails3 generate bindings`).
- Events (backend → UI): `workspace:changed` (file watcher, `fsnotify`; also covers environments and example sidecars), `update:progress`, `script:console` (`{sendId, entries}`, one per script run that logged, masked), `runner:progress` (`{runId, workspaceId, event}` with a `runner.Event`: started with the run's configuration and order, request started/finished with the masked result, iteration finished, finished with the outcome and summary after the run is stored), `oauth2:flow` (`{flowId, stage: "browser", authUrl}` once the authorization URL is opened, so the UI can offer to copy it). Planned: `request:progress`.
- DTOs are plain structs with JSON tags in `internal/core/model`.

## 10. Testing & quality

- Go: table-driven unit tests for core; `httptest.Server` for httpexec; fake keyring; temp dirs for fsstore; in-memory SQLite.
- Frontend: Vitest + React Testing Library; bindings mocked.
- Coverage gate ≥ 80% (Go `-coverprofile`, Vitest `--coverage` with thresholds).
- Lint: `golangci-lint`, ESLint + Prettier, `tsc --noEmit`.

## 11. Defaults chosen (change if you disagree)

- File format **YAML**; IDs are **ULIDs**.
- SQLite via **modernc** (no CGO).
- State management **Zustand**.
- Future headless **CLI runner** enabled by keeping core Wails-free (not built now).
- HTTP/1.1 + HTTP/2 via Go stdlib.
