# Manual smoke test (Tiers 1 and 2)

Run before each release on **Linux, macOS and Windows**. Use a release build (`wails3 package` or a CI artifact), not `wails3 dev`.

To keep your real data safe, point the app at a scratch config folder. On Linux, use `XDG_CONFIG_HOME=$(mktemp -d) ./pakpos`. On macOS and Windows, back up `~/Library/Application Support/pakpos` or `%AppData%\pakpos` first.

A handy test server: `https://httpbin.org`. For offline testing, use `go run` on any small `net/http` server.

Copy the checklist per OS and tick as you go: `[ ]` → `[x]`.

## Install and first run

- [ ] The installer or package installs. On Linux, the AppImage runs, and the .deb and .rpm install.
- [ ] The app shows the Pakpos stamp icon in the menu or launcher, the dock or taskbar, and the window.
- [ ] On first launch, the sidebar shows "No workspace open" with Open folder and Create workspace.
- [ ] The response area says requests can be sent without a workspace.
- [ ] Settings → About shows the expected version, commit and OS/arch.

## Sending without a workspace

- [ ] `GET https://httpbin.org/get` with Ctrl/⌘+Enter shows 200, time and size.
- [ ] The request appears in History.
- [ ] Send turns into Cancel while a slow request runs (`https://httpbin.org/delay/5`). Cancel stops it, and no history entry is added.

## Request builder

- [ ] The method dropdown changes the method color in the URL bar and on the tab.
- [ ] Typing `?a=1&b=2` in the URL fills the Params table. Disabling a row removes it from the URL but keeps it in the table.
- [ ] `/users/:id` adds a path parameter, and its value is used when sending.
- [ ] Headers: add, disable and bulk-edit headers. The headers the app adds automatically are listed.
- [ ] Body:
  - [ ] Raw JSON, and Beautify formats it.
  - [ ] form-data with a text field and a file (`POST https://httpbin.org/post` echoes both).
  - [ ] x-www-form-urlencoded.
  - [ ] Binary file.
- [ ] Auth: Basic (`https://httpbin.org/basic-auth/u/p` → 200), Bearer (`/bearer`), and API key in a header and in the query.
- [ ] Tabs: Ctrl/⌘+T opens a new tab, Ctrl/⌘+W closes one. Closing an edited tab asks first. Tabs can be dragged to reorder.

## Response viewer

- [ ] JSON is pretty-printed with folding. Raw shows the response as received.
- [ ] Text in the response body selects and copies (Ctrl+C). Right-click a JSON field: Copy value, Copy key and Copy path copy that field; the path reads like `data.items[0].id`.
- [ ] Search in the body works. Copy works. Save to file writes the full body.
- [ ] Debug tab: send a request with a secret `{{token}}` in a header and a body; it shows the request line, every header (incl. Host, User-Agent, Content-Length), the body, and the response status and headers, with the secret as `[secret:token]` (an unresolved variable stays `{{name}}`). A redirecting URL shows one section per hop. A failed send (e.g. a closed port) offers "Show what was sent". A request opened from History says debug details aren't kept.
- [ ] HTML preview renders without running scripts (`https://httpbin.org/html`). Image preview works (`https://httpbin.org/image/png`).
- [ ] The Headers and Cookies tabs show counts (`https://httpbin.org/cookies/set?x=1`).
- [ ] Hovering the time shows the DNS, connect, TLS and TTFB breakdown.
- [ ] Compressed responses are decoded: `https://httpbin.org/gzip`, `/deflate` and `/brotli` each show readable JSON, and the Headers tab shows the `Content-Encoding`. Headers → "Added when sending" lists `Accept-Encoding: gzip, deflate, br`.
- [ ] A body over 10 MB shows the truncated notice, and saving writes the full file.
- [ ] Errors show a clear title and hint:
  - [ ] Unknown host.
  - [ ] Refused port (`http://localhost:1`).
  - [ ] Timeout: set it to 1 s and request `/delay/3`.
  - [ ] TLS error: `https://self-signed.badssl.com` offers "Open settings".

## Workspaces and collections

- [ ] Create a workspace in an empty folder. `pakpos.yaml` and `collections/` appear on disk.
- [ ] Create, rename and delete a collection. The confirm dialog for deleting a collection names its request count.
- [ ] Save an untitled request (Ctrl/⌘+S) into a collection. A YAML file appears.
- [ ] Rename, duplicate, move to another collection, and delete requests, from the context menu and with the keyboard (F2, Delete).
- [ ] Drag requests to reorder them and to move them between collections. The order survives a restart.
- [ ] Filter the tree by name, URL and method.
- [ ] External change: edit a request YAML in a text editor. A clean open tab reloads, and an edited tab keeps its edits with a notice.
- [ ] Break a YAML file by hand. The "file couldn't be loaded" notice lists it, and the rest of the tree still works.
- [ ] Switch workspace from the switcher. The recent list works, and Close workspace returns to the empty state.
- [ ] Cookies: `/cookies/set?x=1`, then `/cookies` shows x. After switching workspace and back, the cookies are gone.

## History

- [ ] Entries are grouped by day and show the method, URL, status and time.
- [ ] Search filters the list, and Load more pages through it.
- [ ] Clicking an entry opens it in a new tab with its stored response.
- [ ] Deleting one entry works. Clear history asks first, then empties the list.

## Settings (Ctrl/⌘+,)

- [ ] Theme: Light, Dark and Match system apply on save and persist after a restart. The theme menu in the rail also persists.
- [ ] Response position (below or beside) persists. The status bar toggle persists too.
- [ ] A timeout of 1 s makes `/delay/3` fail with a timeout. Turning off Follow redirects makes `/redirect/3` return 302.
- [ ] With Verify TLS certificates off, a warning shows and `https://self-signed.badssl.com` loads.
- [ ] Invalid input such as `abc` in Requests to keep shows an inline error and blocks saving.
- [ ] Lowering Requests to keep shows the "deletes older entries" note and trims history on save.
- [ ] Reset to defaults followed by Save restores the defaults. Cancel discards edits.

## Tier 2: folders and drag and drop

- [ ] Create folders inside a collection and inside other folders (menu and context menu). Folders start collapsed; the count shows the requests inside.
- [ ] Drag a request and a folder before, after and into another folder, across collections. A folder can't be dropped into itself. The order survives a restart, and `_folder.yaml` files appear on disk.
- [ ] Keyboard: ←/→ collapse and expand, Alt+↑/↓ reorders within a parent, F2 renames, Delete asks first (it counts the requests inside a folder). "Move to" lists nested folders.
- [ ] Rename and move a folder with a request open: the tab follows. Delete the folder: clean tabs close, edited ones are kept as drafts.
- [ ] Edit a nested request's YAML outside the app: the tree and a clean tab update.

## Tier 2: inheritance

- [ ] Collection settings (menu → Settings): set Bearer auth and a header. A request with "Inherit from parent" shows "Uses Bearer token from the collection …" in Auth and the header under Headers → Inherited, with a link to its source.
- [ ] A folder header with the same name replaces the collection's; a request header with the same name replaces both. `https://httpbin.org/headers` echoes what was actually sent.
- [ ] A new request saved into a collection defaults to "Inherit from parent". An unsaved draft opened with "New request" in a folder inherits too.

## Tier 2: environments and variables

- [ ] Create Dev and Prod environments in the Environments view with different `baseUrl` values. Switch between them from the switcher at the right of the tab bar: `{{baseUrl}}/get` goes to the right host. "No environment" leaves it unresolved, and the response notes the unresolved name.
- [ ] Globals: a global variable is used when no environment or collection defines it; an environment variable with the same name wins.
- [ ] Rename, duplicate, reorder (drag and Alt+↑/↓) and delete environments. The status bar shows the environment in use.
- [ ] Dynamic variables: `{{$guid}}`, `{{$timestamp}}` and `{{$randomInt}}` get fresh values on each send (`https://httpbin.org/anything?x={{$guid}}`).
- [ ] A loop (`a` = `{{b}}`, `b` = `{{a}}`) stops the send with a message naming the loop.

## Tier 2: secrets

- [ ] **With a keychain** (macOS, Windows, Linux with GNOME Keyring/KWallet): mark a variable secret and set its value. The YAML file has `secret: true` and no value; the keychain has an entry under `pakpos`. Settings → Secrets says it uses the keychain.
- [ ] **Without a keychain** (Linux: start it with `DBUS_SESSION_BUS_ADDRESS=` set to empty, or in a session without a Secret Service): the first secret asks for a master password (at least 8 characters). After a restart, the lock indicator in the status bar shows locked; sending a request that uses a secret says secrets are locked and offers Unlock. A wrong password says "Wrong password, or the secrets file is damaged." Change password and Reset secret store work.
- [ ] Reveal a secret value with the eye button; hiding it, changing the key or closing the tab forgets it. Rename a secret variable and save: the value is kept.
- [ ] Make a secret plain (confirm): the value is written to the file at once.
- [ ] A literal bearer token or basic password shows "This value is saved in the file as plain text. Move to secret variable"; moving it replaces the field with `{{name}}`.
- [ ] Clone the workspace folder to another place (or machine) and open it: secrets show "Not set on this machine", and nothing secret is in the files, `pakpos.db` or `bodies/` (`grep -r <value>`).

## Tier 2: variable editing

- [ ] `{{name}}` is highlighted as resolved, unresolved (dotted underline), dynamic, or a warning (wavy underline) when its value uses an undefined variable, in the URL bar, the body, header/param/form values, auth fields and variable values.
- [ ] Hovering a reference shows its value and scope (secrets masked); Ctrl/⌘+I shows the same at the cursor.
- [ ] Typing `{{` offers the visible variables with their scope, plus the dynamic ones. Enter accepts.
- [ ] A 200-row headers table stays responsive while typing.

## Tier 2: cURL and code generation

- [ ] Paste a "Copy as cURL (bash)" command from browser devtools into the URL bar: the tab becomes that request at once, the toast lists any warnings and Undo restores the previous request. Do the same with "Copy as cURL (cmd)" on Windows.
- [ ] Import cURL… (tab bar chevron, and "Import cURL here" on a folder) shows a live preview and imports into a new tab named like "POST /v2/orders".
- [ ] Copy as cURL (request menu and tree row) puts a working command on the clipboard; secrets are masked as `{{name}}`.
- [ ] Generate code (Ctrl/⌘+Shift+C): every language renders highlighted; "Resolve variables" and "Reveal secrets" change the code; Copy works; the chosen language is remembered. Run the generated cURL, Python and Node fetch code against httpbin.

## Tier 2: command palette and examples

- [ ] Ctrl/⌘+K opens the palette, also from inside an editor. Search finds requests (by name, folder path or URL), folders, collections, environments and examples; Enter opens and reveals the request in the tree. `>` lists actions with shortcuts; "Switch environment" and "Move to" have a second step; Backspace goes back. Recently used items come first.
- [ ] Send a request and "Save as example" from the response header. The Examples tab lists it; opening it shows it read-only under "Example: …" with "Back to last response". Rename and delete work.
- [ ] Examples follow the request when it is renamed, moved to another collection and reopened after a restart (`*.examples.yaml` moves along).
- [ ] With a secret bearer token, save an example of `https://httpbin.org/headers`: the warning names `{{token}}` and offers "Save with {{token}} instead"; the saved file holds `Bearer {{token}}`. With Basic auth and a secret password, `/headers` echoes only the base64 credentials: the warning names the password variable too.
- [ ] A response over 1 MB can't be saved as an example (the button says why).

## Tier 2: history per workspace

- [ ] History shows only the open workspace's sends, each with its environment name. Clear history names the workspace and leaves other workspaces' history alone. With no workspace open, only sends made without one are listed.
- [ ] History entries keep `{{variables}}` as written (open one: the URL still says `{{baseUrl}}`).

## Tier 3: network

Use `XDG_CONFIG_HOME` pointing at a temp dir. Tools: any local proxy (e.g. `mitmproxy`, `tinyproxy` or Squid with basic auth), and a test CA with server and client certificates (e.g. made with `openssl` or `mkcert`).

- [ ] Request Settings tab: a 1 s timeout on one request makes `/delay/3` time out while other requests still use the app timeout. Follow redirects Off on one request returns 302 for `/redirect/3`. Verify TLS Off on one request loads `https://self-signed.badssl.com` while the app setting stays on (another request to it still fails). The tab shows the number of overrides; "Use app settings for all" clears them. Saving a request with settings upgrades `pakpos.yaml` to `version: 3`.
- [ ] Import `curl -k -L --max-redirs 3 -m 2.5 https://example.com`: the Settings tab shows Verify TLS Off, Follow redirects On, 3 redirects, 2.5 s, with no warnings for those flags. Copy as cURL writes them back.
- [ ] Proxy: Custom `http://127.0.0.1:<port>` with a user name and password. Sends to http:// and https:// URLs go through the proxy (check its log); the password is not in `pakpos.db` (`grep -a` it). A wrong password gives "The proxy failed" with an Open settings action that lands on Network. A host in "Connect directly to" (e.g. `*.example.com`) bypasses the proxy.
- [ ] Proxy: System uses `HTTPS_PROXY`/`NO_PROXY` from the environment the app was started with; No proxy connects directly. A SOCKS5 proxy (`socks5://`) works.
- [ ] With the file secret store locked, a send through a proxy that needs a password asks to unlock (or says the store is locked); saving a proxy password from Settings asks for the master password first.
- [ ] CA certificates: a server signed by a private CA fails with "The secure connection failed" until the CA PEM is chosen in Network; a non-PEM file or a missing path is refused on save with a message naming the file.
- [ ] Client certificates (mTLS): a server that requires a client certificate fails with a message pointing to Network until a PEM certificate + key for its host is added; then it answers. Repeat with a PKCS#12 file: without the passphrase the error names the passphrase; after setting it, the send works. Removing the certificate deletes its passphrase from the keychain/secret file.
- [ ] Cookies: a response that sets a persistent cookie (`/cookies/set?x=1` on httpbin sets a session cookie; use a server sending `Max-Age`) shows it in Manage cookies (from the palette and from the response Cookies tab, which opens on that domain). After quitting and restarting, the persistent cookie is still sent and listed; a session cookie is gone.
- [ ] Cookie manager: add, edit (value, expiry, Include subdomains, SameSite), delete one, delete a domain and Delete all (with confirmation). An invalid name shows the error inline. Cookies are per workspace: another workspace starts without them, and nothing about cookies appears in the workspace files.

## Tier 3: scripting

Use `XDG_CONFIG_HOME` pointing at a temp dir and an environment `Dev` with a plain `token` variable.

- [ ] Token chaining: a "Login" request's Tests script `pm.environment.set("token", pm.response.json().token)` (or the "Set an environment variable from the JSON response" snippet); a second request sends `Authorization: Bearer {{token}}`. After Login, the second request sends the new token (check Debug); hovering `{{token}}` says "set by script"; the Dev variables show the row with "Set by script" and the value; the env file on disk is unchanged.
- [ ] Overlay: Reset on the row brings back the file's value; "Reset all script values" and the palette's "Reset script values" clear every one. "Persist to file" writes the value to the env file (and a new name as a new row); for a secret `token` it goes to the keychain/secret file (unlock asked first) and never into the file. Editing the row in the settings tab still shows the script value winning. Reopening the workspace or restarting clears the overlay.
- [ ] Scripts tab: Pre-request and Tests sub-tabs, `pm.` completions (`pm.response` only in Tests), Snippets (test-only snippets disabled in Pre-request with a reason), help text when empty, the dot on the tab, Save writes `scripts:` as a block in the YAML (manifest `version: 3`). A collection or folder with scripts shows "Runs before this request's script: …" with read-only copies and an "Open … settings" link. Collection and folder settings tabs have the same Scripts tab.
- [ ] Tests tab: "Tests 2/3" in amber with a failure, green when all pass; each test has its icon, name and error; All/Passed/Failed filter; a request without tests shows "Open tests", which switches to its Scripts tab.
- [ ] Console: `console.log/info/warn/error/debug` lines appear while sending (open with Mod+J or the status bar's Console, which counts new lines while closed), grouped under time, method, name and status, colored per level, with level filters, search, Copy line and Clear. Script output with a secret shows `[secret:name]`. Nothing survives a restart.
- [ ] Script error: `notDefined()` in a folder's pre-request script stops the send with "A pre-request script failed", the folder name and line:column, and "Open the pre-request script of folder …" opens that folder's Scripts tab; the error is in the console too. A `while(true){}` stops after the script timeout (Settings → Requests).
- [ ] Skip: `pm.execution.skipRequest()` shows "Skipped by a pre-request script (pm.execution.skipRequest)" and nothing is sent or added to history.
- [ ] Palette: "Open pre-request script", "Open tests", "Toggle console", "Clear console", "Reset script values".
- [ ] `pm.sendRequest`: the "Get a token with pm.sendRequest" snippet (pointed at a real token endpoint, client secret as a secret variable) sets `token` before the request goes out; the console shows `pm.sendRequest POST … → 200` and the secret only as `[secret:…]`; nothing extra appears in History. A callback form (`pm.sendRequest(url, (err, res) => …)`) works too, and an unreachable URL gives the callback an error. With Settings → Requests → "Scripts can send requests" off, the script fails with a message naming that setting.
- [ ] `pm.cookies`: after `https://httpbin.org/cookies/set?x=1`, a test `pm.expect(pm.cookies.get("x")).to.equal("1")` passes; `await pm.cookies.jar().set("https://httpbin.org/", "y", "2")` shows `y` in Manage cookies.

## Tier 3: collection runner

Use `XDG_CONFIG_HOME` pointing at a temp dir, a collection with Login (test script sets `token` in `Dev`, where `token` and `apiKey` are secret variables), Me (`Bearer {{token}}`, a test on the user) and Logout, and a `users.csv` with `user,password` and two rows.

- [ ] Entry points: the tree menu's "Run collection…"/"Run folder…", the settings tab's "Run collection…" button and the palette ("Run collection…", "Run folder…" with a step when there are several, "Open run history") all open one runner tab per target; the tab survives a restart with its configuration but no results.
- [ ] Configuration: the request checklist is in sidebar order (folders depth-first) with Select all/none; the environment defaults to the selected one; choosing `users.csv` shows its name, "2 rows", the columns and first rows, and disables Iterations ("One iteration per row"). A broken file (a CSV row with a missing field, a JSON object instead of an array) shows a clear message.
- [ ] Live run: Run collection shows the progress bar, "Iteration N of M · request", and rows with the method colour, status colour, time, size and tests x/y; Cancel stops it and keeps the rows. With reduced motion on, the progress bar doesn't animate.
- [ ] Results: the summary shows passed/failed/errors/skipped, duration and average time; Failed filters; a row expands to its tests, console and (with Save responses) the body. Console lines appear in the console drawer under headers with "Run … · Iteration N". Secret values read `[secret:name]` everywhere.
- [ ] Scripts: `pm.iterationData.get("user")` and `{{user}}` resolve per row; `pm.execution.setNextRequest("Logout")` skips ahead, `setNextRequest(null)` ends the iteration, a request setting itself as next forever stops after 1000 jumps with an error; `skipRequest` shows "Skipped".
- [ ] Options: "Stop at the first failure" ends the run at a failing test; "Keep variable values" off leaves the Dev rows without "Set by script" after the run; "Record in history" adds the sends to History (off: nothing added); a 1 s delay is visible between requests.
- [ ] Past runs: listed with time, environment and totals; opening one shows its results; delete removes it; only the last 20 are kept. Starting a second run in the same workspace while one runs says to wait or cancel.
- [ ] Export JSON and Export HTML save a report (the save dialog suggests `<name>-run-<date>.<ext>`); the HTML opens in a browser without network access, in light and dark; neither file contains the `apiKey` or token values.

## Tier 3: OAuth 2.0

Use `XDG_CONFIG_HOME` pointing at a temp dir and a real provider (e.g. an Auth0, Keycloak or Google test client) or a local server (Keycloak in Docker, or `go run` of a tiny wrapper around `internal/core/auth/oauth2/oauth2test`). Keep the client secret in a secret environment variable (`{{clientSecret}}`).

- [ ] Auth tab: "OAuth 2.0" is offered on requests, folders and collections; each grant shows only its fields; the callback help names the random-port loopback, and "Fixed URL" shows the URL with a Copy button and flags a non-loopback URL; a literal client secret or password is masked with "Move to secret variable".
- [ ] Authorization code + PKCE: "Get new access token" opens the system browser, the panel shows "Waiting for you to sign in…" with Copy the link and Cancel; after signing in the browser page says "You can close this window and return to Pakpos." (readable in light and dark), and the panel shows "Valid until … (in …)", the scope and "Can be refreshed". With a fixed port registered at the provider, the same works; with the port taken, the error says another program may be using it.
- [ ] Implicit (where the provider still allows it): the page posts the fragment back and the token arrives; the address bar no longer shows the token.
- [ ] Client credentials and password: a send with no token gets one automatically; "Get new access token" works without a browser.
- [ ] Sends: the token goes in `Authorization: Bearer …` (or the chosen prefix, or the query parameter); the Debug tab shows `[secret:oauth2AccessToken]`. A token expiring within 30 s is refreshed before the send (provider logs show a refresh_token grant); with auto refresh off an expired token fails with "has expired. Get a new access token…". A revoked refresh token fails the send with the provider's error and kind "The OAuth 2.0 token isn't usable".
- [ ] Inheritance: a request set to "Inherit from parent" under a collection with OAuth 2.0 shows the collection's token status read-only with a link to its settings, and sends with it. The palette's "Get new OAuth 2.0 token" works from a request with its own OAuth 2.0 auth and from collection/folder settings tabs.
- [ ] Refresh, Reveal (shows the token, Hide hides it), Clear (status goes back to "No access token yet."). With the file store locked, the panel says the store is locked and Unlock asks for the master password.
- [ ] Generate code / Copy as cURL show `{{oauth2AccessToken}}`; with "Reveal secrets" the code holds the token. History, the workspace files, saved examples (the save dialog names `oauth2AccessToken` if the API echoes it) and runner exports never contain the token or the client secret.
- [ ] Deleting the request, folder or collection removes its token from the keychain (check with the OS keychain tool); a duplicated request starts without a token.

## Tier 3: other auth

Use `XDG_CONFIG_HOME` pointing at a temp dir. Test servers: httpbin (`/digest-auth/auth/user/passwd/MD5` and `/SHA-256`), an AWS endpoint you own (e.g. `sts.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15`, region `us-east-1`, service `sts`, and an S3 `GET` on a test bucket), any JWT-verifying API (or jwt.io to check the token from the Debug tab), a Hawk server (`hawk` npm example server) and an IIS/Windows site with Windows authentication (NTLM). Keep every password and key in a secret variable.

- [ ] Auth tab: Digest auth, AWS Signature v4, JWT bearer, Hawk and NTLM are offered on requests, folders and collections; their fields load (briefly "Loading…" the first time) and each has help text; a literal password, secret key, session token, JWT key or Hawk key is masked with "Move to secret variable"; light and dark look right.
- [ ] Digest: the httpbin MD5 and SHA-256 endpoints answer 200; the Debug tab shows two exchanges (401 with the challenge, then the Digest header); a wrong password ends with the server's 401; "Hash the body too" works against a server offering auth-int.
- [ ] AWS SigV4: STS GetCallerIdentity answers 200 with your account; with temporary credentials the session token is sent (`X-Amz-Security-Token` reads `[secret:…]` in Debug); S3 GET works, and a PUT with "Don't sign the body" works too; a wrong secret key gives AWS's `SignatureDoesNotMatch`.
- [ ] JWT: HS256 with a text secret and with a base64 secret, RS256/ES256 with a pasted PEM (one line is fine) verify at the server or on jwt.io; iat/exp/jti appear as set; query placement sends `?token=` (or the chosen name); a broken payload JSON fails with "The auth couldn't be applied… Check the Auth tab." and the "Open the Auth tab" button opens the tab.
- [ ] Hawk: the example server accepts the request, with and without a payload hash; each send has a new nonce.
- [ ] NTLM: the IIS site answers 200 with `DOMAIN` + user + password; Debug shows two exchanges on the same connection (the second "reused"); two sends at once both succeed; a wrong password ends with 401.
- [ ] Inheritance: each type set on a collection is used by an inheriting request.
- [ ] Copy as cURL writes `--digest`, `--ntlm` or `--aws-sigv4 aws:amz:<region>:<service>` with `-u` (secrets as `{{name}}` unless revealed) and runs with real curl once revealed; Python shows `HTTPDigestAuth`, PHP `CURLAUTH_DIGEST`/`CURLAUTH_NTLM`; other languages show computed SigV4/JWT/Hawk headers with a "valid for about 5 minutes"/"signed now" warning, or a warning that Digest/NTLM was left out. Importing those cURL commands gives the matching auth type.
- [ ] No password, key or token appears in the workspace files (secret variables used), history, `pakpos.db`, runner exports or the Debug tab.

## Webhooks

Run on each OS. Start on a machine (or in an `XDG_CONFIG_HOME`) without cloudflared on the PATH.

- [ ] The Webhooks view (rail icon above Tools) says "No webhooks yet"; **Create webhook** adds `webhooks/new-webhook.yaml` to the workspace and opens its tab in rename mode.
- [ ] **Start** (with tunnel) shows "Pakpos needs cloudflared…"; **Download cloudflared** shows progress and **Cancel** stops it; downloading again installs it into `<config>/pakpos/bin/` and the webhook starts by itself: "Starting the public tunnel…", then a `https://….trycloudflare.com` URL. Settings → Webhooks shows the path, version and "Downloaded by Pakpos".
- [ ] `curl -X POST <public URL>/stripe/events -H 'Content-Type: application/json' -d '{"type":"payment_intent.payment_failed","data":{"id":"pi_1"}}'` gets `{"ok": true}`; the request appears in the log at once, with headers (Host is the tunnel host), body, the sender's IP and "with the default response".
- [ ] A real sender (Stripe CLI `stripe trigger`, a GitHub repository webhook, or webhook.site's "send test") reaches the URL and is logged.
- [ ] **Create rule** on that request opens Rules with POST and the exact path; add a JSON condition `type equals payment_intent.payment_failed`, status 400, body `{"error": "declined", "id": "{{$request.json.data.id}}"}`, Save: the next curl gets 400 with `"id": "pi_1"`, and the log says "by rule …". A delay of 3000 ms delays the reply. Disabling the rule restores the default response.
- [ ] A bad regex or a path without `/` refuses to save, with the message on the rule and the field marked.
- [ ] **Copy as cURL** replays the request; **Open as request** opens a draft tab with the method, URL, headers and body.
- [ ] **Start local only** gives `http://127.0.0.1:<port>`, reachable from the same machine only.
- [ ] Switch to another workspace: the webhook keeps answering and logging; the view lists it under "Running in other workspaces" (Copy URL, Open log read-only, Stop); the rail icon shows a dot.
- [ ] Quit and restart: nothing is running, the log is still there; **Clear log** empties it; deleting the webhook removes its file and log.
- [ ] Settings → Webhooks → **Choose file…** with a non-cloudflared file is refused; choosing a real cloudflared shows "Chosen by you"; saving other settings afterwards keeps it; **Find it automatically** clears it.
- [ ] Windows: no console window opens next to the app while the tunnel runs; Task Manager shows `cloudflared.exe` gone after Stop and after quitting.

## Postman import

Needs a Postman account with a collection that has folders, examples, scripts, collection variables and auth, plus an environment with a secret variable. Export the collection as Collection v2.1, the environment, and the globals.

- [ ] The Collections header's **Import from Postman** button, the "No collections yet" state and the palette's "Import from Postman…" open the dialog; **Choose file…** opens the system file dialog.
- [ ] The collection's preview names it, counts requests, folders, examples and variables, and lists what won't work (e.g. a script with `pm.visualizer`, `{{$randomEmail}}`); **Import** adds the collection, reveals it in the sidebar, and the tree matches Postman's order.
- [ ] Opening imported requests shows the same URL, params (disabled ones too), path variables, headers, body, auth (inherited where Postman inherited) and scripts; examples are listed and open; sending one with the imported environment selected works like in Postman.
- [ ] The environment import opens its tab; the secret variable shows as set, and its value appears in no workspace file (`grep -r <value> <workspace>`). With "Keep credentials in the secret store" on, a `token` variable is secret too; off, the preview warns about it.
- [ ] With the secret store locked (file store), importing an environment with a secret asks to unlock first; cancelling leaves nothing imported.
- [ ] Globals import lists the keys it replaces and opens the Globals tab with the merged values.
- [ ] A v1 collection, a data dump, a non-JSON file and a JSON file that isn't a Postman export each show a sentence saying what to do; nothing is added.

## Postman export

- [ ] Collection menu (tree right-click, or the collection settings tab's More menu) → **Export to Postman…** suggests `<Name>.postman_collection.json`; the file imports into Postman (v2.1) with folders, requests, examples, scripts, auth and collection variables. Folders have no export entry.
- [ ] A collection with collection/folder headers, a secret variable, a form-data file or a per-request timeout shows a warning toast listing what to check in Postman.
- [ ] Environment row menu, the environment tab's More menu and the Globals tab's More menu export environment/globals files that Postman imports. Secret variables arrive with type secret and no value; no secret value appears anywhere in the file.
- [ ] Cancelling the save dialog shows nothing; the palette's "Export collection/environment/globals to Postman…" use the active tab's target (or the selected environment).
- [ ] An exported collection imports back into Pakpos (Import from Postman) as a working copy.

## In-app updates

Needs an older published release installed and a newer one published (stable, with `SHA256SUMS.sig`).

- [ ] About ten seconds after start, a toast says the new version is available; **View update** opens the dialog with the release notes. The status bar shows **Update available**.
- [ ] **Download and install** shows progress; **Cancel download** stops it and leaves the installed app alone. Installing again finishes, and **Restart now** starts the new version with open tabs and drafts kept (Settings → About shows the new version).
- [ ] Per OS: the AppImage, the per-user Windows install, the portable `pakpos.exe` and `pakpos.app` in /Applications update in place. A `.deb`/`.rpm` install only offers the release page, with a note to use the package manager.
- [ ] **Skip this version** stops the toast and the status bar notice for that version; "Check for updates" in the palette still shows it.
- [ ] With "Check for updates automatically" off (Settings → About), nothing is checked at startup. Offline, a manual check says it couldn't check and offers **Try again**.

## Platform specifics

- [ ] **Linux:** the app appears under Development in the application menu (.desktop categories), and WebKitGTK renders fonts and editors correctly.
- [ ] **macOS:** the app opens from the zip after you allow it in Privacy & Security (it's unsigned). ⌘ shortcuts work. Quitting with the last window closed works.
- [ ] **macOS:** there's no title bar. The close, minimise and zoom buttons sit in the empty top-left header cell, clear of the logo and the workspace switcher. Dragging that cell or the empty part of the tab bar moves the window; a double click there zooms it; tabs and buttons in the tab bar still click and reorder. Check both themes.
- [ ] **Windows:** the installer creates a Start menu entry and installs WebView2 if it's missing. Ctrl shortcuts work, and the uninstaller removes the app.
