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
