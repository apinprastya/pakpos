# Pakpos — Webhook Test Server Plan

Reference: [ARCHITECTURE.md](./ARCHITECTURE.md), [ROADMAP.md](./ROADMAP.md), [PLAN-TOOLS.md](./PLAN-TOOLS.md)

A webhook receiver built into Pakpos. Start a webhook, and Pakpos listens on
a local port and opens a Cloudflare quick tunnel to it, which gives a public
`https://<random>.trycloudflare.com` URL. Paste that URL into Stripe, GitHub
or your own service, and every request it sends shows up live in Pakpos. Rules
decide what Pakpos replies ("if the method is POST and the path is
`/payments/*`, reply 400 with this body"), so you can test how the sender
handles errors and retries. Today this needs webhook.site or ngrok plus a
script; webhook payloads often carry customer data and signatures, so keeping
them on your own machine is the safer choice.

## Scope

**In:**
- Webhooks as workspace files: one YAML file per webhook with its rules and default response, committed and shared like requests
- A local HTTP server per running webhook (127.0.0.1, random port), several at once
- Cloudflare quick tunnels through the `cloudflared` binary: found on PATH, picked in Settings, or downloaded by Pakpos on request (SHA-256 checked)
- A "Local only" start without a tunnel (for local senders and for tests)
- A request log per webhook: live while it runs, stored in SQLite (newest 500 per webhook), cleared on request
- Response rules: ordered, first enabled match wins; match on method, path pattern and conditions on headers, query and body; reply with status, headers, body and an optional delay
- Response templates with request data (`{{$request.json.id}}`) and the existing dynamic variables (`{{$randomUUID}}`)
- From a logged request: create a rule, copy as cURL, open as a request tab (to replay it), copy the body
- A "Webhooks" activity-rail view, webhook tabs, palette actions

**Out (later or separate plans):**
- Named Cloudflare tunnels with a stable hostname (needs a Cloudflare account and login); the quick-tunnel URL changes on every start
- Other tunnel providers (ngrok, localtunnel)
- Forwarding requests to a local service (proxy mode)
- Verifying webhook signatures (Stripe, GitHub HMAC) in the log; the HMAC tool covers manual checks
- Workspace `{{variables}}` in responses (see "Template data" below for why)
- The mock server from saved examples (Tier 4); it can reuse this server and rule engine later
- Running webhooks from the future headless CLI

## Decisions

| Topic | Decision |
|---|---|
| Name | "Webhooks" in the UI ("New webhook", "Start", "Stop"). A webhook is a definition (name, rules, default response); "running" means its server is up. |
| Storage | Workspace files: `webhooks/<slug>.yaml` at the workspace root, next to `collections/` and `environments/`. One file per webhook; rules live inside it in order. Writes go through `fsstore.Workspace` (atomic, marked as own writes, watched). |
| Format version | No bump. Older builds only read `collections/` and `environments/`, so they ignore `webhooks/` and never rewrite it; nothing is lost when an older build saves. The first webhook write upgrades the manifest to `FormatVersion` (3) like other Tier 3 writes, so a v1/v2 workspace isn't opened by a build that predates v3. |
| Where the code lives | `internal/core/webhook`: pure model, path patterns, matching, template rendering (no I/O). `internal/hookserver`: the HTTP server, capture and the `Manager` of running webhooks (no Wails; like `runner`; named so it doesn't clash with `core/webhook`). `internal/tunnel`: finding, downloading and running `cloudflared` (no Wails). `service/webhooks.go`: thin `WebhookService`. |
| Tunnel | Quick tunnels: `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>`. The public URL is read from cloudflared's log output (`https://[a-z0-9-]+\.trycloudflare\.com`), with a 30 s timeout. One cloudflared process per running webhook, stopped with it, on workspace close and on app quit. If it exits on its own, the webhook goes to "Tunnel stopped" with cloudflared's last log line; the local server keeps running. |
| Finding cloudflared | In order: the path in Settings (`cloudflaredPath`), Pakpos's own copy in `<data>/bin/`, then `PATH`. `WebhookService.CloudflaredStatus()` reports which one, its version (`cloudflared --version`) or "not found". |
| Downloading cloudflared | Only after the user clicks "Download cloudflared" (never silently). Pakpos reads the latest release of `cloudflare/cloudflared` from the GitHub API, picks the asset for the OS and architecture (`cloudflared-linux-<arch>`, `cloudflared-windows-<arch>.exe`, `cloudflared-darwin-<arch>.tgz`), downloads it with the app's network settings, checks its SHA-256 against the asset's `digest` from the API and refuses on a mismatch or a missing digest, then installs it to `<data>/bin/cloudflared[.exe]` (0755; tgz unpacked). Progress is the typed event `webhook:install`. cloudflared is Apache-2.0 and runs as a separate process, so the license list doesn't change. |
| Local server | `net/http` on `127.0.0.1:0` (random free port), never `0.0.0.0`. Every method and path is accepted. Reads up to 10 MiB of body (`MaxRequestBody`); above that it replies 413 and logs the request with "Body too large". Timeouts: 30 s read and write, plus the rule's delay. |
| Port | Random for each start, shown in the tab. The public URL changes on each start anyway (quick tunnels). A fixed port is a later addition. |
| Running across workspaces | Running webhooks **keep running** when their workspace is switched or closed. The `Manager` lives in `Core` (not per workspace) and keys webhooks by `(workspaceId, webhookId)`. Rules saved while it runs apply to the next request; an external change to the file (git pull) applies after the watcher reloads it, but only while that workspace is open: once it's closed, the webhook keeps the last rules it loaded. The log keeps filling in SQLite under its own workspace id. |
| Running in other workspaces (UI) | The Webhooks view lists the open workspace's webhooks, plus a "Running in other workspaces" group at the top (name, workspace name, URL with Copy, Stop, Open log). "Open log" opens a read-only webhook tab (Requests only; rules are edited after switching back). `WebhookService.Statuses()` returns every running webhook with its workspace id and name. |
| On quit | Everything stops on quit (servers shut down, cloudflared processes killed). Nothing restarts on the next launch; the user starts webhooks again. |
| Rule model | `Rule{id, name, enabled, match, response}`. `match{method, path, conditions[]}`: `method` is `ANY` or one method; `path` is a pattern; each condition is `{source: header\|query\|body\|json, name, op: equals\|contains\|exists\|matches, value}` (`json` reads a dot path like `data.object.status`; `matches` is a Go regexp, checked on save). All conditions must hold. `response{status, headers[], body, delayMs}`; a body with no `Content-Type` header gets one by sniffing (JSON, XML, else text/plain). |
| Path patterns | Exact segments, `*` for one segment, `**` (last only) for the rest, `:name` for one segment captured as `{{$request.params.name}}`. A trailing slash is ignored; matching is case-sensitive; the query string isn't part of the path. |
| Order | First enabled matching rule wins, top to bottom; rules are reordered by drag and drop. No match → the webhook's `defaultResponse` (new webhooks: 200, `{"ok": true}`). |
| cloudflared version | The download installs the **latest** release (not a pinned one), so Cloudflare never retires it; the SHA-256 digest from the GitHub API is the check. |
| Template data | Response headers and body can use `{{$request.method}}`, `.path`, `.query.<name>`, `.header.<name>`, `.params.<name>`, `.body`, `.json.<dot.path>`, plus the dynamic variables from `core/vars` (`$randomUUID`, `$timestamp`, ...). Unknown references stay as written. **Workspace variables are never resolved:** the URL is public, and a rule must not be able to send an environment's token to whoever calls it. JSON escaping inside JSON string literals follows `vars.ResolveJSON`. |
| Request log | SQLite migration `0007_webhook_requests.sql`: `{id (ULID), workspace_id, webhook_id, received_at, method, path, query, headers_json, body (BLOB, first 1 MiB), body_size, truncated, remote_addr (CF-Connecting-IP when tunnelled), rule_id, rule_name, status, duration_ms}`. Newest 500 per webhook (`sqlite.MaxWebhookRequests`, pruned on insert). Deleting a webhook deletes its log. Clear log and delete one entry from the UI. |
| What the log holds | Exactly what the sender sent. It can hold the sender's secrets (signature headers, API keys in payloads), so it stays in the local database only: never in workspace files, never in history, never sent anywhere. The response pane's masking doesn't apply (the values aren't workspace secrets). |
| Events | `webhook:request` (`WebhookRequestEvent{workspaceId, webhookId, entry}` with the summary, not the body) after the row is stored; `webhook:status` (`hookserver.Status{workspaceId, webhookId, name, workspaceName, state, tunnel, localUrl, publicUrl, message, startedAt}`, states `running`, `tunnel-starting`, `tunnel-failed`, `stopped`; a local server that can't start is an error from `Start`); `webhook:install` (`{done, total, state}`). Registered in `main.go`'s `init`. |
| Service | `WebhookService`: `List`, `Get`, `Create(name)`, `Save(def)`, `Rename`, `Duplicate`, `Delete`; `Start(id, tunnel bool)`, `Stop(id)`, `Statuses()`; `Requests(webhookId, beforeId, limit)`, `Request(id)` (with body), `DeleteRequest`, `ClearRequests`; `CloudflaredStatus`, `InstallCloudflared`, `CancelInstall`, `PickCloudflared`. Save validates (status 100–599, method, pattern, regexps, delay 0–60 000 ms, body ≤ 1 MiB) and returns user sentences. |
| UI placement | A fifth activity-rail view, "Webhooks" (lucide `Webhook`), above Tools: the workspace's webhooks with a running dot, "New webhook", and a context menu (Rename, Duplicate, Delete, Start, Stop). A webhook opens a doc tab (`doc.kind = "webhook"`, draft = the definition, saved with Mod+S like settings tabs). |
| Webhook tab | Header: name, Start (split button: "Start with tunnel" / "Start local only"), Stop, the URL (public, or local) with Copy, and status text. Two sections: **Requests** (a live list on the left, newest first: time, method, path, status, rule; the selected request on the right: headers table, query, body in a read-only `CodeEditor` with language by content type, response sent, actions) and **Rules** (ordered list with enable checkboxes and move up/down buttons (Alt+↑/↓ on a rule); the selected rule's editor: method, path, conditions table, response status, headers and body in a `CodeEditor` with template completions; the default response at the bottom). |
| From a logged request | "Create rule" prefills method and exact path (and opens the Rules section on it); "Copy as cURL" (`curl.Generate` against the public URL); "Open as request" opens a draft with method, URL, headers and body, so it can be replayed at a local service; "Copy body". |
| cloudflared missing | Start with tunnel shows a panel in the tab: "Pakpos needs cloudflared to open a public tunnel." with "Download cloudflared" (progress, Cancel), "Choose file…", a link to Cloudflare's install docs, and "Start local only". Settings gets a Webhooks section with the same status and the path. |
| Palette | "New webhook", "Open webhooks", and on the active webhook tab "Start webhook with public tunnel", "Start webhook locally", "Stop webhook", "Copy webhook URL". No new shortcut. (A step listing every webhook was dropped: it needs a new palette page type for little gain.) |

## Progress

All milestones are done in code (2026-11-21). Tests: Go 96.1% overall (`core/webhook` 99%, `hookserver` 98%, `tunnel` 90%, service files 95%+), frontend 98.7% (webhooks feature 97%); `wails3 task lint` clean.

Verified for real on Linux: `PAKPOS_TEST_TUNNEL=1 go test ./internal/tunnel -run TestRealTunnel` downloaded cloudflared 2026.11.1 from GitHub, checked its SHA-256 digest, opened a quick tunnel with `--config <empty file>` and got a reply through the public URL. Screenshots of the view, rules and settings were checked in light and dark themes.

Implementation notes beyond the decisions above:
- A known template reference with no value (`{{$request.query.missing}}`) becomes ""; an unknown one stays as written.
- Every tunnel start writes the empty config file `<data>/bin/quick-tunnel.yml` and passes it with `--config` (step 3 of M4: always done rather than detected).
- Webhook request bodies are returned to the frontend as text when they are UTF-8 (a body cut at 1 MiB may end mid-character and is trimmed), else as base64 with `binary: true`.
- "Open as request" and "Copy as cURL" drop headers the transport or Cloudflare added (Host, Content-Length, CF-*, X-Forwarded-*, …).

### Definition of Done — what's left
- Smoke tests on macOS and Windows (only `GOOS=windows go vet` and CI cover Windows: hidden console window, killing `cloudflared.exe`, the per-user data dir). See the Webhooks section of SMOKE-TEST.md.
- A machine with a real `~/.cloudflared/config.yml` (named tunnel) to confirm `--config` keeps the quick tunnel separate.
- A real third-party sender (Stripe CLI or a GitHub webhook) end to end.

## Milestone 1 — Rule engine (Go, pure)

1. `internal/core/webhook`: `Webhook`, `Rule`, `Match`, `Condition`, `Response` with YAML/JSON tags; `Validate()` with user sentences; `Normalize()` (ids for new rules, method upper-case).
2. `pattern.go`: compile and match path patterns, return captured params.
3. `match.go`: `Select(w, req) (rule *Rule, params)`, where `req` is a small captured-request struct (method, path, query, headers, body); conditions incl. JSON dot paths and regexps.
4. `render.go`: `Render(resp, req, params, vars) (status, headers, body)` with `{{$request.*}}` and dynamic variables; content-type sniffing.
5. Done when: table-driven tests cover patterns (wildcards, params, trailing slash), every condition source and op, first-match order, disabled rules, the default response, templates (missing values, JSON escaping, unknown names kept) and validation errors; coverage ≥ 80%.

## Milestone 2 — Storage

1. `fsstore/webhooks.go`: load `webhooks/*.yaml` in `Reload` (problems for bad files, duplicate ids), `Webhooks()`, `GetWebhook`, `CreateWebhook`, `SaveWebhook`, `RenameWebhook` (re-slug), `DuplicateWebhook` (new ids), `DeleteWebhook`; watch the directory; manifest upgrade on the first write.
2. Migration `0007_webhook_requests.sql` and `sqlite/webhooks.go`: `AddWebhookRequest(rec)` (prune to `MaxWebhookRequests`), `ListWebhookRequests(webhookID, beforeID, limit)`, `GetWebhookRequest`, `DeleteWebhookRequest`, `ClearWebhookRequests`, `DeleteWebhookLog(webhookID)`.
3. Done when: `t.TempDir()` tests for load/save/rename/duplicate/delete, external edits and bad files; in-memory SQLite tests for pruning and paging.

## Milestone 3 — Server and service (local only)

1. `internal/hookserver`: `Server` (listen on 127.0.0.1:0, capture with the size limit, select a rule, render, delay respecting the request context, write the reply, hand a `Record` to a sink), `Manager` (start/stop by `(workspaceId, webhookId)`, rules snapshot swapped on save, `Running()`, `Close()`).
2. `WebhookService` CRUD and `Start(id, tunnel=false)`/`Stop(workspaceId, id)`/`Statuses`/log methods; events `webhook:request` and `webhook:status`; `Core` owns the manager, keeps it across workspace switches, and closes it in `Core.Close`.
3. Done when: `httptest`-style tests drive real requests at the server (rules, 413, delay cancelled on stop, concurrent requests); `service/e2e_webhook_test.go` creates a webhook with rules, starts it local only, sends requests with `net/http`, checks replies, stored log, events, edits applied while running, that it keeps answering (and logging under its workspace) after switching to another workspace, and that `Core.Close` stops it.

## Milestone 4 — Tunnel

1. `internal/tunnel`: `Locate(settingsPath, dataDir)` (order above, version check), `Install(ctx, client, dataDir, progress)` (GitHub API, asset choice per `GOOS/GOARCH`, digest check, tgz unpack, atomic rename), `Start(ctx, bin, localURL) (*Tunnel, error)` (process, URL parsing from logs, `Done()`, `Stop()`; kills the process tree on Windows).
2. Wire into `Manager`/`WebhookService.Start(id, true)`: status events `tunnel-starting` → `running` with `publicUrl`, `tunnel-failed` with a message; `CloudflaredStatus`, `InstallCloudflared` (+ `webhook:install` progress, `CancelInstall`), `PickCloudflared`; settings field `webhooks.cloudflaredPath`.
3. Check on all three OSes that a `~/.cloudflared/config.yml` doesn't take over a quick tunnel; if it does, run with `--config` pointing at an empty file in `<data>/bin/`.
4. Done when: tests use a fake cloudflared (the test binary re-executed as a helper process) that prints a trycloudflare URL, exits early, or never prints one; the installer is tested against an `httptest.Server` serving release JSON, a plain binary, a tgz, a wrong digest and a missing digest. Real-tunnel tests run only with `PAKPOS_TEST_TUNNEL=1`.

## Milestone 5 — Frontend: view, tab and log

1. `lib/webhookModel.ts` (types, normalizers), `api.ts` + `apiMock.ts`, fixtures (`makeWebhook`, `makeWebhookRequest`, `makeWebhookStatus`).
2. `stores/webhooks.ts`: list per workspace, statuses, live log per webhook (subscribed to `webhook:request`/`webhook:status`; capped in memory, older pages loaded on scroll), install progress; reset in `resetSidebarStores`.
3. `stores/layout.ts` `"webhooks"` view, `ActivityRail` entry, `WebhooksSidebar.tsx` (with the "Running in other workspaces" group and its read-only log tabs); `DocKind` `"webhook"`, `openDoc`, title, `saveDocTab` routing, `syncContainerTabs` closing tabs of deleted webhooks.
4. `features/webhooks/` (lazy chunk, `loadWebhooks`): `WebhookView` header with Start/Stop/URL/status, the cloudflared panel, the Requests section and request detail with its actions.
5. Done when: RTL tests cover create, rename, delete, start/stop (local and tunnel), the missing-cloudflared panel and download progress, live arrival of requests, request detail and each action; both themes checked with `scripts/screenshot.mjs`.

## Milestone 6 — Rules editor and palette

1. Rules section: list with enable switch and drag reorder (handlers tested via a mocked `DndContext`), rule editor, conditions table (`useColumnSplit`), response editor with template completions, default response; validation messages from Save shown on the field.
2. "Create rule" from a logged request; palette actions; Settings → Webhooks section.
3. Done when: RTL tests cover editing, reordering, enabling, validation errors, create-from-request and every palette action.

## Milestone 7 — Docs and release checks

`AGENTS.md` (layout, architecture notes, frontend notes), `ARCHITECTURE.md`, `ROADMAP.md`, `README.md` feature list, and a Webhooks section in `SMOKE-TEST.md` (download cloudflared, start with a tunnel, send from curl and from a real sender, rules, restart keeps the log, stop on workspace switch, on each OS).

## Order and dependencies

```
M1 ─┬─ M2 ── M3 ─┬─ M4 ─┐
    │            └─ M5 ─┴─ M6 ── M7
```

M4 (tunnel) and M5 (frontend on local-only webhooks) can go in parallel once M3 is done.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| A public URL reaches the app | The server only answers with rule output and request data from the same request; it has no access to workspace variables, secrets, history or files. It binds 127.0.0.1 only, and cloudflared is the only way in. |
| Flooding (a sender in a retry loop, a scanner) | 10 MiB body limit, 1 MiB stored per body, 500 rows per webhook, the UI's live list capped in memory; Stop is always one click away. |
| A tampered cloudflared download | Downloaded only on a click, over HTTPS from GitHub, SHA-256 checked against the release's digest, refused without one; Pakpos runs only that path or the one the user picked. |
| cloudflared output format changes | The URL is matched with a loose regexp over every log line; the 30 s timeout reports "cloudflared didn't report a tunnel URL" with its last log line. |
| Quick tunnel limits (rate limits, no uptime guarantee, Cloudflare may change them) | Documented in the UI's help text; "Local only" works without it; named tunnels are a later option. |
| Forgotten webhooks running in the background (they outlive a workspace switch) | The "Running in other workspaces" group is always at the top of the view, the rail icon shows a running dot, and everything stops on quit. |
| Orphaned cloudflared after a crash | It points at a closed port, so requests fail harmlessly; Pakpos starts processes with its own data dir in the command line and kills them on stop and quit. |
| Windows process handling | Kill with the process handle (no shell), tested in CI on Windows; the binary is `cloudflared.exe`. |
| Webhook files edited by hand into an invalid state | Loaded with problems like other files; a running webhook keeps its last valid rules. |

## Definition of Done

- Create a webhook, start it with a tunnel (downloading cloudflared on a fresh machine), receive requests from a real sender, reply through rules, and see the log after a restart, on Linux, macOS and Windows (CI green, smoke-tested).
- Coverage of at least 80% for Go and the frontend; `wails3 task lint` clean.
- Webhook request data never reaches workspace files, history or any service other than the sender's own reply.
- `docs/SMOKE-TEST.md` has a Webhooks section.
