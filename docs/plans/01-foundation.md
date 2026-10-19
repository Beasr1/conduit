# 01 — Foundation

Status: not started, and ready to start. D2, D3, D15 and D16 are settled.
D1 (the flat layout) is proposed.

## Goal

An empty but real monorepo: both apps start, every gate runs locally and in
CI, and both use the same command.

## Steps

Repo
- [x] `git init` with `main`, and `origin` on GitHub. `.gitignore` is in
      place, including `CLAUDE.local.md`; extend it as tools land.
- [x] `.vscode/settings.json` and `extensions.json`: format on save with the
      same formatters `just check` runs, recommended extensions, and
      generated code opened read-only.
- [ ] `justfile` with `setup`, `dev`, `check`, `fmt`, `test`, `gen`,
      `db-migrate`, `db-reset` and `hooks-install`, plus the pipefail shell.
- [ ] `.env.example` for the server and for web, in sections; `just setup`
      copies them.
- [ ] Optional: `.claude/settings.json` deny rules for `git commit` and
      `git push` (sources.md, "Hard rules").

Server
- [ ] `go.mod` with the `go` and `toolchain` pins and the module path.
- [ ] `cmd/conduit` with `serve` and `migrate` subcommands.
- [ ] `internal/config`: `Load` + `Validate` for `CONDUIT_*` variables, with
      a table test.
- [ ] slog setup; `http.Server` with timeouts; shutdown via
      `signal.NotifyContext`.
- [ ] `GET /healthz` (process is up) and `GET /readyz` (database ping).
- [ ] pgx pool; goose wired with embedded migrations. No tables yet; they
      arrive in 03.
- [ ] `.golangci.yml` (v2), with gofumpt and goimports.

Schema
- [ ] `schema/openapi.yaml` with the health endpoints and the error shape.
- [ ] `just gen` writes `server/internal/httpapi/gen` and `web/src/gen`,
      both committed.

Web
- [ ] Vite 8, React 19, TypeScript 6.0 strict; pnpm with the
      `packageManager` pin and `save-exact`.
- [ ] Tailwind 4 and `shadcn init`; lucide; sonner.
- [ ] React Router with one route plus not-found, a TanStack Query client,
      `lib/api.ts` (timeouts, error kinds) and `env.ts` (Zod).
- [ ] ESLint flat config + typescript-eslint + react-hooks; Prettier + the
      tailwind plugin.
- [ ] Vitest + Testing Library + MSW, with one test that renders the shell.
- [ ] A health badge in the shell that calls `/readyz`, proving the
      web→server path.

Infra and CI
- [ ] `docker/compose.yaml`: Postgres on a pinned tag, with a healthcheck
      and the port bound to `127.0.0.1`.
- [ ] GitHub Actions: pinned Go, Node, pnpm and golangci-lint, then
      `just check`.
- [ ] `just hooks-install`: a pre-push hook that runs `just check`.
- [ ] Make CLAUDE.md's command list match the justfile.

## Done means

- On a clean clone, `just setup && just dev` shows the shell with a green
  health badge.
- `just check` is green locally and in CI. It is seen failing once for each
  of: an unformatted file, a lint finding, a failing test, stale generated
  code. A gate that can't fail isn't a gate.
- CLAUDE.md's commands match the justfile.

## Open questions

- Go module path, e.g. `github.com/<you>/conduit/server`.
- Node version: the current LTS at scaffold time, pinned in
  `web/.node-version`.
