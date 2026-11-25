# Pakpos — Postman Import Plan

Reference: [ARCHITECTURE.md](./ARCHITECTURE.md), [ROADMAP.md](./ROADMAP.md)

Users moving from Postman export their work there and import the files into a
Pakpos workspace: collections (with folders, examples and scripts),
environments and globals. The import is a one-way copy into plain workspace
files; nothing stays linked to Postman.

## Scope

**In:**
- Collection exports in the v2.0 and v2.1 formats (`schema` `…/collection/v2.0.0/…` or `…/v2.1.0/…`), environment exports and globals exports, one JSON file per import
- Folders (nested), requests, saved responses (Postman "examples"), collection variables, collection/folder/request auth and scripts, per-request settings (`protocolProfileBehavior`)
- A preview before anything is written: what will be added, and a list of what won't work as it did in Postman
- Secret variables (`type: secret`) and, optionally, variables named like credentials go to the secret store, never to workspace files
- Entry points: the Collections header, the empty "No collections yet" state, the palette ("Import from Postman…")

**Out:**
- Collection v1 and Postman data dumps (the error says to export each collection as v2.1)
- Several files at once, zip archives, importing from a Postman link or the Postman API
- Descriptions (Pakpos has no description field), collection-level `variable` types other than `secret`, cookies, mock servers, monitors, flows
- Translating scripts: they are imported as written (Pakpos's `pm` API is a subset)
- Exporting to Postman (since done, see "Export" below)

## Decisions

| Topic | Decision |
|---|---|
| Where | `internal/core/postman` (pure: bytes in, model out, warnings) and `internal/importer` (writes through `fsstore` and the pipeline session). `ImportService` is thin: `PickPostmanFile`, `PreviewPostman(path, opts)`, `ImportPostman(path, opts)`. |
| Reading | Tolerant decoding: every field Postman writes in more than one shape (request as string or object, URL as string or object, headers as list or `Name: value` text, auth params as v2.1 lists or v2.0 objects, script `exec` as list or string, host/path as string or list, variable values of any JSON type) goes through a type that accepts all of them. One odd field never fails the file. Files over 64 MB are refused. |
| Detection | `info` + `item` → collection (refused when the schema isn't v2.x); `requests` + `order` → v1 (refused with how to re-export); `collections` + `environments` → data dump (refused); `values` → environment, or globals when `_postman_variable_scope` is `globals`. |
| What it makes | A collection import adds a new collection (same name as in Postman, even if one with that name exists); an environment import adds a new environment; a globals import merges into the globals (same key: replaced in place, imported value wins; new keys appended; the preview lists the replaced keys). |
| Auth | Missing auth on folders and requests is `inherit` (Postman's behaviour); on the collection it is none. `noauth` → none. Basic, bearer, API key, Digest, AWS SigV4, Hawk, NTLM, JWT and OAuth 2.0 map field by field. OAuth 1.0, Akamai EdgeGrid, ASAP and unknown types become none with a warning. OAuth 2.0: `authorization_code` turns PKCE off, `…_with_pkce` keeps it; a non-loopback callback URL is dropped with a warning (Pakpos receives the code on 127.0.0.1); stored access tokens are never imported (warning). |
| URL and params | `url.raw` is the URL as typed. When `url.query` exists it is the source of the query rows (it is the only place that holds disabled params) and the URL's query is rebuilt from the enabled rows, so the URL bar mirrors the table as everywhere else. Path variables come from `url.variable`. A URL object without `raw` is rebuilt from protocol, host, port, path, query and hash. |
| Bodies | raw (language from `options.raw.language`, else from the Content-Type header), urlencoded, formdata (one file part per `src`), file → binary, GraphQL → a raw JSON body `{"query", "variables"}` (what Postman sends; warning), `disabled: true` → body type none with the content kept. File paths are kept as exported, with one warning listing the requests to fix. |
| Scripts | Imported as written: several events of one kind are joined, disabled events skipped. A warning names APIs Pakpos lacks (`pm.request.auth`, `pm.vault`, `pm.visualizer`, `pm.require`, `require()`, timers, CryptoJS, lodash, moment, cheerio/xml2Json/tv4, the legacy `tests[]`/`responseBody`/`postman.setEnvironmentVariable` API). |
| Dynamic variables | Postman has many more (`{{$randomEmail}}`…). Unknown `{{$name}}` references stay as written; one warning lists them. |
| Secrets | `type: secret` variables become secret variables; their values go to the secret store through the session (so the secret index records them). The "Keep credentials in the secret store" option (on by default) also makes variables named like credentials (`LooksSecret`: password, secret, token, apiKey, private key, session id…, but not `tokenUrl`, `tokenType`…) secret. With it off, a warning lists them. Literal credentials in auth fields stay where they are (as typing them in the Auth tab would) with a warning naming the items. The frontend calls `ensureReady()` first when the preview says there are secret values. |
| Examples | Name, status, headers, body (text), body kind from `_postman_previewlanguage` or Content-Type; the example's request is `originalRequest` (or the item's request). Bodies over 1 MB are dropped with a warning. |
| Failure | A failed collection or environment import is deleted again (`Session.DeleteCollection`/`DeleteEnvironment`, which also removes stored secret values). Globals store secrets before saving, so a locked store changes nothing. |
| Format | Imports use the normal store writes, so the manifest upgrades as for any other write (scripts, new auth or request settings → v3). |

## Export

Collections, environments and the globals export as Postman files (collection v2.1, environment, globals), so work can go back to Postman or to a teammate who uses it.

| Topic | Decision |
|---|---|
| Where | `core/postman/export*.go` (`postman.Export(File)` → bytes + warnings; pure, deterministic: no ids or dates), `internal/exporter` (reads a collection's tree, examples, an environment or the globals from `fsstore` into a `postman.File`; suggests a file name) and a thin `ExportService` (`ExportCollection(id)`, `ExportEnvironment(id)`, `ExportGlobals()`: builds the file, then `Dialogs.SaveFile`; `path` "" = cancelled). |
| Secrets | Never exported: they're read from workspace files only (which hold no values), so there is no path from the secret store into an export. Environment/globals secrets keep `type: secret` with an empty value; collection variables (no secret type in the v2.1 schema) become empty strings. A warning lists them. Literal credentials typed in auth fields are in the workspace files already and are exported as written. |
| Headers | Postman has no collection/folder headers: they're copied into every request below by `inherit.Effective` (a request's own enabled header wins, disabled inherited rows are skipped), with a warning. |
| Auth | The reverse of the import mapping, so an export imports back unchanged. Inherit → no `auth` key; none → `noauth`. Warnings for what Postman lacks: AWS unsigned payload, Pakpos's generated JWT claims (iat/exp/jti), a custom OAuth 2.0 query parameter name. |
| Other | URL objects carry `raw`, protocol, one host segment (so `{{base.url}}` stays whole), port, path, every query row (disabled included), hash and path variables. `protocolProfileBehavior` holds redirects/TLS settings; a per-request timeout has no Postman equivalent (warning). Binary (base64) example bodies are dropped with a warning; local file paths are kept with a warning. |
| Entry points | Collection tree menu (collections only), the environment row menu, the More menu of collection/environment/globals tabs, palette "Export collection/environment/globals to Postman…" (`exportCollectionId`/`exportEnvironmentId`). A toast shows the path, or the warnings (first three). |

## Progress

- [x] `core/postman`: schema decoding, conversion, warnings (tests with v2.1/v2.0/environment/globals fixtures in `testdata/`)
- [x] `importer`: write, rollback, globals merge, summary
- [x] `ImportService` and e2e (`service/e2e_import_test.go`: import a collection and an environment, send an imported request with inherited auth, a secret from the environment, path and query params, and a test script)
- [x] Frontend: `features/import/ImportPostmanDialog.tsx` (lazy chunk), `features/import/actions.ts`, `lib/importModel.ts`, `stores/postmanImport.ts`, Collections header button, empty state button, palette action
- [x] Export: `core/postman` export (golden files `testdata/export-*.json`, `go test ./internal/core/postman -update`; round trips through `Parse`), `internal/exporter`, `ExportService` + e2e (`service/e2e_export_test.go`), frontend (`features/import/exportActions.ts`, menus, palette)
- [ ] Smoke test with real exports (see [SMOKE-TEST.md](./SMOKE-TEST.md) "Postman import")
