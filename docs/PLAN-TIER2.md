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
- M2–M8: not started.

### Carried over from M1

- **Secret values on duplicate.** Secret values are keyed by scope ID, so `DuplicateEnvironment` doesn't copy them. `EnvService` (M3) should copy them in the secret store, and delete them when an environment is deleted or a secret variable is removed or renamed.
- **Unset secrets.** A secret with no stored value should be left out of the scope before resolving, so it shows up as unresolved (M3 loader).
- **Collection settings.** There is no `SaveCollection` for auth, headers and variables yet (M2 adds `SaveFolder`; add the collection equivalent alongside it). It must call the manifest upgrade when it writes secret variables.
- **AGENTS.md.** Move go-keyring out of "Planned" and document the new packages (M8).
