# Conduit. Run `just` to list recipes.

set shell := ["bash", "-euo", "pipefail", "-c"]

# Tools that `just setup` installs, pinned here. .tools/bin comes first on PATH.
golangci_version := "2.15.0"
# Node 25 and later don't ship corepack; the web image installs this one too.
corepack_version := "0.36.0"
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
coverage_floors := "workflow=97 transform=84 upstream=91 engine=96 runner=92"

default:
    @just --list

# create .env and server/.env if missing; install the pinned golangci-lint and corepack, the web dependencies and the browser test's Chromium
setup:
    @for f in .env server/.env; do [ -f "$f" ] || { cp "$f.example" "$f"; echo "created $f from $f.example"; }; done
    @if golangci-lint version 2>/dev/null | grep -q "version {{golangci_version}} "; then echo "golangci-lint {{golangci_version}} already installed"; else curl -sSfL https://golangci-lint.run/install.sh | sh -s -- -b .tools/bin v{{golangci_version}}; fi
    @if [ "$(corepack --version 2>/dev/null)" = "{{corepack_version}}" ]; then echo "corepack {{corepack_version}} already installed"; else npm install --global --prefix .tools corepack@{{corepack_version}}; fi
    cd web && corepack pnpm install --frozen-lockfile
    cd web && corepack pnpm exec playwright install chromium

# run Postgres, the API server, the web app and the test upstream together; Ctrl-C stops them all
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    # Postgres is stopped at the end only if this started it: the tests and
    # `just up` use the same container.
    db_was_up=$({{compose}} ps --status running --quiet db)
    just db-up migrate
    (cd server && exec go run ./cmd/testupstream) &
    upstream=$!
    # The server may call the test upstream, on loopback port 8090: here, in
    # development, and nowhere else.
    (cd server && {{load_env}} && CONDUIT_ALLOW_PRIVATE_NETWORKS=true CONDUIT_UPSTREAM_PORTS=80,443,8090 exec go run ./cmd/conduit) &
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
    # If any of them stops on its own, stop the rest the way Ctrl-C would.
    while kill -0 "$server" 2>/dev/null && kill -0 "$web" 2>/dev/null && kill -0 "$upstream" 2>/dev/null; do sleep 1; done
    status=1
    echo "the server, the web app or the test upstream stopped, so dev is stopping the rest" >&2
    kill -INT 0

# run the API server on http://127.0.0.1:8080, against the compose Postgres
dev-server: db-up migrate
    cd server && {{load_env}} && go run ./cmd/conduit

# run the test upstream on http://127.0.0.1:8090, to try runs against; `just dev` starts it too
upstream:
    cd server && go run ./cmd/testupstream

# run the web app on http://127.0.0.1:5173, proxying /api to the server
dev-web:
    cd web && corepack pnpm dev

# The browser test runs the built app against a database made afresh, the
# server and the test upstream, each on ports of their own, so it runs
# beside `just dev`; web/playwright.config.ts starts and stops them.

# the browser test: plan 04's Done flow in Chromium, with Playwright
e2e: db-up
    #!/usr/bin/env bash
    set -euo pipefail
    {{load_env}}
    {{compose}} exec -T db psql -v ON_ERROR_STOP=1 -q -U postgres \
        -c 'DROP DATABASE IF EXISTS conduit_e2e WITH (FORCE)' -c 'CREATE DATABASE conduit_e2e OWNER conduit'
    export CONDUIT_E2E_DATABASE_URL="postgres://conduit:${CONDUIT_DB_PASSWORD}@127.0.0.1:5432/conduit_e2e?sslmode=disable"
    (cd server && CONDUIT_DATABASE_URL="$CONDUIT_E2E_DATABASE_URL" go run ./cmd/conduit migrate up)
    cd web
    corepack pnpm build
    corepack pnpm exec playwright test

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

# the gate: format, lint, tests and coverage floors, typecheck, the browser test on a build, stale generated code. CI runs the same
check: _require-tools
    @cd server && golangci-lint fmt --diff || { echo "Go code isn't formatted: run just fmt"; exit 1; }
    cd server && golangci-lint run ./...
    just db-up
    just _coverage
    cd web && corepack pnpm format:check
    cd web && corepack pnpm lint
    cd web && corepack pnpm typecheck
    cd web && corepack pnpm test
    just e2e
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

# build the images `up` runs, without starting them, and test nginx's config in the web one, hardened as compose runs it
images:
    docker build --file docker/server/Dockerfile --tag conduit-server:check .
    docker build --file docker/web/Dockerfile --tag conduit-web:check .
    docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges conduit-web:check nginx -t

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
