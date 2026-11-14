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
- [ ] Search in the body works. Copy works. Save to file writes the full body.
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
- [ ] **Windows:** the installer creates a Start menu entry and installs WebView2 if it's missing. Ctrl shortcuts work, and the uninstaller removes the app.
