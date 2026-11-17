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
| OAuth 2.0 | `golang.org/x/oauth2` (BSD). Grant types: Authorization Code with PKCE (S256), Client Credentials, Password, and Implicit. The browser flows use a loopback redirect on `127.0.0.1:<random or configured port>` opened through `AppControl.OpenURL`. Implicit uses a small page that posts the fragment back. Tokens are stored in the secret store under `pakpos/<ws>/<authScopeId>/oauth2`. A token is refreshed before a send when it expires within 30 s and has a refresh token. UI: Get new token, token details (expiry, scopes), Clear. The token endpoint goes through the app proxy and TLS settings. |
| Other auth | Digest (MD5, SHA-256, `qop=auth`; retries once on a 401 challenge, and both hops appear in Debug). AWS SigV4 (own implementation tested against the AWS sigv4 test suite vectors; no AWS SDK dependency). JWT generator (signs with `core/jwtx`; if PLAN-TOOLS hasn't landed, M7 creates the signing half). Hawk (own implementation from the spec). NTLM (`Azure/go-ntlmssp`, MIT, needs a dedicated keep-alive connection per handshake; **droppable**). |
| Codegen and cURL for new auth | OAuth2 → bearer with `{{…}}` or the masked token. Digest → `curl --digest` plus library helpers. SigV4 → `curl --aws-sigv4`; other languages get the computed headers with a "valid for 5 minutes" warning. JWT, Hawk → computed header with a warning. NTLM → `curl --ntlm` and a warning elsewhere. cURL import maps `--digest`, `--aws-sigv4`, `--ntlm` and `--oauth2-bearer`. |
| Orphan pruning | Migration `0004_secret_index.sql` (M1; the draft said 0006): an index of the secret **keys** written per workspace (names only, never values), because keychains can't list keys. On unlock (file store) or workspace open (keychain), keys whose scope or variable no longer exists are deleted. This also covers values for unsaved secret rows. See the M1 decisions below for the details. |
| File format | Manifest `version: 3`. It upgrades on the first v3-only write (scripts, new auth types, request settings). `fsstore.Open` refuses a manifest version newer than it knows, with a clear "made with a newer Pakpos" message, so an older build doesn't drop fields on save. |
| New dependencies | goja (MIT), golang.org/x/oauth2 (BSD), Azure/go-ntlmssp (MIT, only if NTLM stays). All are pure Go. Dev only: `playwright` (Apache-2.0, frontend devDependency, for `scripts/screenshot.mjs`). |

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

### Carried over from M1

- **First `release.yml` run.** Push a pre-release tag (e.g. `v26.11.1-rc.1`) and check the Linux packages, the NSIS installer and the universal dmg (needs a tag push; agents never push).
- **Smoke test on macOS and Windows** (`docs/SMOKE-TEST.md`), including the keychain on each and the file store with a master password on Linux. Worth adding a pruning check: delete a secret variable by hand in a file, restart, and confirm the value is gone from the keychain.
- **`git rm --cached frontend/tsconfig.tsbuildinfo`**: still to run once by the user (the file is already in `.gitignore`).
- **The `codegen-syntax` CI job** (Tier 2 M8) still needs its first run on a push.
- **Pruning other workspaces.** Pruning covers the workspace being opened; values of a workspace folder deleted from disk stay until that workspace is opened again (never, then). A "prune every known workspace" pass would need the index to remember paths; left open.
- **Form-data file/type cells** still have no variable support (the M5 bulk-edit carry-over named them too); they are not text fields and stay as they are unless asked.
