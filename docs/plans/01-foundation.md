# 01 — Foundation

Status: done locally (2026-10-25). `just check` passes on this machine,
golangci-lint included, and every gate has been seen failing. Left: seeing CI
green on the next push, and turning on Dependabot alerts in GitHub.

Scope change, 2026-10-25: the database pieces moved to 03 and the UI
foundations to 04, because nothing uses them before then. Plan 01 is about
gates.

## Goal

An empty but real monorepo: both apps start, every gate runs locally and in
CI, and both use the same command.

## Steps

Repo
- [x] `git init` with `main`, and `origin` on GitHub. `.gitignore` is in
      place, including `CLAUDE.local.md` and `.tools/`.
- [x] `.vscode/settings.json` and `extensions.json`: format on save with the
      same formatters `just check` runs, recommended extensions, and
      generated code opened read-only.
- [x] `justfile` with the pipefail shell. Recipes: `setup`, `dev-server`,
      `dev-web`, `check`, `fmt`, `test`, `gen`, `hooks-install`, `up` and
      `down`. `dev` (everything at once) and `db-*` arrive with the database
      in 03.
- [ ] Optional: `.claude/settings.json` deny rules for `git commit` and
      `git push`.

Server
- [x] `go.mod` pinning `go 1.27.0` and `toolchain go1.27.2`; module
      `github.com/Beasr1/conduit/server`.
- [x] `cmd/conduit`, `internal/config` (with table tests), slog, timeouts,
      graceful shutdown, `GET /healthz`.
- [x] `.golangci.yml` (v2): the standard linters plus bodyclose, errorlint,
      gosec, nilerr and noctx; gofumpt and goimports as formatters.
      golangci-lint 2.15.0 is installed by `just setup` (binary, into
      `.tools/bin`) and by the official action in CI. `go vet` runs inside it.
- [x] **See** `golangci-lint run` and the format gate pass, and fail once on
      an unformatted file.
      - Lint failed once, on gosec G101 against a test's deliberate URL
        credentials, which now carry a `//nolint` with the reason.
      - The format gate failed on gofumpt's table-entry layout.
      - It first failed *silently*: `golangci-lint fmt --diff` exits 1 when
        it finds a diff, so the old `out=$(…)` stopped under `bash -e`
        before printing anything. The gate now prints the diff.

Schema
- [x] `schema/openapi.yaml` (3.1): `/healthz`, plus the RFC 9457 problem
      shape.
- [x] `just gen`:
      - writes `server/internal/httpapi/gen` with oapi-codegen 2.8.0, run
        through a `tool` line in `go.mod`;
      - writes `web/src/gen` with openapi-typescript 7.13.0;
      - output is identical byte for byte when regenerated.
- [x] The server implements the generated strict interface; the hand-written
      route is gone and the router tests pass unchanged.
- [x] `just check` regenerates, then fails if generated code differs or is
      untracked.

Web
- [x] Vite 8, React 19, TypeScript 6.0 strict; pnpm 12 pinned by
      `packageManager`, run through corepack; `saveExact` in
      `pnpm-workspace.yaml`.
- [x] ESLint flat config (`@eslint/js`, typescript-eslint, react-hooks) and
      Prettier on its defaults. Seen failing on an `any` and on an
      unformatted file.
- [x] Vitest + Testing Library + MSW 3. Two tests for the health badge (up,
      and unreachable). Seen failing; an unmatched request fails the test.
- [x] A health badge calling `/api/healthz`, typed from `src/gen`.

Infra and CI
- [x] Dockerfiles, nginx (`docker/nginx/`) and compose: hardened, digests
      pinned. See repo.md.
- [x] GitHub Actions (`.github/workflows/ci.yml`): actions pinned to commit
      SHAs; Go from `go.mod`'s toolchain line, Node from `.node-version`, the
      pinned just and golangci-lint; then `just setup` and `just check`. Its
      first run (2026-10-25) failed on two `noctx` findings in
      `router_test.go`; that's fixed. The format check passed, and nothing
      else was flagged.
- [x] `just hooks-install`: a pre-push hook that runs `just check`.
- [x] Dependabot (`.github/dependabot.yml`): weekly bumps for Docker digests,
      actions, Go modules and npm, with a 3-day cooldown matching pnpm's
      release-age guard. Its first PRs proposed nginx mainline (1.31) and
      `@types/node` 26. Ignore rules now keep it on the lines we chose:
      nginx stable, Node 24 LTS, and the Go minor in `go.mod`.
- [x] CLAUDE.md's commands match the justfile.
- [ ] Turn on Dependabot alerts and security updates in the GitHub repo's
      settings (Settings → Advanced Security). It's a click on GitHub, not
      a file. It covers what `dependabot.yml` doesn't: alerts for
      vulnerable versions already in `go.mod` and the lockfile, including
      tool dependencies.

Moved out
- To 03 (persistence):
  - Postgres in compose; pgx; goose with embedded migrations;
  - a `migrate` subcommand, `GET /readyz`, `.env.example`;
  - `just dev` and `db-*`;
  - openapi-fetch, once there's more than one endpoint.
- To 04 (graph editor): Tailwind 4 and shadcn, React Router, `env.ts`,
  lucide, sonner.

## Done means

- On a clean clone, `just setup` and then `just dev-server` + `just dev-web`
  show the shell with a green health badge. (`just dev` replaces the pair in
  03.)
- `just check` is green locally and in CI, and has been seen failing on each
  gate:
  - an unformatted Go file: seen, with gofumpt;
  - an unformatted TS file: seen;
  - a lint finding: seen in web and in Go (gosec);
  - a failing test: seen in web, and in Go through the coverage gate;
  - stale generated code: to see once the generated files are committed.
- CLAUDE.md's commands match the justfile.

## Ports

| What | Where |
|---|---|
| server (`just dev-server`, and inside Docker) | 8080 |
| web dev server (`just dev-web`) | 127.0.0.1:5173 |
| the app in Docker, behind nginx (`just up`) | 127.0.0.1:8088. Port 8000 was already taken on this machine |
