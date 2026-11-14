# Pakpos — Tier 2 (Core productivity) Plan

Reference: [ARCHITECTURE.md](./ARCHITECTURE.md), [ROADMAP.md](./ROADMAP.md)

## Scope

**In:**
- Nested folders inside collections, with drag and drop across levels
- Collection- and folder-level auth and headers that requests inherit
- Environments (Dev, Staging, Prod) with a quick switcher, plus global variables
- Variable scopes (global, collection, environment, local) and `{{variable}}` substitution
- Secret variables in the OS keychain, with an encrypted-file fallback
- Dynamic variables
- `{{variable}}` highlighting, hover preview and autocomplete in every editor
- cURL import (paste), Copy as cURL, code generation
- Command palette
- Saved response examples
- Tier 1 carry-overs: per-workspace history, deflate/brotli, first real CI run, code-split CodeMirror

**Out (Tier 3+):**
- Scripts. The `local` scope exists in the resolver but stays empty until scripts can set it.
- Collection runner, OAuth 2.0 and the other advanced auth types
- Postman, OpenAPI and HAR import
- Mock server (it will use the examples saved in this tier)

## Decisions

| Topic | Decision |
|---|---|
| Variable values | One value per variable, stored in the file. There is no initial/current split; anything private is a secret variable. |
| Scope precedence | Highest wins: local > environment > collection > global. There are no folder-level variables. |
| Globals | Stored in `environments/_globals.yaml` and committed with the workspace. |
| Selected environment | Per workspace, in SQLite app state. It is not committed. |
| Unresolved `{{x}}` | Sent as literal text. The editor marks it as unresolved, and the send result lists the unresolved names. |
| Nested references | `{{a}}` may contain `{{b}}`, resolved up to a depth of 10. A cycle is reported as an error. |
| Dynamic variables | `$guid`, `$randomUUID`, `$timestamp`, `$isoTimestamp`, `$randomInt`. Every occurrence gets a fresh value. |
| Auth inheritance | `inherit` walks request → folder(s) → collection. The first scope with a type other than `inherit` wins; if none has one, the result is `none`. New requests saved into a collection default to `inherit`. Existing files are not changed. |
| Header inheritance | Collection, then folders, then request. A request header with the same name (case-insensitive) replaces an inherited one. Disabled rows don't hide inherited ones. |
| Secrets | `secret: true` on a variable in any scope. The file stores the key only. The value lives in the OS keychain under `pakpos/<workspaceId>/<scopeId>/<key>`, using scope IDs rather than names so renames don't orphan values. |
| No keychain (e.g. Linux without Secret Service) | Encrypted-file fallback, `<data>/secrets.enc`: AES-256-GCM with a key derived by Argon2id from a **master password**. It is unlocked once per app session. A secret is never written in plain text. |
| Plain-text auth fields | Basic password, bearer token and API key value: a literal (non-`{{…}}`) value shows a hint with a one-click "Move to secret variable". |
| Examples | Sidecar file `<request-slug>.examples.yaml` next to the request. The request loader skips `*.examples.yaml`. |
| History | Stores the request as written (`{{vars}}` unresolved) plus the environment name, so secrets stay out of SQLite. The final response URL is stored as received; a secret sent in the query string will show up there (documented). |
| Codegen | Generated in Go (`core/codegen`, reusable by the CLI). Variables are resolved by default, with a toggle. Secrets stay as `{{name}}` unless the user reveals them. Java uses `java.net.http`; PHP uses the cURL extension. |
| Damaged secrets file | AES-GCM can't tell a modified file from a wrong password, so both report `ErrWrongPassword`; the unlock dialog says "Wrong password, or the secrets file is damaged." No extra check value. |
| Unset secrets shadow lower scopes | A secret variable with no usable value (not stored on this machine, no master password yet, or the file store locked) still wins over a same-name variable in a lower scope. The name stays unresolved (`secretsLocked` when it's because of the lock); the lower value is never sent. The preview shows the secret as the winner with `set: false`. |
| History retention is per workspace | The "Requests to keep" limit applies to each workspace's history; entries sent without a workspace are one more group. A send prunes only its own group; lowering the limit in settings prunes every group. |
| Duplicating an environment | Secret values are copied automatically to the new environment on this machine. |
| Tree UI | Folders start collapsed (collections expanded). "Move to" is a nested submenu; a searchable move action can come with the palette (M7). A folder-name match in the filter shows the folder and all its contents. |
| Renaming a secret variable | The stored value moves to the new key. The editor passes explicit rename pairs `{from, to}` with the save (it knows which row's key changed); Go reads every value first, writes the new keys, then saves the file, whose cleanup deletes the old keys. A locked store refuses the save (the UI unlocks first) so no value is lost. Renames without a pair (e.g. hand edits) still drop the value. |
| Making a secret plain | Immediate: Go writes the stored value to the file and deletes it from the store (`MakeVariablePlain`), so the value never reaches the UI. Other edits still wait for Save; the confirm says so. |
| Master password length | At least 8 characters for a new password (set or change), enforced in Go (`secrets.CheckNewPassword`, "Use a master password of at least 8 characters.") and in the dialogs. Unlock accepts any length. |
| Environment switcher | At the right end of the tab bar, visible on every tab; environments are managed in their own activity-rail view. |
| File format | Manifest `version: 2`. Every change is additive, so Tier 1 workspaces open without migration. A Tier 1 build would skip nested folders; that's acceptable because only our own builds exist. |

## Workspace on disk (v2)

```
my-api-workspace/
├── pakpos.yaml                  # version: 2
├── collections/
│   └── users-api/
│       ├── _collection.yaml     # auth, headers, variables
│       ├── auth/
│       │   ├── _folder.yaml     # id, name, seq, auth, headers
│       │   ├── login.yaml
│       │   └── login.examples.yaml
│       └── get-user.yaml
└── environments/
    ├── _globals.yaml            # id, variables
    ├── dev.yaml                 # id, name, seq, variables
    └── prod.yaml
```

Variable row: `{ key, value, enabled, secret }`. When `secret: true`, `value` is omitted.

---

## Milestone 1 — Core (pure Go, no UI)

1. `core/vars`:
   - Takes scopes as an ordered list and resolves `{{x}}` in a string, returning the unresolved names.
   - Supports nested references, cycle detection and dynamic variables. The clock and random source are injectable for tests.
   - `ResolveRequest(req, scopes)` covers the URL, path params, query, headers, body (raw, form-data text and file paths, urlencoded, binary path) and auth fields.
2. `core/inherit`: `Effective(chain, req)` returns the request with auth and headers merged, plus the list of inherited headers (with their source) for the UI.
3. `secrets`:
   - The `Store` interface: `Get`, `Set`, `Delete`, `Available`.
   - A `keyring` implementation (`zalando/go-keyring`, MIT) and a `filestore` implementation (Argon2id + AES-GCM, `golang.org/x/crypto`, BSD). `Lock`, `Unlock` and `SetPassword` exist only on the file store.
   - A fake for tests.
   - Selection at startup: probe the keychain and fall back to the file store.
4. `fsstore`:
   - Environments and globals: load, create, rename, delete and reorder environments, and save variables.
   - The watcher covers `environments/`.
   - The manifest moves to v2 and still reads v1.
5. Done when: table-driven tests cover precedence, nesting, cycles, unresolved names, every request field, inheritance edge cases, keychain/file-store round trips, a wrong master password and a corrupted file. Coverage is at least 80%.

## Milestone 2 — Nested folders

1. `fsstore`:
   - The tree becomes recursive (`Node{kind: collection|folder|request}`). `RequestSummary` gains `parentId`.
   - Folder create, rename, delete and reorder.
   - `MoveRequest(id, toParentId, index)` and `MoveFolder(id, toParentId, index)`. Moving a folder into its own subtree is rejected.
   - `GetFolder` and `SaveFolder` for `auth`/`headers`.
2. Watcher: recursive watches, adding new folders synchronously, and re-syncing after a rename (keep the Tier 1 behaviour).
3. Services and bindings for the above.
4. Frontend:
   - `treeModel.ts` handles recursive visible rows, filtering (a match shows its ancestors) and drop targets (before, after, inside).
   - `CollectionTree` gets folder rows and menus (new folder, new request, rename, delete, settings).
   - Drag and drop across levels, with keyboard support (Alt+↑/↓ within a parent, "Move to…" with a folder picker).
   - Tabs stay in step with folder rename, move and delete.
5. Done when: folders can be nested, moved and reordered by mouse, keyboard and menus; reopening from disk keeps the structure; external edits to nested folders show up.

## Milestone 3 — Send pipeline

1. `RequestService.Send` runs:
   1. Load the chain.
   2. Inherit.
   3. Build scopes: globals, collection, the selected environment, local (empty).
   4. Load secrets.
   5. Resolve.
   6. Apply auth.
   7. Build and execute.

   `SendResult` gains `unresolved []string`.
2. An unsaved draft that belongs to a collection or folder still inherits from it.
3. `EnvService`:
   - List, CRUD and select environments. Variables, including setting and clearing secrets.
   - `SecretsStatus` (keychain or file store, locked or unlocked), `Unlock` and `SetMasterPassword`.
   - A `ResolvePreview(requestId|draft)` for hover and the headers tab.
4. Selected environment per workspace: a new SQLite migration (`0002_workspace_state.sql` or similar).
5. History: store the request as written plus the environment name. Per-workspace filter and clear (carry-over); the store already supports it.
6. Extend `e2e_test.go`:
   - Inherited auth and headers.
   - An environment switch changing the target.
   - A secret from the fake store.
   - Unresolved names.
   - History stays free of secrets.
7. Done when: a request using `{{baseUrl}}` and an inherited bearer `{{token}}` (secret) sends correctly in two environments.

## Milestone 4 — Environments and settings UI

1. The environment switcher next to the URL bar: a "No environment" option, the list, and "Manage environments".
2. An environment editor that opens as a tab: a variables table (key, value, enabled, secret toggle), rename, duplicate and delete. A secret value is masked with a reveal control. "Not set on this machine" shows when the store lacks the value.
3. A globals editor (the same component).
4. A collection/folder settings tab with three sections:
   - Auth (including `inherit` for folders).
   - Headers.
   - Variables (collection only).
5. Request headers tab: an "Inherited" section (read-only, showing each header's source, with a click to open that settings tab), next to "Added when sending".
6. Auth tab: show the effective inherited auth when the request uses `inherit`. A hint on literal secret values with "Move to secret variable".
7. Master password flow: a set-password dialog on first secret use when no keychain is available; an unlock dialog when the store is locked. Status bar: environment name and a lock indicator.
8. Done when: everything above works in light and dark themes, is keyboard reachable, and has tests.

## Milestone 5 — Variable UX in editors

1. A CodeMirror extension, `{{var}}`:
   - Highlighting (resolved vs unresolved vs dynamic, using `--syntax-*` tokens).
   - A hover tooltip (value, scope, masked if secret).
   - Autocomplete after `{{` (names with their scope, and dynamic variables).
2. Applied to the URL bar, the body editor, and **every table value cell**. Cells become single-line `<CodeEditor>` instances: create the view lazily on focus and render static highlighted text otherwise, so large tables stay fast.
3. The editor gets resolution data from a `vars` store, refreshed on environment switch and on edits to variables.
4. Done when: highlighting, hover and autocomplete work in all of these places; a 200-row headers table stays responsive (measured).

## Milestone 6 — cURL and code generation

1. `core/curl`:
   - Parse: shell-word tokenizer (quotes, `\` line continuations, `$'…'`); `-X -H -d --data --data-raw --data-binary --data-urlencode -F -u -G -b -k -L --compressed --url`.
   - Unknown flags are listed as warnings.
   - Generate the cURL command for a request.
2. `core/codegen`: cURL, JavaScript (fetch, axios), Python (requests), Go (net/http), Java (java.net.http), PHP (cURL). Golden-file tests.
3. UI:
   - Pasting text that starts with `curl ` into the URL bar offers to replace the request (with undo).
   - "Import cURL…" dialog.
   - "Copy as cURL" in the request menu and on tree rows.
   - A "Code" dialog with a language select, a resolve-variables toggle, and copy.
4. Done when: round-trip tests pass (parse(generate(r)) ≈ r), and real-world cURL samples from browser devtools ("Copy as cURL") import correctly.

## Milestone 7 — Command palette and examples

1. Command palette (shadcn `command` / cmdk, MIT) on Mod+K:
   - Searches requests, folders, collections and environments.
   - Typing `>` switches to actions (new request, switch environment, open settings, import cURL, toggle theme…).
   - Recently used items first.
2. Examples:
   - "Save as example" in the response viewer, named by the user.
   - An "Examples" list on the request: open read-only, rename, delete.
   - Each example stores the status, headers and body. Bodies over 1 MB are refused with a message.
   - fsstore keeps the sidecar file in step with the request on rename, move and delete.
3. Done when: the palette is fully usable from the keyboard; examples survive rename, move and reopen.

## Milestone 8 — Carry-overs and polish

1. deflate and brotli decompression (`andybalholm/brotli`, MIT, pure Go). Move this item out of the Tier 3 network list.
2. Code-split CodeMirror languages; record the main bundle size before and after.
3. Push to GitHub, run `ci.yml` and a test `release.yml` (pre-release tag), and fix the platform issues (macOS icon generation, NSIS). Replace the `OWNER/REPO` placeholders.
4. Update `docs/SMOKE-TEST.md` for Tier 2 flows, the ARCHITECTURE workspace layout, AGENTS.md (new packages, conventions) and the ROADMAP status.
5. Done when: the Tier 2 Definition of Done is met.

## Order and dependencies

```
M1 ─┬─ M2 ─┬─ M3 ─┬─ M4 ─┐
    │      │      └─ M5 ─┤
    └──────┴─ M6 ────────┼─ M8
           └─ M7 ────────┘
```

M6 needs only M1 (resolution, for codegen). M7 needs M2 (folders in the palette, sidecar moves). M4 and M5 can run in parallel.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Keychain behaves differently on each OS, or is missing on Linux | Everything goes through the `secrets.Store` interface; probe at startup; encrypted-file fallback; fake in tests |
| Master password forgotten | Secrets in the file store can't be recovered; the dialog says so. Offer "Reset secret store", which deletes the values, while the variable keys stay in the files |
| Many CodeMirror instances in tables | Mount the editor on focus only and render static highlighted text otherwise; measure with a 200-row table |
| Recursive watcher misses events (fsnotify isn't recursive) | Add watches for new folders synchronously; re-sync on rename/remove; test with nested external edits |
| Secrets leaking into history, codegen or logs | History stores requests as written; codegen masks secrets by default; e2e test asserts no secret in SQLite |
| cURL dialects (bash vs cmd vs PowerShell quoting) | Support POSIX shell quoting; detect `^` (cmd) continuations and report them as warnings; test samples from Chrome, Firefox and docs |

## Definition of Done (Tier 2)

- Every Tier 2 feature works on the Linux, macOS and Windows builds (CI green on all three).
- Coverage of at least 80% for Go and the frontend; lint clean.
- A Tier 1 workspace opens unchanged; a v2 workspace with nested folders, environments, globals and examples can be committed, cloned and reopened with no loss. On the cloned machine, secrets show as "not set on this machine".
- No secret value ever appears in a workspace file or in SQLite.

---

## Progress

- **M1 — Core: done.**
  - `model.Variable` `{key, value, enabled, secret}`: `value` is omitted from YAML when `secret: true`, and a value found next to `secret: true` in a hand-edited file is dropped on load. `fsstore.Collection.Variables` now uses it; Tier 1 key/value rows load unchanged.
  - `core/vars`: `New(scopes, opts…)` / `Resolve` / `ResolveRequest` / `Lookup` (winning value plus its scope, for hover and preview). Scopes are passed lowest precedence first. Names are case-sensitive, `{{ name }}` whitespace is ignored, and nesting is followed 10 levels deep (`ErrTooDeep` beyond that, `ErrCycle` with the chain, e.g. `a -> b -> a`). Dynamic names are checked before the scopes, so a user variable can't shadow `$timestamp`; an unknown `$name` is looked up like any other name. `WithClock` and `WithRand` inject the clock and random source. `ResolveRequest` resolves only what is sent: enabled rows (keys and values), the active body type and the active auth type's fields. Disabled rows and inactive fields are copied as is and not reported.
  - `core/inherit`: `Effective(chain, req)` returns the request with effective auth and merged headers, plus `Headers` (the applied inherited headers with their source) and `AuthSource`. An empty auth type on a folder or collection counts as `inherit`; on a request it stays `none` (Tier 1). A deeper enabled header hides every shallower one with the same name; same-name rows at one level are all kept.
  - `secrets`: the `Store` interface, sentinel errors (`ErrNotFound`, `ErrLocked`, `ErrWrongPassword`, `ErrNoPassword`, `ErrCorrupt`, …), `Key()` and `Select(primary, fallback)`.
    - `Keyring` uses service `pakpos` with the full key as the account. It goes through a `KeyringBackend` seam, and `Available()` runs a one-time probe (set/get/delete a sentinel) with a 3 s timeout, so a hung Secret Service counts as unavailable.
    - `FileStore` writes `secrets.enc` as JSON: a header (format, Argon2id params, salt, nonce), authenticated as GCM additional data, plus the AES-256-GCM ciphertext of the whole key→value map. It is written atomically with mode 0600. Header params are bounds-checked, so a damaged file can't trigger a huge allocation. GCM can't tell tampering from a wrong key, so a modified ciphertext reports `ErrWrongPassword`; structural damage reports `ErrCorrupt`.
    - `Fake` is exported for later milestones. The real-keychain test runs only with `PAKPOS_TEST_KEYRING=1`.
  - `fsstore`:
    - Environments (`environments/<slug>.yaml`): list, get, create, rename (renames the file), duplicate, delete, reorder (unlisted ones keep their order after the listed ones), save variables.
    - Globals (`environments/_globals.yaml`): `GetGlobals` hands out a stable pending ID without writing; `SaveGlobals` creates the file. Other `_*.yaml` files are reserved and skipped.
    - Load problems go into `Problems`. The watcher covers `environments/`, including the folder being created externally.
    - Manifest v2: new workspaces are created as v2 and v1 opens unchanged. A v1 manifest is rewritten to v2 only on the first v2-specific write (an environment or the globals), so a Tier 1 build then refuses the workspace instead of silently dropping data. `Manifest()` now takes the lock.
  - New dependencies: `github.com/zalando/go-keyring` v0.2.8 (MIT; pulls in `danieljoos/wincred`, MIT, and `godbus/dbus`, BSD-2, already present) and `golang.org/x/crypto` v0.59.0 (BSD-3). All pure Go.
- **M2 — Nested folders: done.**
  - `fsstore`:
    - Folders are subdirectories of a collection (any depth) with `_folder.yaml` `{id, name, seq, auth, headers}`. A subdirectory without one (or with a broken one) is reported in `Problems` and skipped with everything inside it; Tier 1 silently ignored subdirectories. `*.examples.yaml` files are skipped. Collection and folder ids share one namespace (either can be a parent), so a clash is a "duplicate" problem.
    - The index stores each request's and folder's parent id; directory paths are derived from the parent chain on every use, so renaming or moving a folder never leaves stale paths.
    - `Tree()` returns `Node{kind, id, name, seq, parentId, method, url, children}`; `RequestSummary` has `ParentID`. Folders and requests in one parent **share one seq order** (interleaved); ties go by name, then folders first, then id.
    - New: `CreateFolder`, `GetFolder`, `RenameFolder` (renames the directory), `SaveFolder` (`FolderSettings{auth, headers}`), `DeleteFolder` (recursive), `FolderParent`, `RequestParent`, `MoveRequest(id, toParentId, index)`, `MoveFolder(id, toParentId, index)`, `Reorder(parentId, ids)` (mixed children; unlisted ones follow in their current order) and the M1 carry-over `SaveCollection(id, CollectionSettings{auth, headers, variables})` (secret values never written).
    - Moves keep ids, work across collections, re-slug the file or directory name against the target (`-2`, `-3`… on collisions), and renumber seq 1..n in both source and target (only changed files are rewritten). `index` counts the target's children without the moved item; a negative or too large index appends; the same parent just reorders. A folder moved into itself or its subtree fails with `ErrInvalidMove`. `ReorderRequests` is replaced by `Reorder`; `CreateRequest`/`SaveAs` take a collection or folder id.
    - `InheritChain(id)` takes a request id or a collection/folder id (for drafts) and returns `[]inherit.Level`, collection first, ready for `inherit.Effective` (M3).
    - Manifest upgrade: `CreateFolder` and `SaveFolder` upgrade a v1 manifest; `SaveCollection` only when it writes a secret variable. Opening a Tier 1 workspace, and saving, moving and reordering its requests, keep its manifest at v1 and leave files that are not written unchanged (e2e test).
  - Watcher: every directory under `collections/` is watched. App-created, renamed and moved folders are watched synchronously with their subtree; externally created ones are added from their Create event with everything below them; a rename or removal of anything that may be a directory (not `*.yaml`, not a temp file) re-syncs all watches. Deleting a folder or collection marks the whole subtree as our own write, so it doesn't echo back. Tests cover external create/edit/rename/delete of nested folders and requests, and app renames/moves (run with `-race -count=5`).
  - Services: `WorkspaceService` gains `GetCollection`, `SaveCollection`, `CreateFolder`, `GetFolder`, `RenameFolder`, `SaveFolder`, `DeleteFolder`, `MoveRequest`, `MoveFolder`, `Reorder`. `RequestService.Move` (now appends to a collection or folder) and `Reorder` stay for compatibility. `e2e_test.go` covers the nested flow and a Tier 1 workspace opening unchanged.
  - Frontend:
    - `lib/model.ts`: recursive `CollectionNode`/`FolderNode`/`RequestSummary` (discriminated by `kind`, with `parentId`). New pure `lib/tree.ts` (walk, find, positions, `moveChild`, `destinations`), shared by the store and the sidebar.
    - `treeModel.ts`: `c:`/`f:`/`r:` keys, recursive filter (a matching request keeps its ancestors; a matching collection or folder name keeps its subtree), visible rows with level/posinset/setsize, expand state, `dropPosition` and `dropTarget`.
    - Expand state per workspace in `localStorage` (`pakpos-tree:<id>`): collections start expanded, folders collapsed. The Tier 1 key is read once as a fallback.
    - `CollectionTree` is a flat `role="tree"` with `aria-level`, `aria-expanded`, `aria-setsize`/`aria-posinset`. Folder rows have a chevron, a folder icon and a recursive request count. Menus: collections get "New folder"; folders get new request, new folder, rename, move to and delete (the confirm counts the requests inside). "Move to" is a submenu of every collection and folder, indented, with the full path as accessible name, the current parent disabled and a folder's own subtree left out. No "Settings" item until M4.
    - Drag and drop uses dnd-kit draggable + droppable rows (no sortable) with a drop line (before/after) or highlight (inside) and a drag overlay. Folders split into quarters (top before, middle inside, bottom after); requests into halves; collections take items inside and reorder only among collections. A folder's own subtree is excluded from collision detection and rejected by `dropTarget`.
    - Keyboard: ←/→ collapse/expand or go to parent/first child, ↑/↓, Home/End, Enter, F2, Delete, Alt+↑/↓ within the parent.
    - Store: `createFolder`, `renameFolder`, `deleteFolder`, `moveFolder`, and `moveRequest(id, parentId, index)` (optimistic, then refresh). Tabs have `parentId` instead of `collectionId` (persisted tabs are migrated); `syncTabs` updates it after moves; deleting a folder closes clean tabs inside it and detaches edited ones.
    - The Save dialog's "Save to" lists collections and nested folders. "New request" in the sidebar creates requests with `auth: inherit`.
- **M3 — Send pipeline: done.**
  - New package `internal/pipeline` (no Wails) ties fsstore, secrets, `core/inherit` and `core/vars` together so services stay thin. `Session.Prepare(req, parentId, envId)`: chain → `inherit.Effective` → scopes (globals, collection, selected environment, empty local; lowest first) → secret values from the store → `ResolveRequest`. `PrepareWithoutWorkspace` resolves only dynamic variables. `Preview` feeds M4/M5. It also owns the secret bookkeeping: `SaveVariables`, `SaveCollection`, `DeleteCollection`, `DuplicateEnvironment`, `DeleteEnvironment`, `SetSecret`/`ClearSecret`/`SecretStatus`.
  - Chain: a saved request (its id is in the workspace) uses its parent on disk; otherwise the `parentId` the frontend passes (`RequestService.Send(ctx, sendId, req, parentId)`). An unknown parent gives an empty chain.
  - Secrets: `secrets.Fill` loads values per scope; a secret without a usable value goes into the scope's `vars.Scope.Unset`, so it still shadows lower scopes and shows as unresolved (decided after review; `vars.Match.Unset`). Secrets left out because the file store is locked set `SendResult.secretsLocked` only when the request actually uses them. `secrets.SecretKeys`/`RemovedSecrets`/`DeleteKeys`/`CopyKeys` do the bookkeeping; `secrets.StatusOf`, `AsPasswordStore`, `ChangePassword` and `Explain` (user-facing messages, e.g. "Wrong password, or the secrets file is damaged.") back the store controls.
  - `SendResult` gains `unresolved` (never null), `secretsLocked` and `environment` (`{id, name}` or null). A variable cycle or nesting deeper than 10 is `error.kind = "variables"` with a message naming the chain; nothing is sent, and it is recorded in history like other send errors.
  - Wiring: `Config.Secrets` (main.go: `secrets.Select(NewKeyring(), NewFileStore(dataDir))`); when nil, `NewCore` uses the file store in the data dir and never probes the keychain. Tests inject `secrets.Fake` (`newHarness`) or a real `FileStore` in a temp dir (`newHarnessWith`).
  - SQLite migration `0002_workspace_state.sql`: a `workspace_state (workspace_id, key, value)` table (the selected environment lives under `selected_environment`) and `history.environment_name`. A selected environment that no longer exists reads as none.
  - History stores the request as written plus the environment name. **Per workspace:** `HistoryService.List`/`Clear` use the open workspace (the filter's workspace fields are ignored); with no workspace open they see only the entries sent without one (`HistoryFilter.noWorkspace`, `ClearHistoryWithoutWorkspace`). `Get`/`Delete` work on any id. Retention is per workspace (`PruneWorkspaceHistory` after a send, `PruneHistory` per group when the setting is lowered; no migration, the existing `history_workspace` index covers it).
  - `EnvService` (bound): `List`, `Get`, `Create`, `Rename`, `Duplicate` (copies secret values), `Delete` (deletes them), `Reorder`, `Globals`, `SaveGlobals`, `SaveVariables(scope, vars)`, `SetSecret`, `ClearSecret`, `SecretStatus(scope)` (keys with a stored value, never values), `Select`, `Selected`, `ResolvePreview(req, parentId)` (inherited headers and auth with source, visible variables with secret values always empty and a `set` flag, unresolved names, `secretsLocked`, `error`), `SecretsStatus`, `SetMasterPassword`, `ChangeMasterPassword`, `Unlock`, `Lock`, `ResetSecretStore`. `WorkspaceService.SaveCollection`/`DeleteCollection` go through the pipeline, so removed, renamed or un-secreted variables and deleted collections lose their stored values.
  - Events: external edits to `environments/` keep firing `workspace:changed` (the watcher already covers it and reloads everything); no separate event. M4 refreshes environments on it.
  - Frontend: `api.ts`/`model.ts` for `EnvService`, the new `SendResult` and history fields (`apiMock.ts` stubs; `makeResult`/`makeHistorySummary` fixtures). Send passes the tab's `parentId`. The response pane shows a quiet note ("Unresolved variables: {{a}}, {{b}}. They were sent as written." / "Secrets are locked…"), and `errorCopy` covers `variables`. Save dialog: `isUntouchedAuth` (type `none`, every auth string empty, API key location at its default) switches to `inherit` when saved into a collection or folder (`prepareForCollection` in `saveTabAs`). The history panel reloads on workspace change, shows each entry's environment, and "Clear history" names the workspace (or "sent without a workspace").
  - Tests: `pipeline` unit tests (chain, precedence, inheritance, drafts, locked/failed stores, cycles, preview, every bookkeeping path), `secrets` helper tests, sqlite state/history tests, service tests (no-workspace errors, environments, selection per workspace, preview, keychain vs real file store including a locked send, cycles, per-workspace history). `TestEndToEndSendPipeline`: inherited bearer secret with a folder header override, `{{baseUrl}}` switching servers across environments, globals vs environment, an unset secret reported, `$randomInt`, a draft with `parentId`, duplicate/delete with secrets, history unresolved with environment names and per workspace, and a scan of the data dir (DB, WAL, bodies) and the workspace for the secret values.
- **M4 — Environments and settings UI: done.**
  - Go (thin, tested): `EnvService.RevealSecret(scope, key)` returns one value, only for a key that is a secret variable of the scope (`pipeline.ErrNotSecret` otherwise; no stored value → "No value is stored for X on this machine. Set one first."). `EnvService.MakeVariablePlain(scope, key)` turns a saved secret into a plain variable **in Go**: the stored value is written to the file and deleted from the store, so it never passes through the UI (a locked store refuses and changes nothing). Bindings regenerated; `api.ts`/`model.ts`/`apiMock.ts` gain `revealSecret`, `makeVariablePlain`, `getCollection`/`saveCollection`/`getFolder`/`saveFolder` (`normalizeCollection`: an empty or `inherit` auth type on a collection reads as `none`; `normalizeFolder`: empty reads as `inherit`).
  - Stores: `stores/environments.ts` (list, globals, selection, `version` bumped on every reload/selection/container save so previews re-resolve; optimistic reorder; `shiftId`/`moveId`), `stores/secrets.ts` (status, the dialog in use, and `ensureReady()`, which opens set-password or unlock and resolves when it closes). `features/scopes/useScopeSync` (in `AppShell`) loads both on workspace open, on `workspace:changed`, and keeps doc tabs in step with the tree and the environment lists.
  - Tabs: `Tab.doc` (`null` for request tabs) holds `{kind: environment|globals|collection|folder, targetId, name, draft, saved, missing}`; request tabs are unchanged and persisted tabs without `doc` restore as request tabs (unknown kinds too; a draft without its saved copy reloads). Doc drafts never hold secret values. `isDirty`/`tabTitle`, the close prompt, Mod+S (`saveTab` routes to `saveDocTab`) and Mod+W work for both kinds. External changes: a clean doc tab shows the disk version, a dirty one keeps its edits with a toast; a target deleted outside the app closes a clean tab and marks a dirty one `missing` (banner, Save disabled). Switching workspace closes doc tabs of the old one.
  - Environment switcher at the right end of the tab bar (a Radix select: "No environment", the environments, "Edit globals", "Manage environments…"); hidden without a workspace. The status bar shows the environment (click opens the Environments view) and, with the file store only, a lock indicator (set password / unlock / lock).
  - "Environments" is a new activity-rail view: Globals row, then the environments with "In use", variable count, menu and context menu (open, use/stop using, rename, duplicate, move up/down, delete with confirm), drag to reorder (dnd-kit sortable, rows spread only `listeners`), and ↑/↓, Alt+↑/↓, F2, Delete on a focused row. Empty, loading and error states.
  - Editor tabs (`features/scopes/DocEditor`): header with name, kind, "Unsaved changes", Save, and for environments "Use this environment"/"In use" plus rename (menu or double-click), duplicate (opens the copy) and delete. Environment and globals tabs are a `VariablesTable`; collection settings have Auth (no `inherit`), Headers (`KeyValueTable`) and Variables; folder settings have Auth (with `inherit`, showing what it resolves to via `ResolvePreview` of an inheriting probe request in the folder's parent) and Headers. Loading, load error (retry/close) states.
  - `VariablesTable`: key, value, enabled, secret toggle, delete. Secret rows never carry a value: `SecretValueCell` masks set values, says "Not set on this machine", or "Locked. Unlock to use it"; reveal (`RevealSecret`, component state only, dropped on hide, key change or unmount), set (password input, Enter/blur stores via `SetSecret`, Escape cancels) and clear (`ClearSecret`). Plain → secret moves the row's value to the store right away and empties it in the draft. Secret → plain asks first; a saved secret goes through `MakeVariablePlain` (written to disk at once, the tab's saved copy updated), an unsaved one just clears its value. `ensureReady` runs before every store call.
  - Request tab: Headers gets an "Inherited" section (read-only, muted, source link opens that settings tab), from `usePreview` (debounced 300 ms on the draft, parent, environment `version` and tree). Auth `inherit` shows "Uses Bearer token from the collection Users" with a link, or "No auth is set on the collection or its folders, so none is sent." Literal password/token/API key values show "This value is saved in the file as plain text. Move to secret variable": the dialog asks for a name and a scope (selected environment, the collection, globals; first available is the default), refuses a taken name or a scope with unsaved edits in an open tab, stores the secret, adds the variable and replaces the field with `{{name}}`. The same hint is offered in collection/folder auth.
  - Master password: set-password (confirm, strength hint, "can't be recovered" warning, at least 8 characters), unlock ("Wrong password, or the secrets file is damaged." from Go; "Reset secret store…"), change password, and a destructive reset confirm. Settings gets a "Secrets" section (keychain vs encrypted file, lock/unlock, change, reset; these apply right away). The response notice gets "Unlock" when `secretsLocked`; a locked send refreshes the status.
  - "Settings" in the collection and folder menus (tree context and "More actions"). The request auth label is now "Inherit from parent".
  - Follow-up (decisions confirmed by the user, see Decisions):
    - Renamed secrets keep their value. `pipeline.SecretRename{from, to}`; `Session.SaveVariables`/`SaveCollection` take renames (variadic) and call `moveRenamed` before writing. Bound signatures gained a `renames` argument: `EnvService.SaveVariables(scope, vars, renames)`, `SaveGlobals(vars, renames)`, `WorkspaceService.SaveCollection(id, settings, renames)`; store errors go through `secrets.Explain`. Frontend: `VariablesTable` records a secret row's first key as `origin` (editor-only, stripped by `compactDraft` and `api.ts`), `secretRenames(draft, saved)` builds the pairs, and `saveDocTab` runs `ensureReady()` first when there are any.
    - `secrets.CheckNewPassword` / `MinPasswordLength = 8` / `ErrPasswordTooShort`, checked by `SetMasterPassword` and `ChangePassword`. `secrets.Fake.SetErr` fails only writes (tests).
    - Tests: `TestSaveVariablesMovesRenamedSecrets` (rename, swap, unset and bogus pairs), `TestRenamesRefusedWhileLocked`, `TestEnvServiceSaveMovesRenamedSecrets`, `TestEndToEndRenamedSecretKeepsValue`, `TestCheckNewPassword` and the short-password service cases; frontend `secretRenames`, pairs per scope, unlock-before-rename, `origin` tracking and stripping.
  - Tests: Go `TestRevealSecret`, `TestMakePlain`, `TestEnvServiceRevealAndMakePlain`; frontend stores, doc actions, every new component, app-level flows (Mod+S, close prompt, external reload, tree menu, lock indicator). Go 95.1%, frontend 98.8% statements / 95.9% branches.

### Carried over from M1

- ~~**Secret values on duplicate.**~~ Done in M3 (`pipeline.DuplicateEnvironment`/`DeleteEnvironment`, `SaveVariables` cleanup). Secret values are keyed by scope ID, so `DuplicateEnvironment` doesn't copy them. `EnvService` (M3) should copy them in the secret store, and delete them when an environment is deleted or a secret variable is removed or renamed.
- ~~**Unset secrets.**~~ Done in M3 (`secrets.Fill`). A secret with no stored value should be left out of the scope before resolving, so it shows up as unresolved (M3 loader).
- ~~**Collection settings.**~~ Done in M2 (`SaveCollection`). There is no `SaveCollection` for auth, headers and variables yet (M2 adds `SaveFolder`; add the collection equivalent alongside it). It must call the manifest upgrade when it writes secret variables.
- **AGENTS.md.** Move go-keyring out of "Planned" and document the new packages (M8).

### Carried over from M2

- ~~**Settings UI (M4).**~~ Done in M4. `GetCollection`/`SaveCollection`/`GetFolder`/`SaveFolder` are bound but not in `lib/api.ts` yet; add them with the settings tab, plus a "Settings" item in the collection and folder menus.
- ~~**Secret cleanup (M3).**~~ Done (`pipeline.SaveCollection`/`DeleteCollection`, used by `WorkspaceService`). `SaveCollection` drops removed secret variables from the file only; `EnvService` should delete their keychain values, and those of a deleted collection.
- **Examples sidecars (M7).** Moving a folder carries its `*.examples.yaml` files along, but `MoveRequest`, `RenameRequest`/`SaveRequest` (file re-slug) and `DeleteRequest` don't touch the sidecar yet.
- **Reveal in tree.** Folders start collapsed; opening a request from history or the palette (M7) should expand its ancestors and scroll to it.
- ~~**Draft inheritance (M3).**~~ Done (`Send(…, parentId)`). Tabs now know their `parentId`; `RequestService.Send` can pass it to `InheritChain` for saved requests and drafts.
- ~~**Save dialog auth (M3).**~~ Done (`isUntouchedAuth`, `prepareForCollection`). Decided: a draft whose auth is still the untouched `none` switches to `inherit` when saved into a collection or folder through the Save dialog. Auth the user set is never changed.
- **AGENTS.md (M8).** Apply the M2 suggestions: `_folder.yaml` and skipped `*.examples.yaml`; folder paths derived from parent ids (`dirLocked`), never cached; `markTree` before `RemoveAll`; `InheritChain` order; `ErrInvalidMove`; `src/lib/tree.ts`; `c:`/`f:`/`r:` tree keys; tabs' `parentId`; `col`/`folder`/`req` fixtures; `group/item`/`group/row` replacing the nested-group note; DnD test props (`over.rect`, `activatorEvent.clientY`, `delta.y`, `data-drop`); Radix Select names come from ItemText.
- **`frontend/.vitest/`** appeared as an untracked folder; add it to `.gitignore`.

### Carried over from M3

- **Orphaned secret values.** Decided: no cleanup pass for now. Cleanup runs after the workspace change and only logs failures, so deleting or renaming while the file store is locked (or the keychain errors) leaves the old values behind; so do variables removed by hand-editing files (the watcher doesn't clean up). They're unreachable and harmless, but a "prune on unlock" (compare stored keys with the workspace) could tidy them; the `Store` interface would need a key listing for the file store.
- ~~**Revealing secrets (M4).**~~ Done (`EnvService.RevealSecret`). Decided: M4 adds `EnvService.RevealSecret(scope, key)`, returning one value on demand, only on an explicit user click. Everything else keeps returning no secret values.
- ~~**Unset secret shadowing.**~~ Decided and done: unset secrets shadow lower scopes (see Decisions).
- ~~**Unlock from the notice (M4).**~~ Done (notice "Unlock", status bar lock indicator). The response note says secrets are locked but has no unlock action yet; add it with the unlock dialog. The status bar lock indicator can use `SecretsStatus`.
- ~~**History retention**~~ Decided and done: per workspace (see Decisions).
- ~~**Environment UI refresh (M4).**~~ Done (`useScopeSync`). Reuse `workspace:changed` to reload environments and the selection; the app's own writes don't fire it.
- **Flaky test (M8).** `Sidebar.test.tsx` "supports arrow keys, Enter, F2 rename and Delete" failed once under the full coverage run (passes alone and on rerun); investigate in M8, probably a timing issue under load.
- **AGENTS.md (M8).** Add `internal/pipeline` (send pipeline and secret bookkeeping, no Wails) to the layout; `Config.Secrets` and the `newHarness`/`newHarnessWith` test harnesses; `Send` now takes `parentId`; history is per workspace; `workspace_state` table; `secrets.Explain` for user-facing store errors; `makeResult`/`makeHistorySummary` fixtures.

### Carried over from M4

- ~~**Renaming a secret variable.**~~ Done in the M4 follow-up: explicit rename pairs move the value (see Decisions). Hand-edited renames still drop it.
- **Secret values for unsaved rows.** Setting a value on a secret row that was never saved (or moving a plain value into the store) writes to the store at once; discarding the draft leaves an unreachable value (same as the M3 orphan note).
- ~~**Making a secret plain is immediate.**~~ Confirmed by the user; kept (see Decisions).
- **Inherited headers overridden by the request** aren't listed (the preview only returns applied ones); showing them struck through, like "Added when sending", needs the preview to return hidden ones too.
- **Variables tables** use plain inputs; M5 turns value cells into lazy single-line `<CodeEditor>`s with highlighting.
- **Collection/folder settings tabs** can't rename; rename stays in the tree.
- **Screenshots** for review were taken with `vite preview` + Playwright (fake `**/wails/runtime*` handlers built from the bindings' method IDs); worth a small script in `scripts/` (M8).
- ~~**Master password length / switcher placement.**~~ Decided: 8 characters enforced in Go; switcher stays in the tab bar (see Decisions).
- **AGENTS.md (M8).** Add: secret renames go as `{from, to}` pairs with the save (`Variable.origin` is editor-only); `secrets.CheckNewPassword`; `Tab.doc` for non-request tabs (check `tab.doc` before using request fields; `saveTab` routes doc tabs); `stores/environments.ts` (`version` for previews), `stores/secrets.ts` (`ensureReady()` before any secret-store call); `features/scopes` (`DocEditor`, `VariablesTable`, `docActions`, `useScopeSync`, `moveToSecret.ts`); `RevealSecret`/`MakeVariablePlain` are the only ways a secret value moves, revealed values live in component state only; `makeVar`/`makeEnv`/`makePreview` fixtures; the environment and secrets stores are reset in `resetSidebarStores`; tests that capture `onWorkspaceChanged` must keep every listener (the workspace store and `useScopeSync` both subscribe); ItemMenu items with a shortcut have it in their accessible name (query `/^Rename/`); a closing Radix dialog keeps the page `aria-hidden` for a tick, so use `findByRole` right after.
