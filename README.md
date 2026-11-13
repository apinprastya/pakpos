# Pakpos

Desktop REST API client built with Go + Wails v3 and React/TypeScript.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/PLAN-TIER1.md](docs/PLAN-TIER1.md).

## Requirements

- Go 1.26+
- Wails CLI v3 (`wails3`)
- Node 24+ / npm
- Linux: WebKitGTK dev packages (see `wails3 doctor`)
- Optional: `golangci-lint` (the lint task skips it if missing)

## Commands

Tasks run through Wails' bundled task runner (`wails3 task <name>`), or `task <name>` if you have Task installed.

| Command | What it does |
|---|---|
| `wails3 dev` | Run the app with hot reload |
| `wails3 build` | Production build → `bin/pakpos` |
| `wails3 task test` | Go + frontend tests |
| `wails3 task coverage` | Tests with coverage gates (≥ 80%) |
| `wails3 task lint` | gofmt, go vet, golangci-lint, tsc, ESLint, Prettier |

Frontend only (from `frontend/`): `npm run dev`, `npm test`, `npm run coverage`, `npm run lint`.

## Layout

```
main.go              Wails bootstrap
internal/service/    Wails-bound services (thin adapters)
internal/buildinfo/  Version metadata (-ldflags)
frontend/src/
  components/ui/     shadcn/ui components (vendored)
  features/          shell, request, response
  stores/            Zustand stores (theme, layout)
  hooks/ lib/ test/
```

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
