# Pakpos

[![CI](https://github.com/apinprastya/pakpos/actions/workflows/ci.yml/badge.svg)](https://github.com/apinprastya/pakpos/actions/workflows/ci.yml)

Pakpos is a desktop REST API client for Linux, macOS and Windows, built with Go, Wails v3 and React/TypeScript.

- Requests live in your own folder as one YAML file each, so you can commit them to git.
- Requests are sent from Go, so there are no CORS limits.
- History, settings and recent workspaces are kept locally in SQLite.

## Features

- **Requests:** GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS; query and path parameters synced with the URL; headers; raw (JSON, XML, HTML, JavaScript, text), form-data with files, urlencoded and binary bodies; Basic, Bearer and API key auth.
- **Responses:** status, timing breakdown and size; pretty, raw and preview views; headers and cookies; search, copy and save to file; gzip, deflate and brotli decoded.
- **Collections:** nested folders with drag and drop; auth and headers set on a collection or folder are inherited by the requests inside.
- **Environments and variables:** Dev/Staging/Prod environments with a quick switcher, globals and collection variables, `{{variable}}` substitution everywhere, dynamic variables (`{{$guid}}`, `{{$timestamp}}`…), and highlighting, hover and autocomplete in every editor.
- **Secrets:** secret variables live in the OS keychain, or in a file encrypted with a master password where there is none. Workspace files only name them, so they're safe to commit.
- **cURL and code:** paste a `curl` command into the URL bar or import one; copy any request as cURL; generate code for cURL, JavaScript (fetch, axios), Python (requests), Go, Java and PHP.
- **Command palette** (Ctrl/⌘+K) for requests, folders, environments, examples and actions.
- **Saved examples** of responses per request, checked for echoed secrets before they're written.
- **History** per workspace, with the environment each request was sent in.
- **Updates:** checks GitHub for a new release at startup and once a day (Settings → About turns it off), then downloads, verifies and installs it when you ask.

See [docs/ROADMAP.md](docs/ROADMAP.md) (feature tiers), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), the plans [docs/PLAN-TIER1.md](docs/PLAN-TIER1.md) and [docs/PLAN-TIER2.md](docs/PLAN-TIER2.md), and the release checklist [docs/SMOKE-TEST.md](docs/SMOKE-TEST.md).

## Install

Download the build for your OS from the [releases page](https://github.com/apinprastya/pakpos/releases):

| OS | File | Notes |
|---|---|---|
| Linux | `pakpos-<version>-linux-x86_64.AppImage` | `chmod +x` and run. Needs no install. |
| Debian/Ubuntu | `pakpos-<version>-linux-amd64.deb` | `sudo apt install ./pakpos-*.deb`. Needs GTK 4 and WebKitGTK 6.0. |
| Fedora/RHEL | `pakpos-<version>-linux-x86_64.rpm` | `sudo dnf install ./pakpos-*.rpm` |
| macOS | `pakpos-<version>-macos-universal.dmg` | Universal (Apple silicon and Intel), macOS 12+. Unless the release was signed and notarized: right-click → Open the first time, or allow it in Privacy & Security. |
| Windows | `pakpos-<version>-windows-amd64-setup.exe` | Per-user install, no admin prompt. Installs WebView2 if it's missing. A portable `…-windows-amd64-portable.zip` is also attached. |

Versions are calendar-based, `vYY.MM.MICRO` (e.g. `v26.11.1`). Every release lists `SHA256SUMS` for its files.

**Updating.** The AppImage, the Windows build (installer or portable) and the
macOS app update themselves: Pakpos looks for a new stable release at startup
and once a day (turn this off in Settings → About; "Check for updates" in the
command palette checks at any time), and installs it when you choose
**Download and install**, then **Restart now**. It installs only files whose
checksums are signed with Pakpos's release key. The `.deb` and `.rpm`
packages are updated with your package manager, and a machine-wide Windows
install (Program Files) from the release page.

App data (history, settings, and `secrets.enc` when there is no keychain) lives in `<user config dir>/pakpos`:
- Linux: `~/.config/pakpos`
- macOS: `~/Library/Application Support/pakpos`
- Windows: `%AppData%\pakpos`

## Develop

Requirements:

- Go 1.26+
- Node 24+ with npm
- Wails CLI v3: `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0`
- Linux: `sudo apt install build-essential pkg-config libgtk-4-dev libwebkitgtk-6.0-dev`. `wails3 doctor` checks the rest.

Tasks run through Wails' bundled task runner, `wails3 task <name>`.

| Command | What it does |
|---|---|
| `wails3 dev` | Run the app with hot reload |
| `wails3 build` | Production build to `bin/pakpos` |
| `wails3 task test` | Go and frontend tests |
| `wails3 task coverage` | Tests with coverage gates (≥ 80%) |
| `wails3 task lint` | gofmt, go vet, golangci-lint, tsc, ESLint, Prettier. Uses an installed golangci-lint, or the pinned version through `go run`. |

Frontend only (from `frontend/`): `npm run dev`, `npm test`, `npm run coverage`, `npm run lint`.

To run the app without touching your real data: `XDG_CONFIG_HOME=$(mktemp -d) ./bin/pakpos` (Linux).

## Build and package

```sh
wails3 build          # production binary in bin/ (version-stamped)
wails3 task version   # the version builds are stamped with
```

### Versioning

Every build and package task stamps the same version (`VERSION` in the root
`Taskfile.yml`) into the Go binary (`-ldflags -X
pakpos/internal/buildinfo.Version=…`, shown in Settings → About), the macOS
`Info.plist`, the Windows VERSIONINFO resource and installer, and the
`.deb`/`.rpm` metadata. It comes from:

1. `PAKPOS_VERSION` if set (a leading `v` is dropped), e.g.
   `PAKPOS_VERSION=v26.11.1 wails3 task package:linux`; otherwise
2. `git describe --tags --always --dirty`: tag `v26.11.1` → `26.11.1`,
   `v26.11.1-4-gabc1234` → `26.11.1-4-gabc1234`, an untagged commit →
   `0.0.0-dev+<hash>[-dirty]`; otherwise
3. `0.0.0-dev` (no git), which is also the default of a plain `go build`.

Fields that only take numbers (`CFBundleVersion`, Windows file version, NSIS)
get the `X.Y.Z` core. `build/config.yml`'s `version` is only a baseline.

### Building packages

Packages are built natively on each OS (the release workflow does this on
GitHub's runners). Output goes to `bin/`.

| Task | Host | Output | Extra tools |
|---|---|---|---|
| `wails3 task package:linux` | Linux | `pakpos-x86_64.AppImage`, `pakpos.deb`, `pakpos.rpm`, `pakpos.pkg.tar.zst` | none: nfpm is built into `wails3`; the AppImage step downloads linuxdeploy (internet). |
| `wails3 task package:windows` | Windows (or Linux with `GOOS=windows`) | `pakpos-amd64-installer.exe` | [NSIS](https://nsis.sourceforge.io) `makensis` on `PATH`; the WebView2 bootstrapper is downloaded. `INSTALL_SCOPE=machine` builds a per-machine (Program Files, UAC) installer instead of the default per-user one. |
| `wails3 task package:darwin` | macOS | universal `pakpos.app` + `pakpos.dmg` | Xcode command line tools. The app is ad-hoc signed only. |

`GOOS=windows wails3 build` cross-compiles `bin/pakpos.exe` (with icon,
manifest and version resource) from Linux or macOS, since the Windows build
needs no cgo. The macOS and Linux GUI builds need cgo and so their own OS (or
the `wails3 task setup:docker` cross-compile image).

Identity (name, publisher `Pakpos contributors`, bundle id `dev.pakpos.app`,
description, copyright) is set in `build/config.yml`. After changing it run
`wails3 task common:update:build-assets`, then re-apply what that command
overwrites from the Wails templates: `build/linux/nfpm/nfpm.yaml` (Pakpos's
dependencies, icons, `Apache-2.0` license and the LICENSE/NOTICE files) and
the hand-added keys in `build/darwin/Info*.plist` (the comment block,
`LSApplicationCategoryType`, `LSMinimumSystemVersion` 12.0, the boolean
`NSHighResolutionCapable`, and `CFBundleDisplayName` "Pakpos"); restore
`build/darwin/entitlements.plist`, which it deletes; delete the `build/ios`
files it recreates (unused).

The app icon source is `build/appicon.svg`. Re-render `build/appicon.png`
(1024 px) from it, then run `wails3 task common:generate:icons`.

## Releasing

Releases use calendar versioning: **`vYY.MM.MICRO`**, with the two-digit
year, the month without a leading zero, and a counter that restarts at 1 every
month (`v26.11.1`, `v26.11.2`, `v26.12.1`). A pre-release adds a suffix,
`v26.11.3-rc.1`; it does not use up its number, so `v26.11.3` follows it.
`tools/calver` checks the format; tags in any other format fail the release.

1. Make sure CI is green on `main`.
2. Tag and push the next version:
   ```sh
   git fetch --tags
   wails3 task release:next          # e.g. 26.11.2
   git tag v26.11.2 && git push origin v26.11.2
   ```
3. `.github/workflows/release.yml` checks the version, runs the short tests
   on Linux, Windows and macOS, builds every package stamped with `26.11.2`,
   signs what it has secrets for, and creates a **draft** GitHub Release with
   the files and `SHA256SUMS` (versions with a `-` are marked pre-release).
4. Run [docs/SMOKE-TEST.md](docs/SMOKE-TEST.md) on each OS against the
   draft's files, then publish the draft.

The workflow can also be started by hand (**Actions → Release → Run
workflow**). If you leave the version empty, it uses the next number for the
current month (UTC), based on the existing tags and releases. You can also
enter a version such as `26.11.2-rc.1`. The draft targets the dispatched
commit, with tag `v<version>`. The run fails if that tag or a release (even a
draft) for it already exists, so publish or delete a draft before starting
another run. `wails3 task release:checksums DIR=dist` writes the same
`SHA256SUMS` locally.

Release files are named `pakpos-<version>-linux-x86_64.AppImage`,
`pakpos-<version>-linux-amd64.deb`, `pakpos-<version>-linux-x86_64.rpm`,
`pakpos-<version>-windows-amd64-setup.exe`,
`pakpos-<version>-windows-amd64-portable.zip` and
`pakpos-<version>-macos-universal.dmg`.

Signing is optional; each step is skipped when its secrets are missing:

| Secret | Used for |
|---|---|
| `WINDOWS_CERT_PFX` | Base64 of the Authenticode code-signing certificate (`.pfx`) |
| `WINDOWS_CERT_PASSWORD` | Its password |
| `MACOS_CERT_P12` | Base64 of the "Developer ID Application" certificate + key (`.p12`) |
| `MACOS_CERT_PASSWORD` | Its password |
| `APPLE_API_KEY` | Notarization, preferred: contents of an App Store Connect API key (`AuthKey_<KeyID>.p8`) |
| `APPLE_API_KEY_ID` | Its Key ID |
| `APPLE_API_ISSUER` | The Issuer ID (team keys; leave unset for an individual key) |
| `APPLE_ID` | Notarization, alternative: the Apple ID's e-mail |
| `APPLE_TEAM_ID` | The Apple Developer team ID |
| `APPLE_APP_PASSWORD` | An app-specific password for that Apple ID |
| `UPDATE_SIGNING_KEY` | ed25519 private key that signs `SHA256SUMS` into `SHA256SUMS.sig` for in-app updates (see below) |

**In-app update key.** Generate the key pair once:

```sh
go -C tools run ./updatesign keygen
```

Paste the public key into `PublicKey` in `internal/update/update.go` and
commit it. Store the private key as the `UPDATE_SIGNING_KEY` secret
(`gh secret set UPDATE_SIGNING_KEY`), and keep an offline backup: if it is
lost, installed versions can no longer update themselves. The release job
signs `SHA256SUMS` and checks the signature against the committed public key.
Without the secret the release is still published, but a warning says that it
cannot be installed from inside Pakpos. A build with an empty `PublicKey` can
check for updates but never installs one. To check a release by hand, run
`go -C tools run ./updatesign verify <public key> SHA256SUMS SHA256SUMS.sig`.

The app only sees **published, stable** releases (GitHub's "latest release";
drafts and pre-releases are skipped), so an update reaches users when you
publish the draft. It downloads the AppImage, the Windows portable zip or the
macOS dmg, so keep those file names unchanged.

Windows signs `pakpos.exe` before it goes into the installer, then the
installer (`build/windows/sign.ps1`, signtool, SHA-256 + RFC 3161 timestamp).
macOS signs the app with the hardened runtime and
`build/darwin/entitlements.plist` (only `com.apple.security.network.client`,
Wails' production preset), then signs, notarizes (`notarytool`) and staples
the dmg (`build/darwin/sign-notarize.sh`). Notarization uses the API key when
`APPLE_API_KEY` and `APPLE_API_KEY_ID` are set, otherwise the three `APPLE_*`
Apple ID secrets; with neither, the dmg is signed but not notarized. The
`.app` targets macOS 12 (`LSMinimumSystemVersion`). The certificate and
notarization setup is the same as for Lontar (dbedit); see its README
"Releasing" section for the step-by-step guide.

CI (`.github/workflows/ci.yml`) runs on every push and PR:
- Lint and coverage gates on Linux.
- Version-stamped `wails3 build` and unit tests (Go, frontend, `tools/`) on
  Linux, macOS and Windows.

## Layout

```
main.go, wails_adapters.go   Wails bootstrap and dialog/event adapters
internal/service/            Wails-bound services (thin) + shared Core
internal/core/               model, urlx, auth, httpexec, settings
internal/store/              fsstore (YAML workspace), sqlite (history, settings)
internal/buildinfo/          Version metadata (-ldflags)
scripts/                     Go coverage gate
tools/                       build helpers: calver, stamp (separate Go module)
frontend/src/
  components/ui/             shadcn/ui components (vendored)
  features/                  shell, request, response, sidebar, settings
  stores/                    Zustand stores
  hooks/ lib/ test/
build/                       icons, platform configs, packaging
```

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See also [NOTICE](NOTICE).
