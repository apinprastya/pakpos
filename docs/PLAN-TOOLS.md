# Pakpos — Tools Plan

Reference: [ARCHITECTURE.md](./ARCHITECTURE.md), [ROADMAP.md](./ROADMAP.md), [PLAN-TIER2.md](./PLAN-TIER2.md)

Developer utilities that today send people to other websites (jwt.io, base64
and timestamp converters), built into Pakpos. A token is often a credential,
so decoding it locally is safer than pasting it into a website.

## Scope

**In:**
- A tools area: an activity-rail view that lists the tools, and tool tabs that open next to request tabs
- A registry, so a new tool is one definition plus its own folder
- Palette actions for every tool
- JWT decoder: decode as you type, a claims summary (expiry, issued, not before), and signature verification
- Entry points from the request and response: the Bearer token field and the response body's context menu
- `{{variable}}` input for the JWT decoder, resolved through the send pipeline
- Six more tools on the same registry: Base64, URL encode/decode, hash and HMAC, timestamp converter, ID generator (UUID/ULID), JSON format/minify

**Out (later or separate plans):**
- JWT generator / signing as an auth type (Tier 3 "Advanced auth"; it reuses `core/jwtx` from this plan)
- Tools beyond the seven in this plan (e.g. regex tester, JSON diff, cron explainer); each is small enough to add without its own plan
- JWE (encrypted tokens): detected and reported, not decrypted

## Decisions

| Topic | Decision |
|---|---|
| Where tools live | A fourth activity-rail view, "Tools" (icon `Wrench`), below History. The sidebar lists every tool from the registry (name and a one-line description). Clicking a tool opens its tab. |
| Tab vs dialog | A tab. It can stay open next to the request whose token you're checking, and it uses the existing tab keys (Mod+W, switching, reordering). Dialogs block the request. |
| Tab model | `Tab.tool: { id: string; state: unknown } \| null`, next to `doc`. A tool tab has no `workspaceId` and no `parentId`: `syncTabs` skips it and it survives a workspace switch. Code that reads request fields checks `tab.doc` and `tab.tool` first, the same way it checks `doc` today. |
| One tab per tool | Opening a tool that already has a tab focuses that tab. An entry point that passes input (e.g. "Decode JWT") replaces the input of the existing tab instead of opening a second one. |
| Registry | `features/tools/registry.ts` exports `ToolDef[]`: `id`, `label`, `description`, `icon`, `keywords` (for the palette), `persist`, `component` (a `React.lazy` import), and `initialState()`. The sidebar, palette actions, tab title and tab icon all come from it. |
| Loading | Every tool is a lazy chunk, mounted when its tab opens and preloaded when the app is idle (`schedulePreload`), like the settings and code dialogs. |
| Persistence | Tool tabs are restored on start like other tabs. The tool's `state` is persisted to localStorage only when its `persist` flag is true. JWT has `persist: false`: a token is a credential, so the tab reopens empty. |
| Decoding | In TypeScript (`features/tools/jwt/jwt.ts`): base64url decode, JSON parse, claim analysis. It's pure and instant as you type, and needs no Go call. |
| Verification | In Go (`internal/core/jwtx`, bound through a thin `ToolService`). Algorithms: HS256/384/512, RS256/384/512, PS256/384/512, ES256/384/512, EdDSA. Keys: a shared secret (text or base64), a PEM public key or certificate, a JWK, or a JWKS URL. `alg: none` is reported as "Unsigned token", never as valid. |
| JWKS URL | Fetched by Go (HTTP never runs in the webview), using the app's TLS, proxy and timeout settings. The key is chosen by `kid`; with no `kid`, every key of a matching type is tried. Not cached across verifications. |
| Library | Prefer the standard library (`crypto/hmac`, `crypto/rsa`, `crypto/ecdsa`, `crypto/ed25519`) over a JWT dependency: verifying is short, and it keeps the license list unchanged. `golang-jwt/jwt` (MIT) is the fallback if signing in Tier 3 needs more. |
| Time claims | `exp`, `nbf` and `iat` are shown in local time plus relative time ("expires in 12 min", "expired 3 h ago"). Status colours: valid `text-status-ok`, expired or not yet valid `text-status-client`. No clock-skew allowance in the display; the exact second is shown. |
| Variable input | The token field is a `VarInput`. `{{access_token}}` resolves through `Session.Preview` with the active environment. A secret shows as "secret, not revealed" with a Reveal button (through `EnvService.RevealSecret`); the revealed value lives only in the tab's state and is never persisted. |
| Verification key input | A plain input, or a `VarInput` so a key can come from a secret variable. A key typed as a literal is never persisted (same rule as the token). |
| Entry points | (1) A "Decode" button next to the Bearer token field in the Auth tab (request, collection and folder). (2) "Decode JWT" in the response body's context menu (`BodyContextMenu`) when the selection, or the JSON string value under the cursor, looks like a JWT. (3) Palette action "Open JWT decoder". |
| What "looks like a JWT" means | Three base64url segments separated by dots, where the first decodes to a JSON object with an `alg` field. Five segments with `enc` is a JWE: shown as "Encrypted token (JWE), can't be decoded without the key". |
| Bad input | Each segment is checked on its own, and the error names the segment: "The payload isn't valid base64url." or "The header isn't JSON." Whitespace and a leading `Bearer ` are stripped before decoding. |
| Where each tool runs | TypeScript by default (instant, no Go call). Go (`ToolService`, logic in `internal/core/tools/…`) only when the browser can't do it or shouldn't: JWT verification, hash/HMAC (MD5 isn't in Web Crypto, and hashing a file needs its path), anything that touches the network. |
| Persistence per tool | `persist: true` for the timestamp converter, ID generator, URL tool and JSON tool (their state is rarely sensitive and handy to keep). `persist: false` for JWT, Base64 and hash/HMAC, whose input is often a credential or a key. |
| Common tool layout | Input on the left (or top in narrow windows), output on the right, a direction or mode switch in a small toolbar, and a Copy button on every output. Output updates as you type; no "Run" button except for work done in Go on a file. Inputs that can hold `{{vars}}` are `VarInput`s, resolved the same way as in the JWT decoder. |
| Input size | Text tools handle up to 10 MiB of input; above that they show "Input is too large for this tool" instead of freezing the UI. |
| Shortcut | None at first. The palette covers keyboard use; add one later if it gets used a lot (Mod+J is free). |

## Milestone 1 — Tools shell

1. `stores/layout.ts`: add `"tools"` to `SidebarView`; `ActivityRail` gets the Tools entry.
2. `features/tools/registry.ts`, `ToolsSidebar.tsx` (list with descriptions and an empty-input hint), `ToolTab.tsx` (looks up the def and mounts the lazy component, with a fallback for an unknown id from an old localStorage entry).
3. `stores/tabs.ts`: the `tool` field, `openTool(id, input?)`, `updateToolState(id, state)`, restore/persist following each tool's `persist` flag, `syncTabs` skipping tool tabs, titles from the registry.
4. Everything that branches on `tab.doc` (tab bar, save routing, close dialog, palette `enabled(ctx)`, environment switcher) handles tool tabs: they are never dirty and have no Save.
5. Palette: one "Open <tool>" action per registry entry (group "Tools").
6. Done when: open, focus-existing, close, restore after restart (state persisted only with `persist`), and workspace switch are covered by tests.

## Milestone 2 — JWT decoder (frontend)

1. `jwt.ts`: `decodeJwt(text)` returns header, payload, signature segment, algorithm, typed claim info (`exp`, `nbf`, `iat`, `iss`, `sub`, `aud`, `jti`) and per-segment errors; `looksLikeJwt(text)`. Table-driven tests, including JWE, `alg: none`, padding, non-object payloads and unicode claims.
2. `JwtTool.tsx`:
   - Left: the token input (`VarInput` / CodeMirror) with header, payload and signature segments coloured using `--syntax-*` tokens.
   - Right: header and payload in read-only `<CodeEditor>` (JSON), a claims table with time claims explained, and copy buttons.
   - Resizable split through `usePanelLayout("tool.jwt")`.
3. Variable input: preview resolution and the reveal flow for secrets.
4. Done when: decoding, errors, claims and variable input are tested; the copy follows the design voice; it works in light and dark themes.

## Milestone 3 — Signature verification (Go)

> `internal/core/jwtx` already exists (built in Tier 3 M7 for the JWT auth type): `Sign`, `Verify(token, Key) (Result, error)` with `Key{Kind: secret|pem|jwk|jwks, Data}`, `Result{Valid, Alg, Kid, Reason}`, `SecretKey(text, base64)`, `Algorithms()`, and tests for every algorithm, wrong keys, algorithm/key-family mismatches and `alg: none`. M3 only adds the JWKS fetch and `ToolService`.

1. `internal/core/jwtx`: `Verify(token, key Key) (Result, error)`, where `Key` is a secret, PEM, JWK or JWK set. `Result` holds `valid`, `alg`, `kid` and a reason ("Signature doesn't match", "Algorithm HS256 needs a shared secret, not a public key"). No Wails, no I/O.
2. `ToolService.VerifyJWT(ctx, req)`: resolves variables through the pipeline, fetches a JWKS URL through `httpexec` with the app settings, calls `jwtx.Verify`. Secrets in the request never come back in the result.
3. Frontend: a Signature section (algorithm read from the header, key-type select, key input, Verify button, result line). `api.ts` + `apiMock.ts` entries.
4. Done when: `jwtx` has golden tokens for every algorithm (generated in the tests with fresh keys), wrong-key, wrong-algorithm and `none` cases; `httptest.Server` serves a JWKS; an e2e test covers verify with a secret variable.

## Milestone 4 — Entry points

1. Auth tab: a "Decode" icon button (aria-label and tooltip) next to the Bearer token field, enabled when the field has a value. It opens the JWT tab with the field's text (a `{{var}}` stays a reference).
2. `BodyContextMenu`: "Decode JWT" when the selection or the string value under the cursor passes `looksLikeJwt`.
3. Done when: both entry points are tested with RTL, and an existing JWT tab gets its input replaced rather than a second tab opening.

## Milestone 5 — More tools

Each is a module under `features/tools/<id>/` (pure logic in a `.ts` file with table-driven tests, a thin component) plus one registry entry and palette action.

1. **Base64** (`base64`)
   - Encode and decode, standard and URL-safe alphabets, with or without padding. Decode accepts either alphabet, missing padding and line breaks.
   - Text is UTF-8. A decoded result that isn't valid UTF-8 is shown as hex with "Binary data (N bytes)" and a "Save to file…" button (through the existing save dialog).
   - Entry point: "Decode Base64" in `BodyContextMenu` for a selected string.
2. **URL encode/decode** (`url`)
   - Modes: component (`encodeURIComponent` rules), form (`application/x-www-form-urlencoded`, space as `+`), and full URL (encodes only what is invalid).
   - A "Parse URL" panel shows scheme, host, port, path and the query as a key/value table, using `src/lib/urlx.ts` so it matches how the request editor reads URLs. "Open as request" creates a new request tab from the URL.
3. **Hash and HMAC** (`hash`)
   - Algorithms: MD5, SHA-1, SHA-256, SHA-384, SHA-512 (MD5 and SHA-1 labelled "not secure, for checksums only").
   - Input: text or a file (picked with the open dialog; Go streams it, so large files are fine). HMAC mode adds a key (text, hex or base64; a `VarInput`, so it can be a secret variable).
   - Output in hex and base64. Computed in Go: `internal/core/tools/hashx`, `ToolService.Hash(ctx, req)`.
4. **Timestamp converter** (`timestamp`)
   - Input: Unix seconds, milliseconds, microseconds or nanoseconds (detected by size, with a manual override), RFC 3339 / ISO 8601, or RFC 1123 (the `Date` header format).
   - Output: all of those, plus local time, UTC and a relative time ("3 days ago"). A "Now" button. Time zone select (default: the system one).
   - Pure TS with `Intl`; tests pin the clock with `vi.useFakeTimers({ toFake: ["Date"], now })`.
5. **ID generator** (`ids`)
   - UUID v4, UUID v7 and ULID; count 1 to 1000; upper or lower case; with or without hyphens (UUID).
   - An "Inspect" field reads a pasted UUID or ULID: version, variant, and the embedded time for v7 and ULID.
   - Pure TS on `crypto.getRandomValues`, no new dependency. The ULID encoder is tested against values from Go's `oklog/ulid` so both sides agree.
6. **JSON format/minify** (`json`)
   - Format (2 or 4 spaces, or tabs), minify, sort keys, and escape/unescape a JSON string (for JSON embedded in a string field).
   - Errors give the line and column and the editor marks them. Large numbers keep their digits (no round trip through `Number`).
   - Entry point: "Open in JSON tool" in `BodyContextMenu`.
7. Done when: each tool's logic has table-driven tests (edge cases: empty input, invalid input, unicode, very large input), each component has RTL tests for its modes and copy, and `persist` is honoured per the Decisions table.

## Order and dependencies

```
M1 ── M2 ─┬─ M3
          ├─ M4
          └─ M5
```

M3, M4 and M5 are independent once the decoder exists. Within M5 the tools are independent of each other; hash and HMAC is the only one with Go work.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Tokens leaking to disk | `persist: false` for JWT; revealed secrets live only in tab state; tests assert nothing from a JWT tab reaches localStorage |
| Tool tabs breaking code that assumes request tabs | `tab.tool` sits beside `tab.doc`, so the same guards apply; grep every `tab.doc` check in M1 and add tests for tool tabs in the tab bar, palette and close flow |
| Algorithm confusion (HS256 verified with a public key as the secret) | The key type must match the algorithm family; a mismatch is a clear error, never a pass |
| JWKS URL hanging or huge | The app's request timeout and a size limit on the response (1 MiB) |
| Large input freezing the UI (JSON, Base64) | The 10 MiB limit; work is debounced while typing; hashing files runs in Go and streams |
| Two implementations drifting (ULID in TS and Go, URL parsing) | Shared test vectors between Go and TS, as `urlx` and `varTokens` already do |
| The rail growing too tall on small windows | Four views plus three bottom buttons fit in 600 px; revisit if more views are added |

## Definition of Done

- The Tools view, tool tabs, the JWT decoder and the six other tools work on the Linux, macOS and Windows builds (CI green).
- Coverage of at least 80% for Go and the frontend; `wails3 task lint` clean.
- Nothing typed into a tool with `persist: false` (JWT, Base64, hash and HMAC) is ever written to localStorage, SQLite or a workspace file.
- `docs/SMOKE-TEST.md` gains a Tools section: JWT (decode, verify with a secret and with a JWKS URL, both entry points) and one check per other tool (including hashing a large file).
