# 01 — Foundation

Status: in progress. The bare-minimum pass landed on 2026-10-20: server,
web, nginx and Docker, all running and checked. The unticked items below are
what's left. D2, D3, D15 and D16 are settled; D1 (the flat layout) is
proposed.

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
- [x] `justfile` with the pipefail shell: `setup`, `dev-server`, `dev-web`,
      `check`, `fmt`, `test`, `up` and `down`. `dev` (everything at once),
      `gen`, `db-migrate`, `db-reset` and `hooks-install` arrive with their
      pieces.
- [ ] `.env.example` for the server and for web, in sections; `just setup`
      copies them. Not needed yet: every setting has a working default, and
      the variables are listed in `internal/config`'s package doc.
- [ ] Optional: `.claude/settings.json` deny rules for `git commit` and
      `git push` (sources.md, "Hard rules").

Server
- [x] `go.mod` pinning `go 1.27.0` and `toolchain go1.27.2`; module
      `github.com/Beasr1/conduit/server`. An older local `go` fetches 1.27.2
      on first use (checked with 1.24.4).
- [x] `cmd/conduit`: just the server for now. A `migrate` subcommand
      arrives with the database.
- [x] `internal/config`: `Load` + `Validate` for `CONDUIT_*` variables, with
      table tests. It listens on localhost by default (D12).
- [x] slog setup; `http.Server` with timeouts; shutdown via
      `signal.NotifyContext` (SIGTERM checked: it drains and exits).
- [x] `GET /healthz` (process is up). `GET /readyz` arrives with the
      database it pings.
- [ ] pgx pool; goose wired with embedded migrations. No tables yet; they
      arrive in 03.
- [ ] `.golangci.yml` (v2), with gofumpt and goimports. Until then
      `just check` runs gofmt and `go vet`.

Schema
- [ ] `schema/openapi.yaml` with the health endpoints and the error shape.
- [ ] `just gen` writes `server/internal/httpapi/gen` and `web/src/gen`,
      both committed.

Web
- [x] Vite 8, React 19, TypeScript 6.0 strict; pnpm 12 pinned by
      `packageManager` and run through corepack. `saveExact` lives in
      `web/pnpm-workspace.yaml`, because pnpm 12 ignores `save-exact` in
      `.npmrc` (checked).
- [ ] Tailwind 4 and `shadcn init`; lucide; sonner. Until then a small
      `index.css` holds the theme tokens.
- [ ] React Router with one route plus not-found, and `env.ts` (Zod). Done
      already: the TanStack Query client and `lib/api.ts` (timeouts, error
      kinds).
- [ ] ESLint flat config + typescript-eslint + react-hooks; Prettier + the
      tailwind plugin.
- [ ] Vitest + Testing Library + MSW, with one test that renders the shell.
- [x] A health badge in the shell that calls `/api/healthz` (to become
      `/readyz`), proving the web→server path in dev and in Docker.

Infra and CI
- [x] `docker/Dockerfile.server` (distroless, non-root, 8.6 MB) and
      `docker/Dockerfile.web` (NGINX's non-root image), with base images
      pinned by tag and digest.
- [x] nginx config in `docker/nginx/`, split by topic. `conf.d/` holds the
      numbered logging, security, limits and compression files plus
      `default.conf` (the server); `snippets/` holds the security headers and
      proxy settings. Together they:
      - serves the build, falls back to `index.html` for deep links, and
        caches hashed assets for a year;
      - forwards `/api/*` to the server with the prefix stripped;
      - writes JSON access logs with no secrets;
      - sends security headers, with the CSP chosen by content type;
      - rate-limits and body-caps `/api`, and re-resolves the server
        through Docker's DNS.
      All of it was checked on 2026-10-25, including that recreating the
      server under a new IP doesn't break nginx.
- [x] `docker/compose.yaml`: server and web, with only nginx published, on
      `127.0.0.1:8088`. Both containers run read-only, with no
      capabilities, `no-new-privileges` and rotated logs. nginx has a
      healthcheck.
- [ ] A bot to bump the digest pins (Dependabot or Renovate), so pinned
      images still get patches.
- [ ] Postgres in compose, on a pinned tag, with a healthcheck and the port
      bound to `127.0.0.1`.
- [ ] GitHub Actions: pinned Go, Node, pnpm and golangci-lint, then
      `just check`.
- [ ] `just hooks-install`: a pre-push hook that runs `just check`.
- [x] Make CLAUDE.md's command list match the justfile.

## Done means

- On a clean clone, `just setup && just dev` shows the shell with a green
  health badge.
- `just check` is green locally and in CI. It is seen failing once for each
  of: an unformatted file (seen 2026-10-20), a lint finding, a failing test,
  stale generated code. A gate that can't fail isn't a gate.
- CLAUDE.md's commands match the justfile.

## Ports

| What | Where |
|---|---|
| server (`just dev-server`, and inside Docker) | 8080 |
| web dev server (`just dev-web`) | 127.0.0.1:5173 |
| the app in Docker, behind nginx (`just up`) | 127.0.0.1:8088. Port 8000 was already taken on this machine |
