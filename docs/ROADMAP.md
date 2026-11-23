# Pakpos — Roadmap

Pakpos is a desktop REST API client (REST only). Features ship in tiers; each
tier gets its own plan document (`docs/PLAN-TIER<N>.md`) before work starts.

| Tier | Theme | Status |
|---|---|---|
| 1 | MVP: build, send, save, history | **Done** ([plan](PLAN-TIER1.md); see its carry-over lists) |
| 2 | Core productivity: collections, environments, variables | **Done** ([plan](PLAN-TIER2.md); see its "Definition of Done — what's left" and carry-over lists) |
| 3 | Power features: scripting, runner, advanced auth & network | **Done in code** ([plan](PLAN-TIER3.md)); left: the first release run, smoke tests on Linux/macOS/Windows, signing (see its "Definition of Done — what's left") |
| 4 | Nice-to-have | Later |

In-app updates (signed `SHA256SUMS`, as in Lontar) were pulled forward from
Tier 4 and are done.

The webhook test server (public URL through a Cloudflare quick tunnel, request
log, response rules) has its own plan, [PLAN-WEBHOOKS.md](PLAN-WEBHOOKS.md),
and is done in code; its smoke tests are in [SMOKE-TEST.md](SMOKE-TEST.md).

Importing from Postman (collections v2.0/v2.1, environments, globals) has
its own plan, [PLAN-POSTMAN.md](PLAN-POSTMAN.md), and is done in code; its
smoke tests are in [SMOKE-TEST.md](SMOKE-TEST.md).

Non-REST protocols (GraphQL, gRPC, WebSocket) are not planned.

---

## Tier 1 — MVP ✅

- **Request builder:**
  - Methods: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS.
  - URL ↔ query params sync, and path variables (`/users/:id`).
  - Headers, with enable toggles.
  - Body: none, raw (JSON, XML, Text, HTML, JavaScript), form-data with files, urlencoded, binary.
  - Send / Cancel.
- **Response viewer:**
  - Status, time (with phase breakdown), size.
  - Pretty, Raw and Preview views; headers; cookies.
  - Search, copy, save to file.
- **Auth:** None, Basic, Bearer, API Key (header or query).
- **Persistence:** workspaces as folders of YAML files (one request per file), flat collections, history in SQLite.
- **Shell:** tabs, keyboard shortcuts, light/dark theme, resizable panes, settings dialog.
- **Release:** CalVer releases for Linux, Windows and macOS, and CI.

## Tier 2 — Core productivity ✅

**Collections**
- Nested folders inside collections.
- Collection- and folder-level auth and headers that requests inherit
  (`auth.type: inherit` already exists in the file format).
- Drag and drop across folder levels.

**Environments and variables**
- Multiple environments (Dev, Staging, Prod) with a quick switcher.
- Variable scopes: global, collection, environment, local, resolved in that order.
- `{{variable}}` substitution in URL, params, headers, body and auth.
- `{{variable}}` highlighting, hover preview and autocomplete in the editors.
- Secret variables stored in the OS keychain (`zalando/go-keyring`), or in a
  file encrypted with a master password when no keychain is available. The
  YAML files hold only references, so committing them is safe.
- Dynamic variables: `{{$guid}}`, `{{$timestamp}}`, `{{$randomInt}}`.

**Import and export**
- Import a request from cURL (paste a `curl …` command).
- Copy a request as cURL.
- Code generation: cURL, JavaScript (fetch / axios), Python (requests), Go,
  Java, PHP.
- Not in this tier: Postman collections (since done separately, see
  PLAN-POSTMAN.md). OpenAPI and HAR import are deferred to Tier 4.

**UX**
- Command palette (requests, collections, actions).
- Saved response examples per request (also the basis for the Tier 4 mock server).

**Carried over from Tier 1**
- History filtered and cleared per workspace.
- deflate/brotli decompression (moved from Tier 3).
- CI on GitHub for Linux, macOS and Windows (the first release run is still to do).
- Code-split CodeMirror languages and rarely used dialogs.

## Tier 3 — Power features ✅ (code; release run and smoke tests pending)

Carried over from Tier 2 (see PLAN-TIER2.md for the full lists):
- Pruning orphaned secret values (e.g. after edits made while the store was locked).
- Showing inherited headers that a request overrides; renaming from settings tabs.
- First `release.yml` run (pre-release tag) and the manual smoke test on macOS and Windows.

**Scripting (goja, in the Go backend)**
- Pre-request and post-response (test) scripts in JavaScript, sandboxed with
  a timeout and no file or network access.
- A `pm`-like API:
  - Variables: `pm.environment`, `pm.variables`.
  - Request and response: `pm.request`, `pm.response.json()`.
  - Assertions: `pm.test`, `pm.expect`.
- Test results panel, plus a console for logs and raw request/response.

**Collection runner**
- Run a collection or folder in order, with iterations and a delay between requests.
- Data-driven runs from a CSV or JSON file.
- Run summary report.

**Advanced auth**
- OAuth 2.0 with token refresh. Flows: Authorization Code with PKCE, Client
  Credentials, Password, Implicit.
- Digest, AWS Signature v4, NTLM, Hawk, JWT generator.

**Network**
- Cookie jar manager: view, edit and delete cookies per domain.
- Client certificates (mTLS) and a custom CA bundle.
- Proxy (system or custom, HTTP/SOCKS).
- Per-request overrides for timeout, redirects and TLS verification.

## Tier 4 — Nice-to-have

Moved here from Tier 3 (see PLAN-TIER3.md for the reasons):
- `pm.sendRequest`, `pm.cookies`, `pm.request.auth`, bundled script libraries.
- OAuth 2.0 device code, client assertion (private_key_jwt), OpenID discovery, token revocation.
- OS proxy settings (macOS/Windows system proxy, PAC files); encrypted PEM keys.
- Showing OAuth 2.0 token endpoint exchanges in the Debug tab.
- Hawk server authorization (response `Server-Authorization` check); NTLMv1 and Kerberos/Negotiate.

- Headless CLI runner (`pakpos run`) for CI, with JUnit and HTML reports. The
  core packages are already free of Wails code so it can reuse them.
- Mock server generated from saved examples.
- Auto-generated documentation from collections.
- Response diff between two runs or history entries.
- JSONPath / JMESPath filter on responses.
- Response validation against JSON Schema or OpenAPI.
- OpenAPI 3.x and HAR import.
- Team sharing and sync. This needs a backend and is the largest item; git
  workspaces already cover basic sharing.

---

## Working agreements

- Plan each tier in `docs/PLAN-TIER<N>.md` as milestones with done criteria,
  following [ARCHITECTURE.md](ARCHITECTURE.md) and [AGENTS.md](../AGENTS.md).
- New code keeps at least 80% test coverage (Go, frontend, `tools/`).
- Workspace file format changes must be backward compatible, or come with a
  migration.
