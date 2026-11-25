# pm.sendRequest and pm.cookies

Scripts imported from Postman most often fail on these two APIs (fetching a
token in a pre-request script, checking a session cookie in a test). This
plan adds both, plus the async pieces they need (promises, top-level
`await`, async `pm.test`). It was a Tier 4 item (ROADMAP).

## Decisions

| Topic | Decision |
|---|---|
| Where requests run | In Go, through the same `httpexec.Executor` as normal sends: app network settings (proxy, CA, client certificates, TLS, redirects, request timeout) and the workspace's cookie jar. The `script` package stays I/O-free: it calls the `script.HTTP` and `script.Cookies` interfaces; `pipeline` implements them (`scriptHTTP`, `scriptCookies`). |
| Blocking | `pm.sendRequest` blocks the script while the request runs (goja is single-threaded). Its time counts against the script timeout; a timeout during a request stops the request too and the message says "(it was waiting for pm.sendRequest)". |
| Callback order | The callback runs after the script's own code and its promise jobs (Go calls the prelude's `drain` until nothing is pending), like Postman's event loop. Callbacks may send more requests. An exception in a callback fails the script with its line:column. |
| Promises | Without a callback, `pm.sendRequest` and the jar methods return a promise. A script that only parses inside an async function (top-level `await`) is wrapped in `(async () => {` … `})()` on its first line, so line numbers stay; first-line columns are shifted back. A rejected promise nobody handles fails the script (goja's rejection tracker), with the position from the error's stack. `pm.test` with an async function records its result when the promise settles. |
| Request shape | A URL string, or Postman's `{url (string or {raw}), method, header (list, "K: V" strings or an object), body, auth}`. Bodies: `raw` (language from `options.raw.language`, default text), `urlencoded`, `formdata` (text fields only; file fields refused), `graphql` (sent as JSON). Auth: `basic`, `bearer`, `apikey`, `noauth` (Postman's list-of-{key,value} or object params). Other modes/auth types throw with what to do instead. |
| Variables | `{{variables}}` in the URL, headers, body and auth resolve from the send's current scopes (including values earlier scripts set and secrets), like `pm.variables.replaceIn`. |
| Response | The same object as `pm.response` (`code`, `status`, `headers`, `text()`, `json()`, `responseTime`, `responseSize`, `.to` assertions). A body spilled to a temp file is read (up to `MaxScriptBody`) and the file removed. |
| What is recorded | Nothing in history or debug hops. Each request adds a console line (`pm.sendRequest POST <url as written> → 200 OK (12 ms)`, or a warning when it fails), masked like all script output. Error messages handed to the script are masked. |
| Limits | `script.MaxRequests` (50) per send (the `Budget` is shared by all scripts of a send). |
| Setting | Settings → Requests → "Scripts can send requests" (`scriptRequests`, on by default as in Postman; stored settings without the key keep it on). Off, `pm.sendRequest` fails with `pipeline.MsgScriptRequestsOff`. It exists because scripts can read secret values, and network access lets an untrusted (e.g. imported) script send them elsewhere. |
| pm.cookies | The cookies a request to the current `pm.request.url` sends (in a test script, including those the response set): `get`, `has(name, value?)`, `all`, `count`, `each`, `toObject`. `pm.cookies.jar()` has `get(url, name)`, `getAll(url)`, `set(url, name, value)` / `set(url, {name, value, domain, path, expires, maxAge, secure, httpOnly})`, `unset(url, name)`, `clear(url)`, each with an optional callback `(err, value)` or a promise. No domain allow-list (Postman has one): the jar is local to the workspace and requests could carry the cookies anyway. |
| Jar rules | `cookies.Jar.ForURL`, `SetForURL` (Set-Cookie rules: no Domain = host-only, a domain the host isn't in or a public suffix is refused; the manager's name/value checks), `DeleteForURL(u, name)` (name "" = every cookie sent to u). URLs resolve `{{variables}}` and get `http://` when they have no scheme. |
| Postman import | `pm.sendRequest` and `pm.cookies` are no longer named in the import warning. |

## Progress

- [x] `core/cookies`: `ForURL`, `SetForURL`, `DeleteForURL` (`TestURLHelpers`).
- [x] `core/script`: `HTTP`/`Cookies` interfaces, prelude `sendRequest`, `cookies`, `settle`/`drain`, async `pm.test`, top-level await, rejection tracking (`network_test.go`).
- [x] `pipeline`: `ScriptOptions.Executor/RequestsOff/Jar`, `scriptHTTP`, `scriptCookies` (`sendrequest_test.go`, real HTTP server).
- [x] Services and runner pass the executor, jar and setting; `settings.ScriptRequests`.
- [x] e2e: `service/e2e_sendrequest_test.go` (token fetch with a secret, cookie check, runner, setting off).
- [x] Frontend: the setting's switch, `pm.sendRequest`/`pm.cookies`/jar completions (`pmApi.ts`), snippets "Get a token with pm.sendRequest" and "Response set a cookie".

## Left for later

- `pm.request.auth`, bundled libraries (CryptoJS, lodash, moment…), `pm.vault`, `pm.visualizer`.
- Showing script requests in the Debug tab.
- Running several `pm.sendRequest` calls concurrently (they run one after another).
