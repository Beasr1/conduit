# Conduit. Run `just` to list recipes.

set shell := ["bash", "-euo", "pipefail", "-c"]

# Tools that `just setup` installs, pinned here. .tools/bin comes first on PATH.
golangci_version := "2.15.0"
export PATH := justfile_directory() / ".tools/bin" + ":" + env("PATH")

# corepack fetches the pnpm pinned in web/package.json without asking
export COREPACK_ENABLE_DOWNLOAD_PROMPT := "0"

generated := "server/internal/httpapi/gen web/src/gen"

default:
    @just --list

# install the pinned golangci-lint and the web dependencies
setup:
    @if golangci-lint version 2>/dev/null | grep -q "version {{golangci_version}} "; then echo "golangci-lint {{golangci_version}} already installed"; else curl -sSfL https://golangci-lint.run/install.sh | sh -s -- -b .tools/bin v{{golangci_version}}; fi
    cd web && corepack pnpm install --frozen-lockfile

# run the API server on http://127.0.0.1:8080
dev-server:
    cd server && go run ./cmd/conduit

# run the web app on http://127.0.0.1:5173, proxying /api to the server
dev-web:
    cd web && corepack pnpm dev

# the gate: format, lint, tests, typecheck, build, stale generated code. CI runs the same
check: _require-tools
    @out=$(cd server && golangci-lint fmt --diff); if [ -n "$out" ]; then echo "$out"; echo "Go code isn't formatted: run just fmt"; exit 1; fi
    cd server && golangci-lint run ./...
    cd server && go test -race ./...
    cd web && corepack pnpm format:check
    cd web && corepack pnpm lint
    cd web && corepack pnpm typecheck
    cd web && corepack pnpm test
    cd web && corepack pnpm build
    just gen
    @git diff --exit-code --stat -- {{generated}} || { echo "generated code is stale: run just gen and commit it"; exit 1; }
    @untracked=$(git ls-files --others --exclude-standard -- {{generated}}); if [ -n "$untracked" ]; then echo "generated files aren't tracked:"; echo "$untracked"; exit 1; fi

# apply formatting: gofumpt and goimports for Go, Prettier for web
fmt: _require-tools
    cd server && golangci-lint fmt
    cd web && corepack pnpm format

# run the tests; extra arguments pass through to go test
test *args:
    cd server && go test -race {{args}} ./...
    cd web && corepack pnpm test

# regenerate code from schema/openapi.yaml, for the server and for web
gen:
    cd server && go tool oapi-codegen -config oapi-codegen.yaml ../schema/openapi.yaml
    cd web && corepack pnpm gen

# install a git pre-push hook that runs `just check`
hooks-install:
    @hook="$(git rev-parse --git-path hooks)/pre-push"; printf '#!/bin/sh\nexec just check\n' > "$hook"; chmod +x "$hook"; echo "installed $hook"

# build and start everything behind nginx on http://127.0.0.1:8088
up:
    docker compose -f docker/compose.yaml up --build --detach

# stop and remove the containers
down:
    docker compose -f docker/compose.yaml down

[private]
_require-tools:
    @golangci-lint version 2>/dev/null | grep -q "version {{golangci_version}} " || { echo "golangci-lint {{golangci_version}} is missing: run just setup"; exit 1; }
