# Pakpos — Tier 3 (Power features) Plan

Reference: [ARCHITECTURE.md](./ARCHITECTURE.md), [ROADMAP.md](./ROADMAP.md), [PLAN-TIER2.md](./PLAN-TIER2.md) (carry-overs), [PLAN-TOOLS.md](./PLAN-TOOLS.md) (`core/jwtx`, reused by the JWT generator)

## Scope

**In:** everything under Tier 3 in ROADMAP.md, plus the Tier 2 carry-overs:
- Orphan secret pruning, including values for unsaved secret rows
- Overridden inherited headers shown struck through
- Rename from collection and folder settings tabs
- Removed draft rows in settings tabs
- A `scripts/` screenshot helper
- Variable support in the bulk "Edit as text" view
- The first `release.yml` run and the macOS/Windows smoke test

**Out (Tier 4):**
- `pm.sendRequest` (scripts have no network access)
- Headless CLI (the runner core is built so the CLI can reuse it)
- Mock server
- Postman import
- Undo in table cells
- Code signing (unless secrets become available)

PLAN-TOOLS stays a separate plan.

## Decisions

| Topic | Decision |
|---|---|
| Script engine | goja (MIT) in `internal/core/script`, no Wails. Each script run gets a fresh runtime. Timeout is 5 s by default (setting, 1–60 s), enforced with `vm.Interrupt`. `SetMaxCallStackSize` is set. No `require`, filesystem, network or timers. Console output is capped (1000 entries, 1 MiB). |
| Script storage | `scripts: {preRequest: \|, test: \|}` as block scalars in the request YAML, `_folder.yaml` and `_collection.yaml`. Empty means omitted. |
| Execution order | Pre-request scripts run collection → folders → request, after scopes are built and before `{{vars}}` resolve, so a script can set a variable the request uses. Test scripts run in the same order after the response. An error in a pre-request script stops the send (`error.kind = "script"`); in a test script it is reported as a failed test. |
| `pm` API | `pm.environment` / `pm.collectionVariables` / `pm.globals` / `pm.variables` (get, set, unset, has, replaceIn). `pm.request`: method, url, headers add/upsert/remove, body; mutable in pre-request scripts. `pm.response`: code, status, headers.get, text(), json(), responseTime, responseSize. Also `pm.test`, `pm.expect` (a chai subset in embedded JS), `pm.response.to.have.status/header/jsonBody`, `pm.info`, `pm.iterationData`, `pm.execution.setNextRequest` / `skipRequest` (runner only), and `console.*`. The `pm` name is kept so Postman snippets work. |
| Variable overlay | `pipeline.Overlay` is held in memory per workspace and keyed by scope ID. `BuildScopes` lays it over file values. `pm.variables.set` writes to the `local` scope for that send or runner iteration. A secret target writes through the secret store (`ensureReady` first). The overlay clears on workspace switch or app restart. The UI marks overridden rows "Set by script" and offers Reset and "Persist to file" (which goes through `SaveVariables`). |
| Secrets in script output | Console lines, test names and error messages are masked with `pipeline.SendSecrets` + `maskText` (`[secret:name]`) before they reach the UI. The console is never persisted. |
| Per-request settings | `settings: {timeoutMs, followRedirects, maxRedirects, verifyTls}` with pointer fields: unset means the app setting. Request level only. Shown in a "Settings" tab in the request editor. |
| Proxy | App setting: none, system (`http.ProxyFromEnvironment` plus OS settings where Go reads them), or custom `http://`, `https://`, `socks5://` with a bypass list. The proxy password goes in the secret store under the app scope `pakpos/_app/proxy`. |
| TLS | Custom CA bundle (PEM path, added to the system pool). Client certificates per host pattern: PEM cert+key or PKCS#12, with the passphrase in the secret store. The executor caches transports keyed by their TLS and proxy config, so per-request `verifyTls` doesn't reset connections. |
| Cookies | Migration `0005_cookies.sql` (renumbered: M1 took 0004): persistent cookies per workspace (no session cookies). The jar implementation is backed by SQLite and still uses the public-suffix list. A cookie manager dialog shows cookies grouped by domain, with view, edit, add, delete and clear-domain. Cookies never go into workspace files. |
| Runner | `internal/runner` (no Wails) drives `pipeline` + `script` + `httpexec` and is reusable by the Tier 4 CLI. It runs a collection or folder in tree order, with iterations, a delay, a data file (CSV with a header row, or a JSON array of objects → `pm.iterationData` and the `local` scope), stop-on-first-failure, and `setNextRequest`. Runner sends skip history by default (toggle). A run opens as a doc tab `runner`, gets live `runner:progress` events, and ends with a summary. The report can be exported as JSON and as standalone HTML. The last 20 run summaries per workspace are kept in SQLite (`0006_runs.sql`, request as written and no bodies). |
| Auth model | Additive sub-structs on `model.Auth`: `oauth2`, `digest`, `awsv4`, `jwt`, `hawk`, `ntlm` (omitempty). Secret-bearing fields (client secret, AWS secret key, signing key, Hawk key, NTLM password) follow the Tier 2 rule: `{{ref}}` makes it a variable field, and a literal value is masked with the "Move to secret variable" hint. |
| OAuth 2.0 | `golang.org/x/oauth2` (BSD). Grant types: Authorization Code with PKCE (S256), Client Credentials, Password, and Implicit. The browser flows use a loopback redirect on `127.0.0.1:<random or configured port>` opened through `AppControl.OpenURL`. Implicit uses a small page that posts the fragment back. Tokens are stored in the secret store under `pakpos/<ws>/<authScopeId>/oauth2` (M6: the key name is `{oauth2}`, see the M6 decisions). A token is refreshed before a send when it expires within 30 s and has a refresh token. UI: Get new token, token details (expiry, scopes), Clear. The token endpoint goes through the app proxy and TLS settings. |
| Other auth | Digest (MD5, SHA-256, `qop=auth`; retries once on a 401 challenge, and both hops appear in Debug). AWS SigV4 (own implementation tested against the AWS sigv4 test suite vectors; no AWS SDK dependency). JWT generator (signs with `core/jwtx`; if PLAN-TOOLS hasn't landed, M7 creates the signing half). Hawk (own implementation from the spec). NTLM (`Azure/go-ntlmssp`, MIT, needs a dedicated keep-alive connection per handshake; **droppable**). |
| Codegen and cURL for new auth | OAuth2 → bearer with `{{…}}` or the masked token. Digest → `curl --digest` plus library helpers. SigV4 → `curl --aws-sigv4`; other languages get the computed headers with a "valid for 5 minutes" warning. JWT, Hawk → computed header with a warning. NTLM → `curl --ntlm` and a warning elsewhere. cURL import maps `--digest`, `--aws-sigv4`, `--ntlm` and `--oauth2-bearer`. |
| Orphan pruning | Migration `0004_secret_index.sql` (M1; the draft said 0006): an index of the secret **keys** written per workspace (names only, never values), because keychains can't list keys. On unlock (file store) or workspace open (keychain), keys whose scope or variable no longer exists are deleted. This also covers values for unsaved secret rows. See the M1 decisions below for the details. |
| File format | Manifest `version: 3`. It upgrades on the first v3-only write (scripts, new auth types, request settings). `fsstore.Open` refuses a manifest version newer than it knows, with a clear "made with a newer Pakpos" message, so an older build doesn't drop fields on save. |
| New dependencies | goja (MIT), golang.org/x/oauth2 (BSD; not used: M6 is standard library only), Azure/go-ntlmssp (MIT, only if NTLM stays). All are pure Go. Dev only: `playwright` (Apache-2.0, frontend devDependency, for `scripts/screenshot.mjs`). |

### Decisions made in M1

| Topic | Decision |
|---|---|
| Manifest v3 constants | `fsstore.FormatVersion = 3` is the newest version this build reads and the version **new workspaces are created with** (as Tier 2 did with v2). `fsstore.VersionV2 = 2` is what the Tier 2 writes (folders, environments, globals, examples, collection secrets) upgrade to: they never lift a manifest past v2, and never lower a v3 one. `upgradeManifestLocked(to)` takes the target version; v3-only writes will call it with `FormatVersion`. |
| Newer workspaces | `fsstore.ErrUnsupported` ("workspace was made with a newer version of pakpos: format version N, this build reads up to 3"); `WorkspaceService.Open` turns it into the user message `service.MsgNewerWorkspace` ("This workspace was made with a newer version of Pakpos. Update Pakpos to open it.", a `userError` that unwraps to `ErrUnsupported`). The frontend matches "newer version of Pakpos" (like "not a pakpos workspace") and shows "This workspace needs a newer Pakpos" with a "Check for updates" action. It never offers "Create workspace here" for it. |
| Overridden headers | `inherit.Result.Overridden` / `pipeline.Preview.overridden`: the inherited headers that would apply but for an **enabled** request header of the same name (case-insensitive), with their source, outermost first. Rows already hidden by a deeper folder are not listed (the folder's row is the one the request overrides). The Headers view lists them after the applied ones, struck through, with the title "Overridden by this request" and the same text for screen readers; the source link stays usable. |
| Rename from settings tabs | Collection and folder settings tabs get a pencil button ("Rename collection"/"Rename folder", with a tooltip) and a double click on the title, both opening `InlineRename`; commits go through `useWorkspaceStore.renameCollection`/`renameFolder`, and `syncContainerTabs` updates the tab name from the tree. Environments keep their menu entry and double click. A tab whose target was deleted can't rename. |
| Removed draft rows | `pipeline.Visible.shadowed` lists every definition that loses (to a higher scope, or to a later row of the same scope), by key and then highest precedence first, secret values blank. `overlayDraft(visible, target, draft, shadowed)` replaces each of the edited scope's saved winners with the first shadowed definition from another scope, then applies the draft; so removing or disabling a row shows the value that takes over. |
| Bulk "Edit as text" | The headers text view is a `<CodeEditor>` (plain text, line numbers, `variables` from `VarScopeContext`), so `{{vars}}` get highlighting, hover and completion like other editors. It focuses on open. Params have no text view, so nothing changed there. |
| Secret index | `0004_secret_index.sql`: `secret_index(workspace_id, scope_id, key, written_at)` (Unix seconds). `pipeline.Session.WithSecretIndex(idx)` wraps the session's store so every successful `Set` records the key (`RecordSecretKey`) and every `Delete` forgets it; this covers `SetSecret`, renames, `DuplicateEnvironment` copies, `ClearSecret`, `MakePlain` and all cleanups without touching each call site. `Core.session` always passes `c.db`. Index failures are logged; the value change still happens. `secrets.SplitKey` reverses `secrets.Key`. |
| Pruning rules | `Session.PruneSecrets(before)`: (1) skips a workspace whose tree has problems (a broken file must not cost its values); (2) adopts the keys of every current secret variable (`AdoptSecretKey`, dated at the epoch when new) so values stored before the index existed are covered; (3) deletes each indexed key whose scope or secret variable is gone **and** that was written before `before`. Services pass `Core.started` (the app start), so a value set on an unsaved row in the running session survives until the next start. It runs after a workspace opens and after `EnvService.Unlock`; a locked or passwordless file store stops it quietly (it runs again on unlock), other errors are logged. Consequence (accepted): a settings-tab draft persisted across a restart with a value set on a never-saved secret row loses that value on the next start; the row then reads "Not set on this machine". |
| Screenshot helper | `scripts/screenshot.mjs` (Node ESM, not linted or covered: it's a dev tool outside `frontend/`). It requires `playwright` from `frontend/node_modules` (added as an exact devDependency, `1.65.0`; 1.65.1 was younger than the 7-day release-age guard) and a browser from `npx playwright install chromium` (or `PAKPOS_CHROMIUM`). Method IDs come from `frontend/bindings/.../index.ts` + the service modules. Defaults: a workspace with one collection, two requests and an environment; `--scenario file.mjs` adds `handlers` and replaces the steps with `run({page, shot, theme})`; `--theme both` shoots light and dark. |

### Decisions made in M2

| Topic | Decision |
|---|---|
| Request settings model | `model.Request.Settings` is a value struct (`RequestSettings`) of pointers with `omitempty` and an `IsZero` method, so yaml.v3 omits the block when nothing is set. Any set field makes the request a v3-only write (`fsstore.upgradeForRequestLocked`, on create and save). Limits are shared with the app settings: `httpexec.MaxTimeoutMs`/`MaxRedirectsCap` (re-exported by `settings`); `ValidateRequestSettings` refuses bad values on send (`invalid_request`) and in `RequestService.Save`/`SaveAs` ("Check the request's Settings tab: …"). The UI takes the timeout in seconds with up to 3 decimals (cURL's `-m 2.5` round-trips). |
| Per-send application | No client rebuild per send: `Execute` puts a `sendOptions` value (timeout, follow, max redirects, insecure) in the context; the timeout becomes a context deadline, `CheckRedirect` and the router read the rest. |
| Transport cache | `httpexec.Transports`, one per `Core`, shared by every executor (workspace switches and settings saves build a new executor but keep pooled connections). Key: the network config (JSON of proxy, CA path, client certs), insecure, and the client certificate matched for the hop's host. A request for another network config evicts stale transports; `Reset` closes idle connections after a network setting or a stored password changes. The router sits under `recordingTransport`, so debug hops work for every transport. |
| Client certificate per host | Chosen per hop by `MatchHost(cert.host, hop host)` (first match wins), since `tls.Config.GetClientCertificate` doesn't see the server name; one transport per certificate keeps redirects to other hosts correct. Patterns: `*`, `*.example.com` (subdomains), `.example.com` (domain and subdomains), CIDR, exact. Ports are not part of patterns. Passphrases only for PKCS#12; PEM keys must be unencrypted (legacy encrypted PEM is deprecated in Go). PKCS#12 uses `software.sslmate.com/src/go-pkcs12` v0.7.4 (BSD-3; `x/crypto/pkcs12` can't read modern AES-encrypted files). |
| Proxy | Default mode is **system**, which is what Go's default transport did before. "System" is `http.ProxyFromEnvironment` (env vars, read once per process); Go reads no OS proxy settings on macOS/Windows, so those need the env vars or a custom proxy (documented, smoke-tested). The bypass list applies in system and custom modes (in addition to `NO_PROXY`); loopback isn't bypassed automatically in custom mode. Credentials go in the proxy URL handed to `net/http` (HTTP `Proxy-Authorization`, CONNECT, SOCKS5 user/password); credentials typed into the URL are refused. No `x/net/http/httpproxy` (it would pull in `x/text`). |
| Network secrets | App-level keys `pakpos/_app/proxy` and `pakpos/_app/cert/<id>` (`secrets.AppKey`), read lazily through `Network.Secret` when a transport is built. "Not found" and "no master password yet" mean empty; a locked store fails the send (`proxy`/`tls` error) and sets `SendResult.SecretsLocked`. They are not in the secret index (not per workspace); `SettingsService.Set` deletes the passphrase of a removed certificate. `NetworkSecretStatus` reports `locked` instead of failing. The dialog stores passwords **after** the settings save (so a new certificate's id exists in Go), after `ensureReady()`; certificate ids for new rows are made in the frontend. |
| File checks | `SettingsService.Set` loads a CA file or PEM pair that is new or changed (`Network.Check`) and returns a user message naming the file; unchanged entries aren't re-checked, so a file that disappeared later doesn't block saving the theme. PKCS#12 files are only checked for readability at save (the passphrase may be locked away). Send-time errors are `KindTLS` naming the file; a new `KindProxy` ("proxy") covers proxy connect failures, a 407 on CONNECT and bad proxy settings; TLS alerts like "certificate required" say to add a client certificate. |
| Cookie jar | Own `http.CookieJar` in `internal/core/cookies` (RFC 6265 domain/path matching, public suffix list) instead of wrapping `net/http/cookiejar`, which can't list cookies for the manager. Identity is (domain, path, name). Persistent cookies are written through a `Store` on every change (`sqlite.Store.Cookies(workspaceID)`), session cookies stay in memory. IP hosts get host-only cookies. Write failures are logged; the cookie still applies in memory. |
| Cookie scope | One jar per workspace; workspace `""` (sends without a workspace) is persisted too, like its history group. `Core.loadJarLocked` runs on start, open and close. In-flight sends keep the jar they started with. |
| Cookie manager | Lazy `CookieManagerDialog` (preloaded on idle), `stores/cookies.ts`; opened from the palette ("Manage cookies") and the response Cookies tab ("Manage cookies", focused on the response's host, listed first). List grouped by domain with a filter; add/edit form (name, value, domain, path, include subdomains, expiry date or session, Secure, HttpOnly, SameSite); delete one, delete a domain, delete all (inline confirmation). Edits that change name/domain/path replace the old cookie (`Update(old ref, cookie)`). Values may contain spaces and commas (Go quotes them on send); control characters, quotes, `;` and `\` are refused. |
| Settings dialog | Requests keeps timeout/redirects/TLS verify; a new **Network** section holds proxy, CA file and client certificates (moving the request options there would mix per-send behaviour with connection setup). |
| Codegen | Only cURL maps request settings (`-k`, `-L` + `--max-redirs`, `--max-time`); other languages ignore them (no portable equivalent in every generator). App settings are never written into generated code. |

### Decisions made in M3

| Topic | Decision |
|---|---|
| goja version | Pinned to commit `cf2ff0ec` (2026-10-31, pseudo-version `v0.0.0-20261031103838-cf2ff0ec0b31`): goja has no tags, and the newest commit was a day old, so an older one was taken (same spirit as the npm release-age guard). Pulls in `dlclark/regexp2/v2` (MIT), `go-sourcemap/sourcemap` (BSD-2), `google/pprof` (Apache-2.0) and `golang.org/x/text` (BSD-3); all pure Go. |
| Sandbox | `script.Run` compiles the script with goja's parser (syntax errors keep line:column), creates a fresh `goja.Runtime`, sets `SetMaxCallStackSize(1000)`, and interrupts the VM from a `time.AfterFunc` (timeout) and a goroutine watching the context (cancel). `require`, `setTimeout`/`setInterval`/`setImmediate`/`clear*`, `fetch` and `pm.sendRequest` exist but throw an error saying why ("isn't available in Pakpos scripts: …") instead of a bare ReferenceError. `btoa`/`atob` are provided (Latin-1, like browsers). No memory cap (goja has none): the timeout bounds it. |
| JS/Go boundary | The `pm` API, `console` and the chai subset are embedded JS (`prelude.js`, `expect.js`, compiled once into `goja.Program`s). The prelude is a closure called with a small Go host object (variables, console, test results, btoa/atob), so scripts can't reach the host. The request and response go in as JSON and the request's state comes back as JSON (no Go objects wrapped into the VM). |
| Values set by scripts | Stored as strings: strings as is, objects/arrays as `JSON.stringify`, other values `String(v)`, `undefined` as "". `pm.*.get` returns strings (Postman keeps types; documented difference). |
| `pm.request` | The effective request (inherited headers and auth applied, `{{vars}}` unresolved) as it will be sent. `url` is an object (`toString()`, `addQueryParams`, `removeQueryParams`, `getQueryString`) and is assignable; a changed URL re-reads the query rows and path params from it, as the URL bar does. `headers` get/has/add/upsert/remove/each/all/count/toObject (add/upsert take `{key, value}`, `"Key: value"` or `(key, value)`). `body.raw` is settable (makes the body raw), `body.update`, `body.mode`, `body.toString()`. Changing anything in a test script throws. |
| `pm.response` | `undefined` in pre-request scripts. Test scripts get the full decoded body (a body spilled to a file is read back up to 64 MiB, `pipeline.MaxScriptBody`), as UTF-8 text (invalid bytes become U+FFFD). `status` is the reason phrase ("OK"). `to.be.ok` means code 200 as in Postman; `success` 2xx, `error` 4xx/5xx. |
| `pm.test` | Synchronous: a thrown error fails the test with `"Name: message"` (`AssertionError: expected 404 to equal 200`); no function or `pm.test.skip` records a skipped test. Promises returned by a test aren't awaited. Tests in pre-request scripts count too. |
| Script errors | `*script.Error{Source, Line, Column, Message, Timeout, Canceled}`; `Error()` is `Error in the pre-request script of folder "Auth" at line 3:5: ReferenceError: x is not defined` (no position for timeouts: `… : Script took longer than 5 s`). Pre-request: the first error stops the remaining levels and the send (`error.kind = "script"`, recorded in history with the masked message). Test: each error is a failed test named `Script error` (`pipeline.ScriptErrorTest`) and the next level still runs. A cancelled send stops at once and is not recorded. |
| skipRequest / setNextRequest | `skipRequest()` in a pre-request script stops the remaining pre-request levels and the send: `SendResult.skipped = true`, no response, no error, nothing recorded. `setNextRequest` (and `postman.setNextRequest`) is recorded in `ScriptReport.NextRequest`/`NextStop` for the M5 runner; a single send ignores it. |
| Console caps | Per send (one `script.Budget` shared by all its script runs): 1000 entries or 1 MiB of text, then one `warn` entry "Output truncated: …" and nothing more. Values are formatted as JSON-ish text (`{"a": 1}`, `[Circular]`, nesting cut at 5 levels). |
| Variable writes | `pm.variables.set` → the send's local scope (seeded from `ScriptOptions.IterationData` for the runner). `pm.environment`/`collectionVariables`/`globals.set` → if the scope defines the name as a secret, the secret store through the session (indexed); otherwise `pipeline.Overlay`. A scope the send doesn't have (no environment selected, a draft outside a collection, no workspace) throws a user message ("No environment is selected, so pm.environment can't set "token". Select an environment and send again."). A locked store throws "The secret store is locked, so the secret … wasn't set. Unlock it and send again." and sets `SendResult.secretsLocked`. `unset` on a stored scope hides the variable for the session (an `unset` overlay entry, the file and the store keep it), or drops a script-only value. |
| Overlay | `pipeline.Overlay` (scope id → name → value or unset) in `Core`, created with each workspace opened (also when the same one is reopened) and dropped on close, so it never outlives its workspace or the process; a send that outlives its workspace writes nowhere. `BuildScopes` lays it over filled file values for globals, collection and environment, so Preview, VisibleVariables, code generation and example secret scans all see it. `PreviewVariable.overlay` is `"set"`/`"new"` (`""` for file values). Secret values never go into the overlay. `EnvService.OverlayValues`/`ResetOverlay`/`PersistOverlay` (key `""` = whole scope); Persist sets the value on the variable's rows (enabling the last one if none is), adds a row for a new name, removes the variable for an unset entry, writes a secret's value to the store, then saves through `SaveVariables`. |
| Masking | `pipeline.Send` starts from `SendSecrets` and adds every value a script writes to a secret variable (plus its encoded forms). Console text, test names and errors, the pre-request error message and the hops are masked with `[secret:name]` before they leave `pipeline`; the `script:console` event carries the masked entries. Values shorter than 4 characters aren't masked (same rule as examples). A script that transforms a secret (e.g. splits it) can still log the result: accepted. |
| History | Stores the request as written by the user, without script changes (scripts would otherwise put resolved or secret values in SQLite); the Debug hops show what was actually sent. |
| Not scripted | Code generation, Preview, VisibleVariables and the example secret scan never run scripts (they do see overlay values). |
| `scripts` model | `model.Scripts{PreRequest, Test}` on requests, `fsstore.Folder` and `fsstore.Collection`; `FolderSettings.Scripts`/`CollectionSettings.Scripts` are pointers so `nil` keeps the saved scripts (the current settings tabs don't send them). `Scripts.MarshalYAML` writes literal block scalars; yaml.v3 falls back to a quoted string when a block can't hold the text (trailing spaces), which still round-trips. Non-empty scripts on any level upgrade the manifest to v3. |
| Script timeout setting | `settings.ScriptTimeoutMs` (default 5000, 1000–60000; `Normalize` turns a missing 0 into the default so older stored settings stay valid). The Settings dialog's Requests section has "Script timeout" in whole seconds. |
| Event | `script:console` (`service.EventScriptConsole`, payload `ScriptConsoleEvent{sendId, entries}`), one event per script run that logged something; `api.onScriptConsole` subscribes. |

### Decisions made in M4

| Topic | Decision |
|---|---|
| Script error location | `SendResult.scriptError {source, line, column}` (Go `service.ScriptErrorInfo`, nil unless a pre-request script failed; line 0 for a timeout) so the error state can open that level's Scripts tab without parsing the message. History entries don't carry it (the button only shows for live results). |
| Scripts tab | Request section `scripts` (between Auth and Settings) and a `scripts` section in collection and folder settings; the Pre-request/Tests sub-tab is the tab's own `scripts` pane section, so it is remembered per tab. A dot marks the tab when either script is non-empty. The section is a lazy chunk (`loadScripts`, preloaded on idle with the dialogs). |
| Completions | A static description of the `pm` API (`features/scripts/pmApi.ts`) with per-event validity; members valid only in the other script are left out (e.g. no `pm.response` in pre-request, no `headers.upsert` in tests). Added as CodeMirror language data next to lang-javascript's own completions (`CodeEditor` `completions` prop). The receiver path is parsed backwards through names and balanced calls (`pm.expect(x).to.` → assertion words). No hover docs: completion info shows the one-line doc. |
| Snippets | Seven snippets (status 200, response time, JSON property, env var from JSON, set a header, set a variable, log the response); those valid in one script are disabled in the other with the reason under the label. Inserted at the cursor on a line of their own. |
| Inherited scripts | A collapsed "Runs before this request's/folder's script: Collection X, Folder Y" line (only levels with a script for the open event), expanding to read-only editors with "Open … settings". Read through `getCollection`/`getFolder` per level (no new Go API), re-read on `environments.version`. |
| Doc tab scripts | `DocDraft.scripts`; saving a collection/folder passes `scripts` only when they differ from the saved copy, so a settings tab persisted before M4 (restored with empty scripts) never clears scripts on disk. |
| Tests tab | `passed/total` where skipped tests don't count; colour `text-status-ok` when all pass, `text-status-client` otherwise; filter All/Passed/Failed (skipped only under All). Each row links to its script ("test script of collection X"). |
| Console | Bottom drawer inside the workspace pane (below request/response or the settings editor), not across the sidebar. Toggle: status bar "Console" button (with unread count while closed), palette "Toggle console" and **Mod+J** (free; VS Code's panel toggle). Lines per send under a header (time, method, name, status); a send that logged nothing leaves no header. Live events append; the final `SendResult.console` replaces the group's lines (no duplicates), and later events for a finished send are ignored. A pre-request script error is added as an `error` line. Cap 2000 lines, oldest dropped. Not persisted; open state is not persisted either. |
| Drawer layout | The editors panel keeps its position in a vertical panel group and the console panel is added only while open, so editors (and their undo history) never remount; the height is saved under `panels.console` only while the console is open. |
| Overlay refresh | `sendTab` bumps `environments.version` after every send in a workspace (scripts may have set values), which re-runs previews, `VisibleVariables` and the tables' `OverlayValues`. |
| Overlay UI | Under the applying row's value: "Set by script" + value (masked for secrets) + Reset + "Persist to file"; a value only scripts define is a virtual row "New, set by script" above the blank row; an `unset` entry shows "Unset by script". "Reset all script values" above the table. The palette's "Reset script values" resets globals, every environment and every collection. `overlayDraft` keeps a set/new overlay value winning over edited rows of the same name; hover sources read "… · set by script". |

### Decisions made in M5

| Topic | Decision |
|---|---|
| Package shape | `internal/runner` (no Wails): `runner.New(Config)` validates and resolves the order, `Runner.Run(ctx, Sink)` returns a `runner.Report`; `runner.Run(ctx, Config, Sink)` does both. The Go type is `Report` (the function owns the name `Run`). Requests are read once when the run starts; edits during a run apply to the next one. `RunnerService.Start` validates synchronously (bad data file, iterations mismatch, nothing selected → user message) and then runs in a goroutine with its own context. |
| Order and subset | Depth-first over `ws.Tree()` (folders and requests share the seq order). `RequestIDs` filters but never reorders; the frontend sends none when every request is selected, so requests added since still run. Unknown ids are ignored. |
| Data file | CSV (`encoding/csv`, header row required, unique non-blank names, every row as wide as the header, BOM stripped) or JSON array of objects (key order kept; strings as is, `null` → "", numbers as written, booleans, objects/arrays compacted JSON). Format by extension, else sniffed (`[` → JSON). Limits: 32 MiB, 10000 rows. Iterations 0 → one per row; any other number that differs from the row count is an error (no Postman-style "repeat the last row"). The runner tab disables Iterations while a file is set. |
| Data precedence | The data row seeds the iteration's `local` scope, so `{{column}}` beats globals/collection/environment and is beaten by `pm.variables.set` in the same iteration (the last write wins in `local`). `pm.iterationData` always shows the row as read. |
| Local scope per iteration | `local` starts fresh each iteration and carries from send to send within it (`ScriptOptions.Local` ← `Send.Local()`), as Postman's `pm.variables` do; a `pm.variables.unset` of a data column sticks for the rest of the iteration. |
| setNextRequest | Applied after the request (pre-request or test script, last call wins). Target: the first request in the run order with that name, else that id. `null` ends the iteration. A target not in the run (e.g. unchecked) or more than 1000 jumps in one iteration end the **run** with outcome `error` and a message (results so far kept). |
| Outcomes | `passed` (all iterations, nothing failed), `failed` (all iterations, a failed test or request error), `stopped` (stop on first failure: a request error or a failed test; skipped requests and skipped tests don't count), `canceled`, `error` (above). A request in flight when cancelled is not added to the results. |
| Keep variable values | On (default): scripts write the workspace overlay as a single send does. Off: `Session.Isolated()` gives the run a private copy of the overlay (it sees the current script values, its writes vanish with the run). Secret targets still go to the secret store either way (there is no private secret store). |
| History | Off by default. On: each send is recorded like a single send (request as written, environment name; pre-request script and variable errors recorded; skipped sends not). Off: a spilled response file is deleted after the test scripts ran. |
| Save responses | Off by default. On: text bodies masked with the send's secrets and headers' values masked, cut at 1 MiB each (`MaxSavedBody`, history's inline limit) and 32 MiB per run (`MaxSavedBodies`, later bodies `omitted: "limit"`); binary bodies aren't kept (`omitted: "binary"`). |
| Masking | Console, test names/errors, script and send error messages, saved bodies and headers go through `Send.Mask` (send secrets plus script-written secrets). Requests are stored as written. Data file values are **not** masked: they are user data, shown in the preview and the console as is (documented). |
| Storage | `0006_runs.sql`: list columns + `summary_json` + `run_json` (the whole report). The SQLite package stores JSON and doesn't import the runner. 20 runs per workspace (`sqlite.MaxRuns`), pruned in the insert's transaction. Only the data file's base name is kept. Summaries list at most 500 failures (`failuresTotal` counts all). |
| Event | `runner:progress` (`RunnerProgressEvent{runId, workspaceId, event}`), events `started` (the report without results, with the order), `requestStarted`, `requestFinished` (the masked result), `iterationFinished`, `finished` (outcome, error, summary). `finished` is emitted after the run is stored, so a `List` right after includes it. One active run per workspace (`MsgRunActive`). |
| Reports | JSON: `{version: 1, generator, run}` with the schema documented in `report.go`. HTML: `html/template`, embedded CSS (light/dark through `prefers-color-scheme`), no scripts, no external assets; summary, failures, per-request table, per-iteration tables with `<details>` for tests, console and saved bodies. Golden files with `-update`. The save dialog suggests `<target>-run-YYYYMMDD-HHMMSS.<ext>`. |
| Runner tab | `Tab.doc.kind = "runner"` with `doc.runner: RunnerSettings` (target kind, `excludedIds` (so new requests are selected), environment (null = the selected one at run time, "" = none), iterations, delay, data file path, options), persisted with the tab; draft null, never dirty, Save is a no-op. One tab per target, title "Run <name>", Play icon; `syncContainerTabs` renames and closes it with its target. Lazy chunk (`loadRunner`, preloaded on idle). Results and past runs live in `stores/runner.ts` only. |
| Runner UI | Config column (checklist with Select all/none, environment, data file + preview, iterations, delay, four options) and a Results / Past runs view (the tab's `runner` section). Results show at most 500 rows (export for all). Past runs in the tab are the target's; the palette's "Open run history" lists the workspace's. |
| Console | Each runner send with console output (or a pre-request script error) becomes one finished console group via `addRunSend`, with `context` "Run <target> · Iteration N" in the header and the group's accessible name. No live `script:console` streaming for runner sends (lines arrive with each finished request). |

### Decisions made in M6

| Topic | Decision |
|---|---|
| Library | **Standard library only**, not `golang.org/x/oauth2`: the grants are a few form posts, and owning them gives exact control over client authentication (RFC 6749 §2.3.1 form-encoding before Basic), JSON *and* form-encoded token responses, `id_token`, error messages and the injected client. No new dependency. |
| Model | `model.Auth.OAuth2 *model.OAuth2` (`omitempty`), type `oauth2`. Fields: grant (`authorization_code` default, `client_credentials`, `password`, `implicit`), auth URL, token URL, `redirectUrl` ("" = loopback on 127.0.0.1 with a random port and `/callback`; else a fixed `http://127.0.0.1\|localhost:<port>/<path>`), client id/secret, `clientAuth` (basic header default, or body), scope, username/password, `disablePkce` + `pkceMethod` (S256 default, plain), `placement` (header with `headerPrefix` default Bearer, or query with `queryParam` default `access_token`), `disableAutoRefresh`, `extraParams` (key/value rows added to the authorization and every token request: audience, resource). Booleans are "disable…" so the defaults are the zero values and YAML stays empty. Any auth with type oauth2 or an `oauth2` block is a v3-only write (`Auth.IsV3`). The block is kept when the user switches to another type (like the other auth fields). |
| Token key | `pakpos/<ws>/<ownerId>/{oauth2}` instead of `…/oauth2`: a collection's id is also its variable scope id, so a secret variable named `oauth2` would collide; braces can't appear in a `{{name}}`. The value is JSON (`oauth2.Token`: access, refresh, token type, scope, id_token, expiresAt, obtainedAt). |
| Owner | The request (saved id), folder or collection whose own auth is OAuth 2.0; an inheriting request uses the level it inherits from (`pipeline.TokenOwner`). An unsaved request with its own OAuth 2.0 auth can't hold a token ("Save the request first"). A send without a workspace fails with kind `auth`. |
| Send-time behaviour | `Send.Authorize` after `Prepare` (single sends and the runner): a stored token not expiring within 30 s is used; otherwise refresh (refresh token present, auto refresh on), serialised per owner (`pipeline.OAuth2` lock map shared by the Core) so concurrent sends refresh once; client credentials and password grants **fetch a token automatically** when none is usable (no user interaction needed); a code/implicit token that has expired without a refresh fails; one that expires soon but can't be refreshed is still sent. No browser flow is ever started from a send. Failures are `httpexec.KindAuth` ("auth") with a message naming the Auth tab (of the inherited level when inherited), masked, and recorded in history like variable errors. A locked store sets `SecretsLocked`. A store without a master password can't keep a fetched token, but the send still uses it. |
| Token endpoint transport | `Executor.HTTPClient()`: the app's cached transports (proxy, CA, client certificates, TLS verify), no cookie jar, no debug hops, redirects not followed, the app timeout (30 s when none). Token exchanges don't appear in the Debug tab. |
| Loopback | `oauth2.Listen`: 127.0.0.1 only (plus `::1` when the callback host is `localhost`), single use (later requests get "already handled"), `state` compared in constant time; a mismatch or provider error fails the flow with a clear message. The page is self-contained (inline CSS with light/dark via `prefers-color-scheme`, CSP `default-src 'none'`); for implicit it POSTs `location.hash` to the same path and clears the hash from the address bar. 5-minute timeout (`AuthService` default), cancellable by `CancelOAuth2(flowId)`. A busy fixed port is reported ("another program may be using it"). |
| Masking | The access and refresh tokens join a send's secrets once loaded (`[secret:oauth2AccessToken]` / `oauth2RefreshToken` in hops, console, runner saved bodies and messages); `SendSecrets` includes the stored token, so the example scan finds an echoed token (`{{oauth2AccessToken}}` when masked). History stores the request as written (no token). Response bodies in history are stored as received, so an API that echoes the token puts it in history like any echoed secret (same rule as secret variables; the e2e scan uses a non-echoing endpoint for the database check). |
| Code generation | Without "Reveal secrets" the token is the placeholder `{{oauth2AccessToken}}` (header or query row, listed in `Masked`); with reveal (and resolved variables) the stored token is written in. No refresh happens for code. Copy as cURL never reveals. cURL import of `--oauth2-bearer` was already bearer auth. |
| Duplicates and deletes | Duplicating a request copies no token (a copy is a new client session; the user gets one when needed). Deleting a request, folder or collection deletes the tokens of everything deleted (subtree ids matched against the secret index). `PruneSecrets` keeps a token while its owner exists and still uses OAuth 2.0 auth; otherwise it is pruned on the next start. |
| UI | Auth type "OAuth 2.0" in request, folder and collection editors; fields per grant; callback "Random port"/"Fixed URL" with help and a copy button; token panel (status with relative expiry, scope, Get new access token with waiting state, Cancel and "Copy the link", Refresh, Reveal/Hide, Clear, Unlock when locked); an inherited OAuth 2.0 shows the owner's status read-only. Palette "Get new OAuth 2.0 token". `stores/oauth2.ts` holds status, flows and errors per owner, never token values. |
| Event | `oauth2:flow` (`OAuth2FlowEvent{flowId, stage: "browser", authUrl}`) when the authorization URL was opened, so the UI can show "Waiting…" and offer the link when no browser opened. |

### Decisions made in M7

| Topic | Decision |
|---|---|
| Model | `Auth.Digest`, `AWSV4`, `JWT`, `Hawk`, `NTLM` blocks (omitempty), types `digest`, `awsv4`, `jwt`, `hawk`, `ntlm`; `Auth.IsV3` counts the types and any block, so writing one upgrades the manifest. Blocks are kept when the type changes (as all auth fields are). |
| Where auth applies | JWT, AWS SigV4 and Hawk are signed last in `httpexec.Build` (`auth.Apply`), after every header is final; the body is read into memory for payload hashes (form-data too: its boundary is random). Digest and NTLM are handshakes in `httpexec.send`. A user `Authorization` header always wins. |
| Digest | Sent without auth; a 401 with a supported challenge (strongest of SHA-256, SHA-256-sess, MD5, MD5-sess, or the preferred one) is answered once by rebuilding the request (so any body replays). Not retried after a redirect. qop auth by default, auth-int when chosen and offered (or the only one offered); userhash and `username*` when needed; nc 1 and a fresh cnonce per send. A 401 without a usable challenge is the response. Tested with the RFC 7616/2617 vectors. |
| AWS SigV4 | Own code (`core/auth/awsv4`). Signed headers: host, Content-Type, Content-MD5, every `X-Amz-*` (not User-Agent, which proxies may change). Path normalized and double-encoded except for S3; `X-Amz-Content-Sha256` for S3 and UNSIGNED-PAYLOAD. Vectors: 9 cases from the AWS test suite (Apache-2.0; only expected signatures are reproduced) plus the IAM documentation example. |
| JWT | `core/jwtx` created with signing and verification (secret, PEM key/cert, JWK, JWK set), API as PLAN-TOOLS M3 needs (noted there). Header extra fields and payload are JSON objects, resolved like a raw JSON body; fields are written in name order; typ defaults to JWT; iat, exp (= now + lifetime) and jti are added unless the payload sets them. PEM keys pasted into the single-line field are repaired (`auth.NormalizePEM`). The generated token shows unmasked in the Debug tab (it's what users debug; it's derived and short-lived; the key never leaves). |
| Hawk | Own code from the spec; README vectors. Timestamp and nonce per send; payload hash optional. The response's `Server-Authorization` isn't checked (Tier 4). |
| NTLM | Kept (not dropped): `github.com/Azure/go-ntlmssp` v0.1.1 (MIT, April 2026), NTLMv2 only. The first request carries NEGOTIATE (no anonymous round trip); the handshake uses a per-send transport (HTTP/1.1, `MaxConnsPerHost` 1, closed after the send), never the shared cache. Domain is prefixed (`DOMAIN\user`) unless the username has one. |
| Errors | Signing failures and unanswerable challenges are `KindAuth`; the message ends with "Check the Auth tab." |
| Masking | `pipeline.AuthSecrets`: the resolved Digest/NTLM passwords, AWS secret key and session token, JWT key and Hawk key join `SendSecrets` as `[secret:digestPassword]` etc. (secret variables keep their own names). Example sidecars are scanned in the new fields too, and copies of all auth blocks are taken before masking. |
| Code and cURL | `auth.MaterializeWith(req, keep)` with a per-language keep set (see Decisions: "Codegen and cURL for new auth"). Computed SigV4/JWT/Hawk need resolved values: with a `{{reference}}` left (secrets not revealed) the auth is left out with a warning. cURL import: `--digest`, `--ntlm` (`DOMAIN\user`), `--aws-sigv4 aws:amz:<region>:<service>` with `-u` (an `X-Amz-Security-Token` header becomes the session token). |
| UI | Labels: Digest auth, AWS Signature v4, JWT bearer, Hawk, NTLM. Their fields are one lazy chunk (`OtherAuthFields`, ~8 kB). JWT payload and header fields are `CodeEditor`s (JSON, `{{vars}}`). |

## Workspace on disk (v3)

```
my-api-workspace/
├── pakpos.yaml                  # manifest: id, name, version: 3
├── collections/
│   └── users-api/
│       ├── _collection.yaml     # id, name, seq, auth, headers, variables, scripts
│       ├── auth/
│       │   ├── _folder.yaml     # id, name, seq, auth, headers, scripts
│       │   └── login.yaml       # … + scripts, settings, auth.oauth2/digest/awsv4/jwt/hawk/ntlm
│       └── get-user.yaml
└── environments/                # unchanged from v2
```

Every v3 field is additive and omitted when empty. A v2 workspace opens unchanged; its manifest becomes v3 only on the first v3-only write. Builds that know only v2 refuse a v3 workspace instead of dropping its fields. App-local data (cookies, run summaries, the secret key index) stays in SQLite, never in the workspace.

## Milestone 1 — Carry-overs and groundwork

1. Manifest v3 and the newer-version guard.
2. Overridden inherited headers: the preview returns them; struck-through rows.
3. Rename from collection and folder settings tabs.
4. Removed draft rows: lower-scope values from `VisibleVariables`.
5. Variable support in the bulk "Edit as text" view.
6. `scripts/screenshot.mjs` (Playwright, from the AGENTS "Gotchas" approach).
7. Orphan pruning and the secret key index.
8. The first `release.yml` pre-release run and the smoke test on macOS and Windows.
9. `git rm --cached frontend/tsconfig.tsbuildinfo`, flagged for the user to run (agents never commit).
10. Done when: items 1–7 are in with tests (Go table tests, RTL tests, an e2e prune flow), lint and coverage gates pass, and items 8–9 are done or handed to the user.

## Milestone 2 — Network

1. Per-request settings (timeout, redirects, TLS verify) and the "Settings" request tab.
2. Proxy (none, system, custom with bypass list; password in the secret store).
3. CA bundle and client certificates; transport cache keyed by TLS/proxy config.
4. Persistent cookie jar (`0005_cookies.sql`) and the cookie manager.
5. Settings dialog "Network" section.
6. Done when: e2e covers a proxy via `httptest`, mTLS via `httptest.NewUnstartedServer` + `ClientAuth`, and cookies across a restart.

## Milestone 3 — Scripting core (Go)

1. `core/script` with the sandbox and the `pm` API; embedded expect library.
2. `pipeline.Overlay`; pipeline hooks in `RequestService.Send`.
3. `SendResult.Tests` and `SendResult.Console`, masked; the `script:console` event.
4. Done when: table-driven tests cover timeout, infinite loop, prototype tampering, `require` absent and masking, and an e2e login → `pm.environment.set("token")` → the next send uses it.

## Milestone 4 — Scripting UI

1. "Scripts" tab (Pre-request / Tests) in request, folder and collection editors: lazy JS editor with `pm` completions and snippets.
2. "Tests" tab in the response pane with a pass/fail count.
3. Console drawer (logs and script errors, per send, clearable).
4. Overlay badges with Reset / Persist in the environment and collection variable tables; palette actions.
5. Done when: the scripts UI is lazy (no startup growth), tested with RTL, and checked in light and dark screenshots.

## Milestone 5 — Collection runner

1. `internal/runner` and the runner doc tab (config, live list, summary).
2. Data file parsing (CSV, JSON); `setNextRequest` / `skipRequest`; stop and cancel.
3. JSON/HTML export; `0006_runs.sql`.
4. Entry points: tree context menu "Run…" and the palette.
5. Done when: an e2e runs a 3-request chain with data rows, and exports hold no secret values.

## Milestone 6 — OAuth 2.0

1. Model, `core/auth/oauth2` and the loopback server.
2. Token storage and refresh in the pipeline; Auth tab UI.
3. Codegen and cURL mapping.
4. Done when: tests with a fake authorization server (`httptest`) cover all four grants and refresh.

## Milestone 7 — Other auth

1. Digest, AWS SigV4, JWT generator, Hawk; NTLM last (droppable).
2. Done when: each has test vectors, Auth tab UI and a codegen/cURL mapping.

## Milestone 8 — Polish and release

1. AGENTS.md and ARCHITECTURE.md updates; SMOKE-TEST.md Tier 3 sections.
2. Bundle check (goja is Go-side, so frontend growth comes only from the scripts UI and the runner, both lazy).
3. Done when: the Tier 3 Definition of Done is met.

## Order and dependencies

```
M1 ──────────────────────────────┐
M2 ──┬─ M6 ─ M7 ─────────────────┼─ M8
M3 ─ M4 ─ M5 ────────────────────┘
```

- M1, M2 and M3 can start in parallel.
- M6 needs M2, because the token endpoint uses the proxy and TLS settings.
- M5 needs M3 and M4: the runner reuses the tests and console UI.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Runaway scripts (goja has no memory cap) | Interrupt timeout, stack cap, output caps |
| Secrets leaking through console output or reports | Masking, plus an e2e scan of exports and SQLite |
| OAuth loopback port conflicts | Random port by default; a fixed port is opt-in |
| Implicit flow fragment capture | Covered by the loopback page |
| NTLM connection affinity | Dedicated transport; feature can be dropped |
| Proxy env differences per OS | Covered by the smoke test |
| Overlay confusion (file value vs script value) | Badges and Reset |
| Manifest v3 read by older builds | Version guard |
| Cookie DB growth | Expired cookies are pruned on load |
| Pruning deletes a value still wanted | Only keys written before the app started; skipped while the workspace has load problems; only scopes and secret variables that are gone |

## Definition of Done (Tier 3)

- CI is green on 3 OSes.
- Coverage is at least 80% for Go and the frontend, and lint is clean.
- No secret value appears in workspace files, SQLite (including run reports, the cookie DB and the secret index), exports or the console. Checked by e2e scans.
- A v2 workspace opens unchanged and upgrades to v3 only on a v3 write.
- The smoke test has passed on Linux, macOS and Windows.

---

## Progress

- **M1 — Carry-overs and groundwork: items 1–7 done; 8–9 left to the user.**
  - **Manifest v3** (`fsstore/workspace.go`): `FormatVersion = 3`, `VersionV2 = 2`, `upgradeManifestLocked(to)`; Tier 2 writes pass `VersionV2`. Tests (`TestManifestVersions`, `TestOpenErrors`): v1/v2/v3 open unchanged, a v2 write keeps v2 and never downgrades v3, a v3 write upgrades v1 and v2 (reopened from disk), version 4 and 99 are refused with a message that never reads like "not a pakpos workspace". Service: `MsgNewerWorkspace` (`TestWorkspaceServiceLifecycle`). Frontend: `stores/workspace.ts` `NEWER_VERSION` toast with "Check for updates" (`workspace.test.ts`).
  - **Overridden headers**: `core/inherit` `Result.Overridden` (table cases: request override, folder rows not listed twice, disabled rows, order), `pipeline.Preview.Overridden` (`TestPreview`), `normalizePreview`, `makePreview`, `Inherited.tsx` (`Inheritance.test.tsx` "strikes through inherited headers the request overrides").
  - **Rename from settings tabs**: `DocEditor.tsx` `RENAME_NOUNS`/`renameDocTarget`, pencil button + double click (`DocEditor.test.tsx`: collection via button, folder via double click with Escape, none for a deleted target).
  - **Removed draft rows**: `pipeline.Visible.Shadowed` + `shadowed()` (`TestShadowed`, `TestVisibleVariables`), `normalizeVisible`, `overlayDraft(…, shadowed)` and `useVariableScope` (`variables.test.ts`, `useVariableScope.test.tsx`).
  - **Bulk edit variables**: `HeadersSection.tsx` uses `<CodeEditor variables>` (`RequestPane.test.tsx`, `Variables.test.tsx` "marks references in the headers' text view").
  - **Secret index and pruning**: `0004_secret_index.sql`, `sqlite/secret_index.go` (`TestSecretIndex`, closed DB), `secrets.SplitKey`, `pipeline/secretindex.go` (`WithSecretIndex`, `indexedStore`, `PruneSecrets`; `TestSecretIndexFollowsBookkeeping`, failures logged, store errors, `TestPruneSecrets` incl. a hand-edited removal and adoption, locked store, one failing delete, workspace with problems), `service.Core.started`/`pruneSecrets` called from `WorkspaceService.activate` and `EnvService.Unlock`. e2e: `TestEndToEndPruneOrphanSecrets` (keychain: an unsaved row's value and a deleted environment's value left by a failing store survive the same session and are pruned on the next start; the live value stays; the database holds no value), `TestEndToEndPruneOnUnlock` (file store: nothing while locked, pruned on unlock), `TestPruneFailureDoesNotBlockOpen`.
  - **Screenshot helper**: `scripts/screenshot.mjs`; `playwright` 1.65.0 devDependency. Used for the M1 visual check (light and dark): struck-through overridden header, `{{vars}}` in the headers text view, the rename button and inline rename in collection settings.
  - Gates: `wails3 task lint` 0 issues; `wails3 task coverage`: Go 96.2% (inherit 100%, pipeline 97.7%, service 98.2%, fsstore 93.8%, sqlite 91.1%, secrets 94.1%), frontend 98.77% statements / 94.36% branches / 98.49% functions / 99.21% lines (776 tests, 1 opt-in bench skipped).

- **M2 — Network: items 1–6 done.**
  - **Per-request settings**: `model.RequestSettings` (`TestRequestSettingsYAML`), fsstore upgrade (`TestManifestVersions`: create/save upgrade v1, a request without settings keeps v2), `httpexec` options and `ValidateRequestSettings` (`TestRequestSettingsOverrideApp`), service validation (`TestRequestSettingsSaveAndSend`), cURL import/generate (`TestParse` cases, `TestGenerateRequestSettings`, sample goldens now carry `settings`), frontend `SettingsSection.tsx` + `requestSettings.ts` (`SettingsSection.test.tsx`, `RequestPane.test.tsx` "has a Settings tab…").
  - **Proxy, CA, client certificates, transport cache**: `httpexec/network.go` (`TestMatchHost`, `TestCheckHostPattern`, `TestParseProxyURL`, `TestCustomProxy` incl. bypass, unreachable proxy, 407, locked password; `TestCustomCA`, `TestClientCertificates` PEM/PKCS#12/wrong passphrase/no match; `TestVerifyTLSOverrideKeepsPools`, `TestTransportsDropStaleNetworks`), classification (`TestClassify` proxy and TLS alert cases), `settings` network fields (`TestNetworkValidation`, `TestNormalize`, `TestNetworkMapping`), `service/settings.go` (`TestSettingsNetworkFiles`, `TestNetworkSecrets`, `TestNetworkSecretStatusLocked`, `TestSendThroughLockedProxyPassword`). Test helpers: `internal/testnet` (CA, mTLS server, forwarding proxy).
  - **Cookies**: `core/cookies` (`jar_test.go`: matching, public suffix and IP hosts, expiry and persistence, store failures, manager edits, delete/clear), `0005_cookies.sql` + `sqlite/cookies.go` (`TestCookieStore`), `service/cookies.go` (`TestCookieService`, `TestCookiesFollowTheWorkspace`), frontend `stores/cookies.ts`, `features/cookies/` (`CookieManager.test.tsx`: grouping, filter, edit, add, validation, deletes, palette and response entry points).
  - **Settings dialog Network section**: `NetworkSection.tsx`, `settingsForm.ts` (`settingsForm.test.ts` network cases, `NetworkSection.test.tsx`: custom proxy + password order, errors, stored/locked status, cancelled unlock, password store failure, Go file error, PEM and PKCS#12 rows, remove row).
  - **e2e** (`service/e2e_network_test.go`): `TestEndToEndNetwork` (proxy with a secret-store password and bypass, custom CA, mTLS with PEM then PKCS#12 + passphrase, a saved request with `verifyTls: false` while the app verifies, the mTLS connection reused after the override send, no password in SQLite) and `TestEndToEndCookiesSurviveRestart` (persistent cookie survives a Core restart, the session cookie doesn't; per-workspace jars; manager edits persist; nothing in workspace files).
  - Docs: AGENTS.md (request settings, network, transport cache, cookies, stores, settings sections, testnet), ARCHITECTURE.md (§5 cookies and network settings, §5a app-level secrets, §6 per-send options, transports, proxy/TLS), SMOKE-TEST.md ("Tier 3: network").
  - New dependency: `software.sslmate.com/src/go-pkcs12` v0.7.4 (BSD-3-Clause, pure Go).
  - Gates: `wails3 task lint` 0 issues; `wails3 task coverage`: Go 96.2% (cookies 99.1%, httpexec 98.2%, settings 100%, sqlite 91.1%, testnet 88.1%), frontend 98.66% statements / 94.41% branches / 98.45% functions / 99.18% lines (834 tests, 1 opt-in bench skipped).

- **M3 — Scripting core (Go): items 1–4 done.**
  - **Model and file format**: `model.Scripts` (+ `MarshalYAML`, `TestScriptsYAML`), request/folder/collection fields, v3 upgrades and `InheritChain` levels (`fsstore/scripts_test.go`: block scalars, round trips, nil keeps, empty clears, v1/v2 upgrades, quoted fallback, write failures). cURL goldens now carry `scripts`.
  - **`internal/core/script`**: `script.go` (Run, sandbox, errors, console budget, host), `prelude.js` (pm, console, globals), `expect.js` (chai subset and `pm.response.to`). Tests (`script_test.go`): Postman snippets, 70+ assertion messages, passing chains, console formatting and caps (entries, bytes, shared budget, UTF-8 cut), variables and errors, request mutations and read-only tests, response, tests/skip/execution, sandbox (`require`, timers, `fetch`, `process`), fresh runtime after prototype tampering, timeout/infinite loop/recursion, cancel, syntax errors with position, unicode.
  - **Overlay and pipeline**: `pipeline/overlay.go` (Overlay, `applyOverlay`, `OverlayValues`/`ResetOverlay`/`PersistOverlay`), `pipeline/scripts.go` (`Send`, `ScriptOptions`, `ScriptReport`, `sendVars`, `ResponseBody`), `Scopes.Overlay`, `PreviewVariable.Overlay`. Tests: `scripts_test.go` (order, request changes reaching the wire, error and skip, test errors as failed tests, masking incl. a script-set secret, locked store, scopes/unset states, no scope, no workspace, replaceIn loop, response bodies), `overlay_test.go` (BuildScopes states, secret flag kept, reset, persist incl. secrets/unset/duplicates/failures).
  - **Service**: `RequestService.Send` runs the pipeline (`SendResult.tests/console/skipped`, `KindScript`), `Core` overlay per workspace, `EnvService.OverlayValues/ResetOverlay/PersistOverlay`, `script:console` event registered in `main.go`, `settings.ScriptTimeoutMs`.
  - **e2e** (`service/e2e_script_test.go`): `TestEndToEndScripts` (login test script → `pm.environment.set("token")` → next request sends it; env file unchanged; overlay listed and marked in VisibleVariables; PersistOverlay writes the file; a secret target goes to the store and never appears in SQLite, files, the result or console; console order collection → folder → request, also streamed as events; Reset; reopen clears), `TestEndToEndPreRequestScripts` (header + local variable reach the wire and hops, history keeps the request as written; script error stops the send with line:column; 1 s timeout; skipRequest; test-script error; no workspace), `TestEndToEndScriptSecretLocked`, `TestEndToEndCancelDuringScript`.
  - **Frontend (types only, UI is M4)**: bindings regenerated; `model.ts` (`Scripts`, `TestResult`, `ConsoleEntry`, `ScriptSource`, `OverlayValue`, `OverlayState`, `SendResult.tests/console/skipped`, `"script"` error kind with copy in `format.ts`, `scriptTimeoutMs`), `api.ts` (`overlayValues`, `resetOverlay`, `persistOverlay`, `onScriptConsole`, optional `scripts` on `saveCollection`/`saveFolder`), mocks; Settings → Requests "Script timeout" field (`settingsForm`, `SettingsDialog` tests).
  - New dependency: `github.com/dop251/goja` (MIT) with `dlclark/regexp2/v2` (MIT), `go-sourcemap/sourcemap` (BSD-2-Clause), `google/pprof` (Apache-2.0), `golang.org/x/text` (BSD-3-Clause).
  - Docs: AGENTS.md (stack, layout, Scripts conventions, frontend script results), ARCHITECTURE.md (§6 pipeline with scripts, §7 scripting, §9 events).
  - Gates: `wails3 task lint` 0 issues; `wails3 task coverage`: Go 96.3% (script 94.9%, pipeline 98.2%, service 97.5%, model 100%, fsstore 93.8%, settings 100%), frontend 98.66% statements / 94.51% branches / 98.46% functions / 99.18% lines (837 tests, 1 opt-in bench skipped). `GOOS=windows go vet ./internal/...` clean.

- **M4 — Scripting UI: items 1–5 done.**
  - **Scripts tab**: `features/scripts/` (`ScriptsSection.tsx`, `lazy.tsx`, `hasScripts.ts`, `pmApi.ts`, `snippets.ts`, `useInheritedScripts.ts`, `open.ts`), `CodeEditor` `completions` prop, `RequestPane` and `DocEditor` (collection/folder) sections, `DocDraft.scripts` + `scriptsChanged` (`stores/tabs.ts`, `docActions.ts`). Tests: `pmApi.test.ts` (paths, members per event, completions, snippets), `Scripts.test.tsx` (editing and dirty state, sub-tabs, help text, snippets incl. disabled reasons, inherited line and opening settings, collection/folder save with and without script edits, `levelsAbove`).
  - **Tests tab and outcomes**: `features/response/TestsView.tsx`, `tests.ts`, `ResponsePane` (skipped state, script error with "Open the … script"). Go: `SendResult.ScriptError` (`e2e_script_test.go` asserts source/line/column and the timeout's line 0). Tests: `Tests.test.tsx`.
  - **Console**: `stores/console.ts`, `features/console/` (`ConsolePanel`, lazy `ConsoleDrawer`, `consoleFilter.ts`, `useConsoleSync`), status bar toggle, Mod+J in `useShortcuts`, `sendTab` begin/finish. Tests: `console.test.ts` (grouping, reconcile, late events, cap, unread, status text), `Console.test.tsx` (drawer filters/search/copy/clear/close, status bar with unread count, Mod+J, live events), `actions.test.ts` (send → console + version bump).
  - **Overlay**: `features/scopes/useOverlayValues.ts`, `ScriptValues.tsx`, `scriptValueActions.ts`, `VariablesTable`; `overlayDraft`/`describeVar` (`lib/variables.ts`). Tests: `ScriptValues.test.tsx` (badges, virtual rows, reset, reset all, persist plain/new/unset/secret with unlock, failures), `variables.test.ts` (script value beats edited rows, "set by script" source).
  - **Palette**: "Open pre-request script", "Open tests", "Toggle console" (Mod+J), "Clear console", "Reset script values" (`features/scripts/overlay.ts`); `actions.test.ts`.
  - Fixtures: `makeScriptSource`, `makeTestResult`, `makeConsoleEntry`, `makeOverlayValue`; `apiMock` `send` returns a full result and `saveCollection`/`saveFolder` keep scripts like Go.
  - Visual check: `scripts/screenshot.mjs` with an M4 scenario in light and dark (Scripts tab with inherited line and help text, completions, snippets menu, Tests tab with the console open, overlay badges in an environment).
  - Bundle: `ScriptsSection` (~15 kB, with `pmApi`/snippets) and `ConsoleDrawer` (~6 kB) are separate lazy chunks; the startup bundle only gains the small wrappers, the Tests tab, the overlay notes and the console store.
  - Docs: AGENTS.md (scripts UI, Tests tab, console store/drawer, overlay UI, Mod+J, palette actions, fixtures), ARCHITECTURE.md §7–§8, SMOKE-TEST.md "Tier 3: scripting".
  - Gates: `wails3 task lint` 0 issues; `wails3 task coverage`: Go 96.3% (service 97.5%), frontend 98.65% statements / 94.55% branches / 98.45% functions / 99.14% lines (889 tests, 1 opt-in bench skipped).

- **M5 — Collection runner: items 1–5 done.**
  - **Pipeline**: `ScriptOptions.Local`, `Send.Local()`, `Overlay.Clone()`, `Session.Isolated()`, `Session.Workspace()` (`TestLocalCarriesAcrossSends`, `TestIsolatedSession`).
  - **`internal/runner`**: `runner.go` (Config, New, Run, order, sends, history/spill handling, saved responses), `summary.go` (`Summarize`), `data.go` (`LoadData`, `ParseCSV`, `ParseJSON`, `Preview`). Tests (`runner_test.go`, real `httptest` server + fsstore workspace): tree order, folder target and subset, iterations, data rows (`{{user}}`, `pm.iterationData`, `pm.info`), fresh local scope per iteration, setNextRequest by name and id, `null`, loop guard, unknown target, skip, stop on test failure and on request error, failures without stopping, variable error, masking (console, test names, saved body and headers), keep/private variable values, saved-body limits (binary, cut on a UTF-8 boundary, run limit), deleted environment, event order, delay via an injected sleeper, cancel between requests/during the delay/within a request/pre-request script/test script, history on/off, spilled bodies removed or handed to history, config errors; `data_test.go` (CSV/JSON cases and limits).
  - **Reports**: `runner/report` (`JSON`, `HTML`, `report.html.tmpl`), golden files `testdata/run.json` and `run.html` (`-update`), plus outcome texts, the failure cap note and no `<script>`/URLs in the page.
  - **Storage**: `0006_runs.sql`, `sqlite/runs.go` (`TestRuns`: prune to keep per workspace, list order, get/delete, defaults, duplicate id; `TestRunsClosed`).
  - **Service**: `service/runner.go` (`RunnerService`, `RunConfig`, `RunListItem`, `RunTotals`, `ActiveRun`, `EventRunnerProgress`/`RunnerProgressEvent`, `MsgRunActive`), `Core.recordHistory` (moved from `RequestService.record`), `main.go` registration and typed event. e2e (`e2e_runner_test.go`): `TestEndToEndRunner` (login → token via test script → `/me` with the token over 2 CSV rows; 6 requests, 4 passed tests; stored and listed with totals; masked console; saved login body masked; JSON and HTML exports; exports, workspace files and the database scanned for the API key and both tokens; a second run with history on and a subset; delete), `TestEndToEndRunnerCancel` (one run per workspace, cancel mid-request keeps the first result, stored as cancelled), `TestRunnerServiceErrors`, `TestRunnerDelayAndExportName`.
  - **Frontend**: `lib/runModel.ts` (types, normalizers, `testCounts`, `resultFailed`), `api.ts` (`startRun`, `cancelRun`, `listRuns`, `getRun`, `deleteRun`, `exportRun`, `pickDataFile`, `previewData`, `onRunnerProgress`) + `apiMock`, `stores/runner.ts`, `stores/tabs.ts` (`runner` doc kind, `RunnerSettings`, `openRunner`, `updateRunner`, restore), `stores/console.ts` (`addRunSend`, `context`), `features/runner/` (`RunnerView`, `RunnerConfig`, `RunResults`, `PastRuns`, `open.ts`, `lazy.tsx`, `format.ts`), entry points in `CollectionTree` (menu), `DocEditor` (button), palette (`run-collection`, `run-folder`, `open-run-history` actions and steps). Fixtures `makeRunResult`, `makeRunSummary`, `makeRunReport`, `makeRunListItem`, `makeDataPreview`. Tests: `runner.test.ts`, `runModel.test.ts`, `Runner.test.tsx` (config, data file preview and errors, folder target, empty collection, lazy load, live run with progress/rows/details/filter/cancel/summary/export/run again, stored run with saved bodies and errors, row cap, past runs open/delete/empty/error), `RunnerEntry.test.tsx` (order and config, tab lifecycle and restore, palette steps and history, console header), plus `Sidebar.test.tsx`, `DocEditor.test.tsx`, `TabsAndDialogs.test.tsx`, `LazyDialogs.test.tsx`.
  - Docs: AGENTS.md (layout, runner conventions, stores, runner UI, palette, lazy chunks, fixtures), ARCHITECTURE.md (§2, §3, §5 runs table, new §7a, §9 event), SMOKE-TEST.md ("Tier 3: collection runner").
  - No new dependencies.
  - Gates: `wails3 task lint` 0 issues; `wails3 task coverage`: Go 96.4% (runner 98.3%, runner/report 95.1%, service 97.6%, pipeline 98.2%, sqlite 91.4%), frontend 98.71% statements / 94.57% branches / 98.58% functions / 99.18% lines (920 tests, 1 opt-in bench skipped). `GOOS=windows go vet ./internal/...` clean.

- **M6 — OAuth 2.0: items 1–4 done.**
  - **Model**: `model.AuthOAuth2`, `model.OAuth2` and enums, `Auth.IsV3` (`TestAuthOAuth2YAML`); `vars.ResolveRequest` resolves the OAuth 2.0 fields (`TestResolveRequestOAuth2`); fsstore upgrades to v3 for OAuth 2.0 on requests, folders and collections (`TestManifestVersions`); `auth.TokenAuth`, `auth.Apply` refuses untranslated OAuth 2.0, `auth.Materialize` placeholder (`TestTokenAuth`, `TestMaterializeOAuth2`).
  - **`core/auth/oauth2`**: `oauth2.go` (Token, Error with hints, Validate, Fetch, Exchange, Refresh, ParseResponse for JSON and form bodies), `flow.go` (PKCE, state, AuthorizationURL, Authorize), `loopback.go` (ParseRedirect, Listen, callback page). `oauth2test` is a fake authorization server + resource + `Browse`. Tests: `oauth2_test.go` (validation, redirects, response parsing incl. errors, RFC 7636 vector, URL building, all four grants against the fake with PKCE verified server-side, basic vs body client auth, public client, fixed localhost port, deny, open failure, cancel, busy port, refresh incl. rotation and failure), `loopback_test.go` (single use, state mismatch, provider error, 404, method checks, implicit page and POST, timeout), `server_test.go`.
  - **Pipeline**: `pipeline/oauth2.go` (`OAuth2`, `AuthError`, `TokenOwner`, `LoadToken`/`SaveToken`/`ClearToken`, `ResolveOAuth2`, `Token`, `Send.Authorize`, `NewToken`, `RefreshToken`, `HasOwner`, token masks in `SendSecrets`, `PrepareCode` placeholder/reveal, pruning, subtree deletes). Tests (`oauth2_test.go`): fetch and reuse, concurrent sends refresh once, refresh failure, auto refresh off, missing token own/inherited, drafts, no workspace, locked and failing stores, fetch failure, store without a master password, code options, owners, pruning, folder/request/collection deletes with and without the index.
  - **Service**: `AuthService` (`service/auth.go`), `Core.oauth`, `RequestService.Send` and the runner call `Authorize` (`KindAuth`), `RequestService.Delete`/`WorkspaceService.DeleteFolder` through the session, `oauth2:flow` registered in `main.go`. e2e (`e2e_oauth2_test.go`): client credentials inherited from a collection (auto-fetch, reuse, hops masked, status, reveal, codegen placeholder/reveal, example scan of an echoed token, runner report masking, clear, delete), authorization code + PKCE through the loopback (no flow from a send, event, refresh within 30 s on send, Refresh button, refresh failure as `auth` error in history, auto refresh off, duplicate/delete), implicit on a folder with query placement, password grant with body client auth and pruning on restart, service errors (owners, settings, unresolved, deny, open failure, cancel, timeout, locked store, no workspace). Tokens and the client secret are scanned for in the workspace files, SQLite and runner exports.
  - **Frontend**: `model.ts` (`OAuth2`, `OAuth2Status`, normalizers, `"auth"` error kind), `api.ts` + `apiMock.ts`, `stores/oauth2.ts`, `features/request/` (`OAuth2Fields.tsx`, `OAuth2Token.tsx`, `oauth2.ts`, `authFields.tsx`, `AuthEditor`/`AuthSection`/`Inherited`), `DocEditor` token owner, palette `get-oauth2-token`, `format.ts` copy, fixture `makeOAuth2Status`. Tests: `OAuth2.test.tsx` (type select, fields per grant, PKCE/client auth/placement/refresh, callback help/copy/validation, move-to-secret, text fields, token panel flow with waiting/cancel/copy/error/success, refresh/reveal/clear, errors, unlock, not-ready store, inherited read-only), `oauth2.test.ts`, `actions.test.ts`, `model.test.ts`, `format.test.ts`.
  - Docs: AGENTS.md, ARCHITECTURE.md (§3, §5a, §6, §9), SMOKE-TEST.md ("Tier 3: OAuth 2.0").
  - No new dependencies.

- **M7 — Other auth: items 1–2 done (NTLM kept).**
  - **Model and resolution**: `model.Digest/AWSV4/JWT/Hawk/NTLM`, `Auth.IsV3` (`TestOtherAuthYAML`), `vars.ResolveRequest` (`TestResolveRequestOtherAuth`, JWT JSON escaping).
  - **Core**: `core/auth/digest` (98%), `core/auth/awsv4` (99%), `core/auth/hawk` (100%), `core/jwtx` (96.8%: every algorithm verified with the standard library, jwt.io token, key kinds, errors), `core/auth/signed.go` + `materialize.go` (97.6%).
  - **httpexec**: `handshake.go` (`send`, Digest retry, NTLM, `dedicated` transports); `auth_test.go` against the `testnet` servers (Digest per algorithm/qop/userhash/file body, NTLM incl. 8 concurrent sends and connection reuse, SigV4 incl. form data, Hawk, JWT).
  - **testnet**: `auth.go` verifying servers (Digest, NTLMv2 with per-connection challenges, SigV4, Hawk, JWT).
  - **cURL/codegen**: `curl` import/export (`otherauth_test.go`), codegen goldens `digest`, `ntlm`, `aws_sigv4` in all languages.
  - **Pipeline/service**: `AuthSecrets`, example fields, `copyAuth`; e2e `e2e_auth_test.go` (`TestEndToEndOtherAuth`: every type inherited from a collection with secret variables, hops/code/files/SQLite scanned, a literal session token masked, kind `auth`, manifest v3).
  - **Frontend**: `model.ts` types and normalizers, `auth.ts`, `AuthEditor`, `OtherAuthFields.tsx` (lazy), `summary.ts`, `autoHeaders.ts`. Tests: `OtherAuth.test.tsx`, `summary.test.ts`, `autoHeaders.test.ts`.
  - New dependency: `github.com/Azure/go-ntlmssp` v0.1.1 (MIT, pure Go).
  - Gates: `wails3 task lint` 0 issues; `wails3 task coverage`: Go 96.2%, frontend 98.71% statements / 94.72% branches / 98.57% functions / 99.17% lines (962 tests). `GOOS=windows go vet ./internal/...` clean; `go test -race` on core, testnet and pipeline clean.

- **M8 — Polish and release: done, except what needs real machines (see below).**
  - Carry-overs finished: "Open the Auth tab" on `auth` send errors (`ResponsePane`, `Tests.test.tsx`); the inactive-auth-block question decided (kept, see M7 decisions); the status label now always shows the code (`statusName` in the response meta, console headers and runner rows: Go sends the bare reason phrase, so the meta showed "OK" alone); JWT editor labels aligned with their editors; `frontend/tsconfig.tsbuildinfo` is no longer tracked (checked with `git ls-files`).
  - Visual check (light and dark, `scripts/screenshot.mjs` scenario + Playwright on the Go pages): request Settings tab, Network settings, cookie manager, Scripts tab, Tests tab with the console, runner tab, OAuth 2.0 and all M7 auth editors, the HTML run report and the OAuth callback page (success and error). Problems found and fixed: the two above. Left (cosmetic): the cookie manager's and the HTML report's per-group tables size their columns independently, so columns don't line up between domains/iterations.
  - Bundle (vite build): startup JS = `index` 1,094.7 kB + shared chunks loaded at start (button 66.2, errors 77.3, dist 33.5, model 25.3, small ones 2.7) ≈ **1,300 kB (≈395 kB gzip)**, vs 1,184 kB (367.8 kB gzip) at the end of Tier 2: +116 kB for all of Tier 3 (request Settings tab, OAuth 2.0 editor and token panel, Tests tab, overlay notes, console store, runner/console wrappers). Lazy: RunnerView 22.9 kB, ScriptsSection 14.8 kB, CookieManagerDialog 10.4 kB, OtherAuthFields 7.8 kB, ConsoleDrawer 5.7 kB, SettingsDialog 30.6 kB (with Network).
  - Docs: AGENTS.md (stack with licenses, layout, other-auth conventions), ARCHITECTURE.md (layout diagram, directories, §4 v3 writes, §6 pipeline and other auth, §8 lazy chunks), ROADMAP.md (Tier 3 done in code; Tier 4 additions), SMOKE-TEST.md ("Tier 3: other auth"), PLAN-TOOLS.md (jwtx exists).

### Carried over from M7

- **Hawk response verification** (`Server-Authorization`) and **NTLMv1/Kerberos (Negotiate)**: not done (Tier 4).
- **Large bodies with SigV4/Hawk/auth-int** are read into memory to hash them; S3 users can choose UNSIGNED-PAYLOAD.
- **NTLM sends the body twice** (with NEGOTIATE and AUTHENTICATE); fine for API calls, wasteful for uploads.
- **Digest after a redirect** isn't answered (the 401 is returned).
- **Smoke test** "Tier 3: other auth" against real servers on Linux, macOS and Windows.

### Carried over from M6

- **Visual check** of the OAuth 2.0 auth editor, the token panel and the callback page in light and dark with `scripts/screenshot.mjs` wasn't run (needs an `AuthService` scenario).
- **Smoke test** "Tier 3: OAuth 2.0" against real providers (Auth0/Keycloak/Google) on Linux, macOS and Windows, including the browser opening and `localhost` resolving to `::1`.
- ~~**No "Open the Auth tab" button**~~: done in M8.
- **Token endpoint exchanges aren't in the Debug tab** (separate requests): left in M8, moved to Tier 4. The recorder starts after `Authorize`, and the Debug tab presents hops as one request and its redirects, so this needs its own section, not a small change.
- **Echoed tokens in history bodies**: like secret variables, a response body that echoes the token is stored as received.
- **No device code grant, no client assertion (private_key_jwt), no OpenID discovery** (`.well-known`), no token revocation call on Clear.
- **Scripts can't read the token** (`pm.request.auth` isn't implemented; M3 carry-over).
- **Switching away from OAuth 2.0 keeps the `oauth2` block** in the file (and the v3 manifest), like other auth fields are kept. Decided in M8: keep it (same rule for every auth block; dropping on save would lose settings when users switch types to compare).

### Carried over from M5

- **Visual check** of the runner tab (config, live run, summary, past runs) and the HTML report in light and dark with `scripts/screenshot.mjs` wasn't run in this milestone (needs a scenario with `RunnerService` handlers).
- **Large runs**: every result stays in memory (frontend store and Go report) and in `run_json`; 10000 iterations × many requests can make a big row. A cap on stored results (keeping the summary exact) or paging could come with the CLI.
- **Live console for runner sends**: lines arrive per finished request, not streamed while a script runs (no `script:console` for runner sends).
- **Data values are not masked** (by decision); a data column holding a real password shows in console output and saved bodies.
- **Secret writes with "Keep variable values" off** still go to the secret store (no private secret store).
- **Inherited scripts in the preview** (M4 carry-over) were not needed by the runner: it runs scripts through `pipeline.Send` like a single send.
- **Smoke test** "Tier 3: collection runner" on Linux, macOS and Windows.

### Carried over from M4

- **History and script results**: a history entry has no tests, console or `scriptError` (never stored), so a script error opened from history has no "Open the script" button. Left in M8: it needs a history migration and storing script positions.
- **Hover docs** (left in M8: new feature work, completion info covers the one-line docs) for `pm` members (completion info only), and no `pm` completions on local variables holding API objects (`const res = pm.response; res.` offers nothing).
- **Inherited scripts** are read per level on each change; the runner (M5) may want them in the preview instead.
- **Console** isn't per tab and not exportable. ~~The runner (M5) needs its own grouping~~: done in M5 (`addRunSend`, "Run … · Iteration N" headers).
- **Settings tabs restored from before M4** show empty scripts until reloaded (saving won't clear the disk's scripts, see the decision).
- **Smoke test** "Tier 3: scripting" on Linux, macOS and Windows.

### Carried over from M3

- ~~**M4 needs**~~: done in M4 (Scripts tab, Tests tab, console drawer, overlay badges; `overlayDraft` keeps script values winning).
- **Postman compatibility gaps**: no `pm.visualizer` (`pm.sendRequest`, `pm.cookies` and async tests came later: PLAN-SCRIPT-NETWORK.md), `require` of bundled libraries (lodash, moment, CryptoJS…), the legacy `tests[...]`/`responseBody`/`postman.setEnvironmentVariable` globals, `pm.request.auth`, typed variable values.
- **Memory**: goja has no heap limit; a script allocating fast within the timeout can use a lot of memory.
- **Short secrets** (under 4 characters) aren't masked in script output (same rule as examples).

### Carried over from M2

- **OS proxy settings on macOS/Windows.** "System" reads only environment variables; reading the macOS/Windows system proxy (and PAC files) would need platform code or a dependency. Left open; custom mode covers it.
- **Codegen beyond cURL** doesn't express request settings (timeouts, `verify=False`, redirects). Could be added per generator with golden updates.
- **Encrypted PEM keys** aren't supported (only PKCS#12 has a passphrase).
- **Cookie domain normalisation** doesn't apply IDNA/punycode to hosts; a non-ASCII host's cookies are stored as typed.
- **Cookies of deleted workspaces** stay in SQLite (like history); a "forget workspace data" action could remove them.
- **Visual check** of the Settings tab, the Network section and the cookie manager in light and dark (`scripts/screenshot.mjs`) wasn't run in this milestone.
- **Smoke test** "Tier 3: network" on Linux, macOS and Windows (proxy env differences per OS, keychain for the network passwords).

### Carried over from M1

- **First `release.yml` run.** Push a pre-release tag (e.g. `v26.11.1-rc.1`) and check the Linux packages, the NSIS installer and the universal dmg (needs a tag push; agents never push).
- **Smoke test on macOS and Windows** (`docs/SMOKE-TEST.md`), including the keychain on each and the file store with a master password on Linux. Worth adding a pruning check: delete a secret variable by hand in a file, restart, and confirm the value is gone from the keychain.
- ~~**`git rm --cached frontend/tsconfig.tsbuildinfo`**~~: no longer tracked (checked in M8).
- **The `codegen-syntax` CI job** (Tier 2 M8) still needs its first run on a push.
- **Pruning other workspaces.** Pruning covers the workspace being opened; values of a workspace folder deleted from disk stay until that workspace is opened again (never, then). A "prune every known workspace" pass would need the index to remember paths; left open.
- **Form-data file/type cells** still have no variable support (the M5 bulk-edit carry-over named them too); they are not text fields and stay as they are unless asked (left again in M8).

## Definition of Done — what's left

Everything in code is done and gated (lint, coverage ≥ 80%, Windows vet, race on the new packages, `wails3 build`). What needs the user or real machines:

- [ ] Push a pre-release tag (e.g. `v26.11.1-rc.1`) so `release.yml` runs for the first time; check the Linux packages, the NSIS installer and the universal dmg. The `codegen-syntax` CI job also gets its first run on that push.
- [ ] CI green on Linux, macOS and Windows for this branch (agents never push).
- [ ] Smoke test (`docs/SMOKE-TEST.md`, all "Tier 3" sections incl. "other auth") on Linux, macOS and Windows: keychain on each, the file store with a master password on Linux, OS proxy env differences, OAuth 2.0 with a real provider (browser opening, `localhost` → `::1`), NTLM against a Windows server.
- [ ] Code signing (Windows and macOS), only if the signing secrets become available.
- [x] `frontend/tsconfig.tsbuildinfo` untracked (nothing to do).
