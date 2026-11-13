# Pakpos — Tier 1 (MVP) Plan

Reference: [ARCHITECTURE.md](./ARCHITECTURE.md)

Toolchain verified: Go 1.26.3, Wails v3.0.0, Node 24 / npm.

## Scope

**In:**
- Request builder: methods, URL, query/path params, headers, body (none, raw, form-data, urlencoded, binary)
- Send/cancel
- Response viewer
- Auth: none, basic, bearer, API key
- Save requests
- History
- Workspace open
- Flat collections, needed so requests can be saved anywhere

**Out (Tier 2+):**
- Nested folders
- Inherited auth/headers
- Environments and variables
- Scripting
- cURL import
- Code generation
- Keychain secrets: no secret variables exist yet, so the keychain wrapper waits until Tier 2

The models are still designed with the Tier 2 fields in mind (e.g. `auth.type: inherit`, `seq`), so Tier 2 needs no file format migration.

---

## Milestone 0 — Project scaffold

1. Run `wails3 init` with the React + TS template and restructure it to the layout in ARCHITECTURE §3.
2. Set up the frontend:
   - Tailwind v4
   - shadcn/ui init with these components: button, input, tabs, select, dropdown-menu, dialog, tooltip, table, badge, scroll-area, sonner, resizable
   - lucide-react, Zustand
3. Set up tooling:
   - `golangci-lint`, ESLint + Prettier, Vitest with coverage thresholds of 80%
   - A `Taskfile.yml` with targets `dev`, `build`, `test`, `test:go`, `test:fe`, `lint`, `coverage`
4. Build the app shell:
   - Sidebar, tab bar, and request/response split panes
   - Light/dark/system theme toggle

**Done when:** `wails3 dev` opens a themed empty shell on Linux, and `task test` passes with the coverage gate active.

## Milestone 1 — Core model and HTTP execution (Go, no UI)

| Package | Work |
|---|---|
| `core/model` | `Request`, `KeyValue{Key,Value,Enabled}`, `Body` (type + raw/lang, form fields incl. file paths, urlencoded, binary path), `Auth`, `Response` DTO (status, headers, cookies, body, size, timings) |
| `core/urlx` | Two-way sync between URL query and params table. Path params: `:id` detection and substitution. Tolerates partial or invalid URLs while typing. |
| `core/auth` | Basic, Bearer, and API key (header or query) applied to `*http.Request` |
| `core/httpexec` | Build the request (multipart streaming for files, content-type defaults per body type). Execute with `httptrace` timings. Cancel by request ID through a context registry. Cap the body (store the full body to a temp file if > 10 MB). Detect content type for the viewer. Settings: timeout, follow redirects (max count), TLS verify toggle. |

**Tests:**
- Table-driven tests for URL/param sync edge cases
- `httptest.Server` tests for every method, body type, and auth type, plus cancel, timeout, redirects, and a large body

**Done when:** core coverage ≥ 85%.

## Milestone 2 — Persistence

| Package | Work |
|---|---|
| `store/fsstore` | Open/create a workspace (`pakpos.yaml`). Collections are directories with `_collection.yaml`. CRUD for request YAML files with slugified filenames, ULID IDs, and `seq` ordering. Atomic writes (temp file + rename). `fsnotify` watcher that ignores self-writes. |
| `store/sqlite` | modernc driver with embedded migrations. Tables: `history`, `settings`, `recent_workspaces`. History stores a request snapshot and response metadata plus the body (inline if ≤ 1 MB, otherwise a file ref). Retention: last 500 entries by default. |

**Tests:**
- Temp-dir workspaces: round-trip, rename, delete, external edit triggers an event
- In-memory SQLite: migrations, retention pruning, list/search

## Milestone 3 — Wails services

| Service | Methods |
|---|---|
| `WorkspaceService` | `Open(path)`, `Create(path,name)`, `Recent()`, `Tree()`, `CreateCollection`, `RenameCollection`, `DeleteCollection` |
| `RequestService` | `Get`, `Save`, `SaveAs(collectionId)`, `Rename`, `Duplicate`, `Delete`, `Send(req) → Response`, `Cancel(sendId)`, `SaveResponseBody(sendId, path)` |
| `HistoryService` | `List(filter, page)`, `Get(id)`, `Delete(id)`, `Clear()` |
| `SettingsService` | `Get`, `Set` (theme, timeout, redirects, TLS verify, layout) |

Additional work:
- Native dialogs for open folder, pick a file for upload, and save response.
- Events: `workspace:changed`.
- Generate TS bindings.

**Tests:** service tests with fake stores (they are thin adapters, but still covered).

## Milestone 4 — Request builder UI

- Tabs: open/close/reorder, unsaved-changes dot, close-confirm dialog
- URL bar: method select (color-coded), CodeMirror single-line URL input, Send/Cancel button
- Sub-tabs:
  - **Params:** query table synced with the URL, plus path params
  - **Headers:** key-value table with enable toggles, bulk-edit mode, and auto-generated headers shown read-only
  - **Body:** type selector
    - Raw: CodeMirror with a language picker and a Beautify button
    - form-data: per-row text/file type with a file picker
    - urlencoded: key-value table
    - Binary: file picker
  - **Auth:** type selector and a form for each type
- Reusable `<KeyValueTable>`: auto-add an empty last row, delete rows, toggle rows, paste `key: value` lines
- Shortcuts: `Ctrl/Cmd+Enter` send, `Ctrl/Cmd+S` save, `Ctrl/Cmd+T` new tab, `Ctrl/Cmd+W` close

## Milestone 5 — Response viewer UI

- Status bar:
  - Status badge (colored by class)
  - Time, with a hover popover showing the DNS/connect/TLS/TTFB breakdown
  - Size
- Body tab:
  - **Pretty:** read-only CodeMirror with folding, syntax-highlighted JSON/XML/HTML
  - **Raw**
  - **Preview:** sandboxed iframe for HTML, `<img>` for images
- Search in the body (CodeMirror search panel), copy, and save to file
- Headers tab and Cookies tab (tables)
- States: empty, loading (with cancel), error (DNS, connection refused, TLS, timeout, with clear messages), truncated-body notice

## Milestone 6 — Sidebar: collections and history

- Collections tree (flat collection → requests):
  - Create, rename, duplicate, delete
  - Context menu
  - Method badges
  - Filter box
- History list grouped by day, with search. Clicking an entry opens it in a new tab with its response attached. Clear history.
- Workspace switcher: open folder, recent workspaces, create new

## Milestone 7 — Polish and release

- Settings dialog: theme, timeout, redirects, TLS verify, history retention
- Empty states and onboarding (no workspace → "Open or create workspace")
- Builds for Linux, macOS, and Windows (`wails3 package`), with a CI matrix running tests, lint, and coverage
- Manual smoke-test checklist on all three OSes

---

## Order and dependencies

```
M0 ─┬─ M1 ─┬─ M3 ─┬─ M4 ─┐
    └─ M2 ─┘      ├─ M5 ─┼─ M7
                  └─ M6 ─┘
```

M1 and M2 can be built in parallel, and so can M4, M5, and M6.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| WebKitGTK (Linux) rendering/perf differences | Test on Linux early (it is the dev machine); avoid bleeding-edge CSS |
| Huge responses freezing the webview | Cap the body sent to the UI; CodeMirror virtualizes rendering; full body only via save-to-file |
| Wails v3 API churn | Pin the version; keep Wails code confined to `main.go` and `internal/service` |
| File watcher echoing our own writes | Ignore events for paths written by the app within a short window |

## Definition of Done (Tier 1)

- Every Tier 1 feature works on Linux, macOS, and Windows builds
- Coverage ≥ 80% for Go and frontend; lint clean
- A workspace folder can be committed to git, cloned, and reopened with no loss

---

## Progress

- **M0 — done.**
- **M1 — done.** Core coverage is 97.8%.
  - A header or param the user enabled wins over the one auth would set.
  - When sending, the query table is the source of truth, not the typed URL.
  - Response body goes to the UI as `body` + `encoding` (`utf8` or `base64`), with a `kind` hint and `truncated`/`bodyPath` for bodies over 10 MB.

- **M2 — done.**
  - `store/fsstore`: YAML workspace with atomic writes and an fsnotify watcher.
  - `store/sqlite`: history, settings and recent workspaces, using embedded migrations.
- **M3 — done.**
  - Services: `WorkspaceService`, `RequestService`, `HistoryService`, `SettingsService`, all wired up in `main.go`.
  - Dialogs and events are behind interfaces (`service.Dialogs`, `service.Events`); the Wails adapters live in `wails_adapters.go`.
  - `Send` returns a `SendResult{response, error, historyId}`. Network failures come back in `error` (with a kind and a message), not as a rejected promise.

- **M4 — done.** Request builder UI.
  - Tabs live in `stores/tabs.ts`: drafts, dirty tracking against the saved version, a close prompt, drag to reorder, and per-tab send state and result. Open tabs are kept in localStorage.
  - Hooks ready for M6: `openSaved(request, collectionId)` and `openFromHistory(request, result)`.
  - URL bar: single-line CodeMirror. The URL ↔ params sync is a TS port of Go `urlx` (`lib/urlx.ts`).
  - Section editors: Params (query and path), Headers (table or text, plus the headers added when sending), Body (none/raw/form-data/urlencoded/binary, Beautify for JSON and XML), Auth (none/inherit/basic/bearer/API key, secret fields masked).
  - Save dialog: picks or creates a collection, and can open or create a workspace folder.
  - Shortcuts: Mod+Enter, Mod+S, Mod+T and Mod+W.
- **M5 — done.** Response viewer.
  - Status colored by class, time with a phase breakdown on hover, size.
  - Body: Pretty (formats JSON/XML up to 2 MB), Raw, and Preview (sandboxed HTML, images).
  - Search, copy and save to file. A notice for truncated bodies.
  - Headers and cookies tables.
  - Loading state with Cancel, and an error state with a title, the message and a hint for each error kind.

- **M6 — done.** Sidebar: workspace switcher, collections tree and history.
  - `stores/workspace.ts`: current workspace, tree, problems and recent list. On start it restores `Current()`, or reopens the most recent workspace.
  - Open tabs follow the workspace. External changes (`workspace:changed`) reload clean tabs, keep edits on dirty ones with a notice, and detach tabs whose file was deleted. Switching workspace closes clean tabs from the old one and detaches edited ones.
  - Switcher: recent workspaces (removable), Open folder…, Create workspace…, Close workspace. The status bar shows the workspace name.
  - Collections tree (`role="tree"`): expand state per workspace, filter by name/URL/method, right-click and "More" menus (new request, rename, duplicate, move to, delete with confirm), inline rename, drag and drop (dnd-kit) to reorder collections and move requests, keyboard support (arrows, Home/End, Enter, F2, Delete, Alt+↑/↓ to reorder). Files that couldn't be loaded are listed.
  - History: grouped by day, debounced search, Load more, open as a new tab with its stored response, delete one, clear all with confirm. Reloads after each recorded send.
  - Go: `RequestSummary` gained `url` so the tree filter can match URLs.

### Carried over from M1

- [x] Cookie jar kept between requests, one per workspace. Fixed in M3: it resets on workspace switch and is kept when settings change.
- [x] Truncated-body temp files are cleaned up. Fixed in M2/M3: history moves them into `<data>/bodies` and deletes them on delete, clear or prune. Leftover spills and orphaned body files are removed at startup.
- [ ] Optionally buffer small form-data bodies to send a Content-Length (some servers reject chunked uploads).
- [ ] Manual decompression covers gzip only; add deflate/brotli if needed.
- [ ] `TestExecuteDNS` depends on the system resolver; consider a custom dialer/resolver to make it hermetic.

### Carried over from M2/M3

- [ ] Root package `main` (`main.go`, `wails_adapters.go`) has no unit tests: the Wails dialog/event adapters are only exercised by running the app.
- [ ] Watcher edge case: an external write into a collection folder in the same instant the app renames that folder can be missed until the next change.
- [ ] Workspace switching does not cancel in-flight sends; they finish on the previous executor and are recorded against the newly open workspace.
- [ ] `HistoryService.Clear` clears all workspaces; add a per-workspace clear if the UI needs it (`sqlite.ClearHistory(workspaceID)` already supports it).

### Carried over from M4/M5

- [ ] `{{variable}}` highlighting and autocomplete in the URL and body editors (Tier 2, together with environments).
- [x] Saved tabs react to `workspace:changed`. Fixed in M6 (see `stores/workspace.ts` `syncTabs`).
- [ ] Code-split CodeMirror languages; the main bundle is ~1 MB minified (fine for a desktop app, but it slows the first paint).
- [ ] HTML pretty-printing: Pretty shows HTML highlighted as received, not reformatted.
- [ ] The Settings dialog (M7) is referenced by error hints (timeout, TLS, redirects) but doesn't exist yet.


### Carried over from M6

- [ ] Drag and drop is pointer-only; keyboard users reorder with Alt+↑/↓ and move between collections with "Move to". There's no keyboard drag mode.
- [ ] Keyboard reordering of requests stays within a collection (Alt+↑ at the top doesn't jump to the previous collection).
- [ ] History shows every workspace's entries; "Clear history" clears all (matches `HistoryService.Clear`). Add a per-workspace filter/clear if wanted.
- [ ] Tabs persisted before M6 have no `workspaceId`; they're adopted by the first workspace that contains their request id.
- [ ] Opening a folder that isn't a workspace from the switcher shows an error with a "Create workspace here" action, rather than creating one silently (the Save dialog still creates one, as its copy says).
