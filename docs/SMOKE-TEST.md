# Manual smoke test (Tier 1)

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

## Platform specifics

- [ ] **Linux:** the app appears under Development in the application menu (.desktop categories), and WebKitGTK renders fonts and editors correctly.
- [ ] **macOS:** the app opens from the zip after you allow it in Privacy & Security (it's unsigned). ⌘ shortcuts work. Quitting with the last window closed works.
- [ ] **Windows:** the installer creates a Start menu entry and installs WebView2 if it's missing. Ctrl shortcuts work, and the uninstaller removes the app.
