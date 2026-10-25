# Conduit. Run `just` to list recipes.

set shell := ["bash", "-euo", "pipefail", "-c"]

# corepack fetches the pnpm pinned in web/package.json without asking
export COREPACK_ENABLE_DOWNLOAD_PROMPT := "0"

default:
    @just --list

# install web dependencies (pnpm comes from package.json via corepack)
setup:
    cd web && corepack pnpm install --frozen-lockfile

# run the API server on http://127.0.0.1:8080
dev-server:
    cd server && go run ./cmd/conduit

# run the web app on http://127.0.0.1:5173, proxying /api to the server
dev-web:
    cd web && corepack pnpm dev

# format check, vet, race tests, typecheck and build: the gate
check:
    @files=$(gofmt -l server); if [ -n "$files" ]; then echo "gofmt needed:"; echo "$files"; exit 1; fi
    cd server && go vet ./... && go test -race ./...
    cd web && corepack pnpm typecheck && corepack pnpm build

# apply Go formatting
fmt:
    gofmt -w server

# run the Go tests; extra arguments pass through to go test
test *args:
    cd server && go test -race {{args}} ./...

# build and start everything behind nginx on http://127.0.0.1:8088
up:
    docker compose -f docker/compose.yaml up --build --detach

# stop and remove the containers
down:
    docker compose -f docker/compose.yaml down
