# Conduit. Run `just` to list recipes.

set shell := ["bash", "-euo", "pipefail", "-c"]

# Tools that `just setup` installs, pinned here. .tools/bin comes first on PATH.
golangci_version := "2.15.0"
export PATH := justfile_directory() / ".tools/bin" + ":" + env("PATH")

# corepack fetches the pnpm pinned in web/package.json without asking
export COREPACK_ENABLE_DOWNLOAD_PROMPT := "0"

compose := "docker compose -f docker/compose.yaml --env-file .env"

# Settings live in two files, each loaded only where it's needed, so the
# server never sees the database superuser's password:
#   .env         setup: compose's passwords and the tests' database URLs
#   server/.env  the server's own settings, read by dev-server and migrate
# `just setup` makes both from their .env.example. This loads the one in
# the current directory into the environment.
load_env := "set -a && . ./.env && set +a"

generated := "server/internal/httpapi/gen server/internal/workflow/definition.gen.go web/src/gen"

# Test coverage floors, in percent, for the packages that run workflows.
# Raise one when its coverage rises; never lower one to make check pass.
coverage_floors := "workflow=88 transform=84 upstream=91 engine=96 runner=92"

default:
    @just --list

# create .env and server/.env if missing; install the pinned golangci-lint and the web dependencies
setup:
    @for f in .env server/.env; do [ -f "$f" ] || { cp "$f.example" "$f"; echo "created $f from $f.example"; }; done
    @if golangci-lint version 2>/dev/null | grep -q "version {{golangci_version}} "; then echo "golangci-lint {{golangci_version}} already installed"; else curl -sSfL https://golangci-lint.run/install.sh | sh -s -- -b .tools/bin v{{golangci_version}}; fi
    cd web && corepack pnpm install --frozen-lockfile

# run Postgres, the API server and the web app together; Ctrl-C stops them all
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    # Postgres is stopped at the end only if this started it: the tests and
    # `just up` use the same container.
    db_was_up=$({{compose}} ps --status running --quiet db)
    just db-up migrate
    (cd server && {{load_env}} && exec go run ./cmd/conduit) &
    server=$!
    (cd web && exec corepack pnpm dev) &
    web=$!
    # Ctrl-C reaches every process in the terminal's foreground group, go
    # run's server and pnpm's Vite included, so each shuts itself down. This
    # waits for them, then stops Postgres if it started it.
    status=0
    cleanup() {
        wait || true
        if [ -z "$db_was_up" ]; then {{compose}} stop db; fi
    }
    trap cleanup EXIT
    trap 'exit "$status"' INT
    # If either stops on its own, stop the other the way Ctrl-C would.
    while kill -0 "$server" 2>/dev/null && kill -0 "$web" 2>/dev/null; do sleep 1; done
    status=1
    echo "the server or the web app stopped, so dev is stopping the rest" >&2
    kill -INT 0

# run the API server on http://127.0.0.1:8080, against the compose Postgres
dev-server: db-up migrate
    cd server && {{load_env}} && go run ./cmd/conduit

# run the web app on http://127.0.0.1:5173, proxying /api to the server
dev-web:
    cd web && corepack pnpm dev

# start Postgres on 127.0.0.1:5432 and wait until it's healthy
db-up:
    {{compose}} up --detach --wait db

# delete the database and start a fresh one
db-reset:
    {{compose}} rm --stop --force db
    docker volume rm --force conduit_db-data
    just db-up

# apply migrations to the database in server/.env; `just migrate status` lists them
migrate *args="up":
    cd server && {{load_env}} && go run ./cmd/conduit migrate {{args}}

# the gate: format, lint, tests and coverage floors, typecheck, build, stale generated code. CI runs the same
check: _require-tools
    @cd server && golangci-lint fmt --diff || { echo "Go code isn't formatted: run just fmt"; exit 1; }
    cd server && golangci-lint run ./...
    just db-up
    just _coverage
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
test *args: db-up
    {{load_env}} && cd server && go test -race {{args}} ./...
    cd web && corepack pnpm test

# regenerate code from schema/: the server's HTTP layer and workflow types, and web's types
gen:
    cd server && go tool oapi-codegen -config oapi-codegen.yaml ../schema/openapi.yaml
    cd server && go tool oapi-codegen -config oapi-codegen.workflow.yaml ../schema/workflow.yaml
    cd web && corepack pnpm gen

# install a git pre-push hook that runs `just check`
hooks-install:
    @hook="$(git rev-parse --git-path hooks)/pre-push"; printf '#!/bin/sh\nexec just check\n' > "$hook"; chmod +x "$hook"; echo "installed $hook"

# build and start everything behind nginx on http://127.0.0.1:8088
up:
    {{compose}} up --build --detach

# stop and remove the containers; the database volume stays
down:
    {{compose}} down

[private]
_require-tools:
    @golangci-lint version 2>/dev/null | grep -q "version {{golangci_version}} " || { echo "golangci-lint {{golangci_version}} is missing: run just setup"; exit 1; }

# Go tests with the race detector, failing if a package is under its floor.
# go test prints one tab-separated line per package; the 4th field holds
# "coverage: N% of statements".
[private]
_coverage:
    #!/usr/bin/env bash
    set -euo pipefail
    {{load_env}}
    cd server
    out=$(go test -race -cover ./... 2>&1) || { echo "$out"; exit 1; }
    echo "$out"
    echo "$out" | awk -F'\t' -v floors="{{coverage_floors}}" '
      BEGIN { n = split(floors, f, " "); for (i = 1; i <= n; i++) { split(f[i], kv, "="); floor[kv[1]] = kv[2] } }
      { pkg = $2; sub(/.*\//, "", pkg); pct = $4; sub(/^coverage: /, "", pct); sub(/%.*/, "", pct) }
      pkg in floor { seen[pkg] = 1; if (pct + 0 < floor[pkg] + 0) { printf "coverage of %s is %s%%, under its floor of %s%%\n", pkg, pct, floor[pkg]; bad = 1 } }
      END { for (p in floor) if (!(p in seen)) { print "no coverage reported for " p; bad = 1 }; exit bad }'
