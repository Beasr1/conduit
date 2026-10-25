# Go style

For `server/`. Code only; how we work is in how-i-like-to-work.md.

Baseline: the Go service style I already write, plus fixes from past code
reviews and what the battle test changed (sources.md).

## Toolchain

- Go 1.27. `server/go.mod` pins it with the `go` and `toolchain` lines.
  With the default `GOTOOLCHAIN=auto`, an older local `go` downloads the
  pinned toolchain on first use, so laptops and CI build with the same
  compiler.
- One module (`server/`), no `go.work`.

## Layout

```
server/
  cmd/conduit/main.go   subcommands (serve, migrate); wiring only
  internal/
    config/      Load() from env + Validate(); the only package reading env
    workflow/    definition types (generated from schema/workflow.yaml), Validate(); pure, no I/O
    engine/      runs a validated workflow: scheduler, node execution, events
    transform/   JSONata (gnata) behind a small interface, guardrails always on
    upstream/    the only outbound HTTP: SSRF-safe transport, retries, error kinds
    store/       Postgres via pgx; returns domain types, translates driver errors
    httpapi/     handlers, middleware, error mapping, SSE; gen/ is generated
  migrations/    goose .sql files, embedded
```

- Packages are named for what they own, not for a layer. No `pkg/`,
  `util/`, `common/`, `models/`.
- Imports point inward: `httpapi` → `engine`, `store` → `workflow`.
  `workflow` imports nothing internal. That's the hexagonal dependency
  rule without central `port/` packages.
- Interfaces are declared by the package that uses them, kept to 1–3
  methods, and added only when there are two implementations or a test needs
  a seam. Constructors return concrete types.
- Wire by hand in `main`: build dependencies in order and pass them
  explicitly. No DI framework, no `init()`, no package-level mutable state.
  `var ErrX = errors.New(...)` sentinels are fine.
- `os.Getenv` appears only in `internal/config`. Reading env at package
  load skips validation and makes tests depend on the machine.

## Context

- `ctx context.Context` is the first parameter of anything that does I/O or
  can block. Never store it in a struct.
- Work that must outlive a request uses
  `context.WithTimeout(context.WithoutCancel(ctx), d)`. That keeps trace
  values while dropping the request's cancellation.

## Errors

- Wrap with what was being done, lowercase, no "failed to":
  `fmt.Errorf("load workflow %s: %w", id, err)`.
- Sentinels live with the concept they describe (`store.ErrNotFound`,
  `workflow.ErrCycle`). Callers use `errors.Is` / `errors.As`.
- `store` translates driver errors at the edge. `pgx.ErrNoRows` becomes
  `store.ErrNotFound`. Unique violations are detected by SQLSTATE `23505`,
  never by matching strings.
- One error→HTTP mapping, in `httpapi`, as an **ordered slice** checked with
  `errors.Is`. Not a map: map iteration order is random, so an error that
  matches two sentinels would map unpredictably.
- Return `error`, never a concrete error pointer type (the typed-nil trap).
- Use `errors.Join` for several errors, not `%v` of a slice.
- Handle an error once. Handlers log; everything below returns.
- Upstream call errors carry a `Kind` (transport, timeout, status, decode,
  blocked, too_large). Their messages leave out the query string, which
  may hold secrets.

## Concurrency

- Every goroutine has an owner that waits for it and a `ctx` that stops it.
- The engine's scheduler is one goroutine that owns all run state. Node
  goroutines send results back on a channel. No mutex around run state.
- Recover panics at every goroutine boundary that runs user-defined work and
  turn them into node errors.
- Elsewhere, use `errgroup.WithContext` + `SetLimit` for fan-out that should
  fail fast. The first error cancels the rest by design.
- Sleeps and backoff `select` on `ctx.Done()`. No bare `time.Sleep` in a
  loop.
- Shutdown: `signal.NotifyContext` in `main`, then stop accepting HTTP,
  cancel running runs, wait with a deadline, close the pool.

## Inbound HTTP

- Router: `net/http` `ServeMux` (D2), with method patterns
  (`GET /v1/workflows/{id}`, `r.PathValue("id")`), and middleware as
  `func(http.Handler) http.Handler`. No framework.
- Keep `go.mod`'s `go` line at 1.22 or later. With an older line, Go
  silently keeps the old mux, and method patterns answer 404 (measured in
  the learning repo's go-services file 10).
- `http.Server` sets `ReadHeaderTimeout`, `ReadTimeout`, `IdleTimeout`, and
  `WriteTimeout` on every route except SSE.
- `http.MaxBytesReader` on every request body. Unknown JSON fields are
  rejected.
- Success returns the resource itself, with no envelope. Errors use RFC 9457
  problem details (`application/problem+json`): `type`, `title`, `status`
  and `detail`, plus our stable `code`.
- Validation failures list every problem at once in an `errors` extension.
  Each entry has a JSON Pointer `pointer` into the submitted document, a
  `code` and a `detail`. The pointer uses the plain RFC 6901 form
  (`/nodes/2/request/url`), which is also what JSON Patch paths use. The
  editor highlights fields from it, and a future agent can paste it
  straight into a patch to repair its draft (plan 08).

## Outbound HTTP

- Only through `internal/upstream`. Never `http.DefaultClient` or
  `http.Get`.
- The transport refuses non-public IPs **after** DNS resolution
  (`net.Dialer.Control`, via code.dny.dev/ssrf), so DNS rebinding and
  redirects to internal hosts fail at dial time. It also sets `Proxy: nil`,
  allows only http/https, caps redirects, and caps response bodies with
  `io.LimitReader`.
- Private networks are allowed only with
  `upstream.Options.AllowPrivateNetworks`, which
  `CONDUIT_ALLOW_PRIVATE_NETWORKS=true` will set from 03 (local dev only).
  Tests build the guard with loopback allowed, and one proves the default
  refuses it.
- A placeholder's value can't change a URL's shape.
  - In the path it must be one segment even after a server decodes it.
    `""`, `.`, `..` and any value holding `/` or `\` are refused.
  - Escaping alone isn't enough. Behind nginx proxying to a URI,
    `..%2Fadmin` reached the backend as `/admin`: nginx decoded the `%2F`,
    then resolved the `..` (plan 02).
  - Everything else but unreserved characters is escaped.
  - In the query, a value is escaped as one value.
- `net.IP.IsGlobalUnicast` is true for private ranges (RFC 1918, ULA), so
  it isn't a "public address" test. Use the guard's own check.
- code.dny.dev/ssrf allows only ports 80 and 443 by default. Upstreams on
  other ports need an explicit allow.
- The block-list is a floor, not the whole defence. Some cloud control
  addresses sit in no special-purpose range (Azure's 168.63.129.16), so
  deny those explicitly. In production, an egress proxy goes in front too.
  The details, tested in four languages, are in the learning repo's
  api-orchestration file 05.
- Always `http.NewRequestWithContext`, always close bodies.
- Never log header values or bodies. Redact `Authorization`, `Cookie` and
  key-like headers before storing run data.

## Expressions

- JSONata runs only through `internal/transform`, with all three gnata
  guardrails set: `WithTimeout`, `WithStack`, `WithSequence`.
- The guardrails bound time and depth, not memory. Set: timeout 500 ms,
  stack 100, sequence 100,000. Measured in plan 02, the sequence limit fires
  only after a cross product is built, and repeatedly doubling a string
  stays inside all three limits while reaching gigabytes. So the sequence
  limit is sized to what real mappings need (a 10 MiB body holds about
  100,000 items; 10,000 broke them), the data document is capped at 16 MiB,
  and the process needs a memory limit (06).
- A condition (an edge's `when`) is cast the way `$boolean()` casts, and a
  placeholder the way `$string()` does, so both follow JSONata's own rules.
- An expression that gives nothing (JSONata's undefined) where a value is
  needed is an error, not a silent `null`. So is a function value, which
  would otherwise marshal as a dump of its closure.
- Evaluate over raw JSON bytes (gnata's `EvalBytes`), so 64-bit IDs keep
  their digits instead of being rounded through float64.
- Regexes are RE2: linear time, but no lookaround and no backreferences.
  The editor's help says so.
- The measurements are in the learning repo's api-orchestration file 03.

## Database

- pgx v5 `pgxpool` with raw SQL. Scan with `pgx.CollectRows` +
  `pgx.RowToStructByName`. No ORM.
- Queries live in `store/`, one file per table or aggregate.
- Migrations: goose SQL (`-- +goose Up` / `Down`), timestamped names,
  embedded, applied by `conduit migrate up`. Never edit an applied migration.

## Logging

- `log/slog`: JSON handler in production, text in dev. The `*slog.Logger` is
  injected and enriched with `.With("run_id", id)`. No package-level slog
  calls inside `internal/`.
- Messages are lowercase events; data goes in attributes:
  `log.InfoContext(ctx, "node finished", "node", id, "status", st)`.
- No secrets, tokens or upstream payloads in logs.

## Tests

- Standard `testing` package. Add `go-cmp` only once diffs get hard to read.
- Table-driven when cases differ only in data. `t.Run` subtests,
  `t.Parallel()` for pure tests.
- Fake upstreams are real servers (`httptest.NewServer`), not mocks.
- Store tests run against the compose Postgres, with a fresh database per
  test package. No pgxmock.
- `go test -race ./...`, always.
- Build test requests with `httptest.NewRequestWithContext(t.Context(), …)`.
  The `noctx` linter rejects `httptest.NewRequest`, tests included, and
  that's what failed the first CI run.
- Name tests after behaviour: `TestScheduler_FanInWaitsForAllParents`.
- Use `slog.New(slog.DiscardHandler)` in tests; no hand-rolled nop logger.
- Coverage floors for `workflow`, `engine`, `transform` and `upstream` only,
  in the justfile. Floors ratchet up, never down.

## Dependencies

- When a scanner flags a module, first check whether it's actually
  compiled. `go list -deps ./cmd/conduit` lists the server's modules;
  `go list -m all` lists the whole graph, including modules that are never
  built.
- Fix a vulnerable transitive module by raising its requirement with
  `go get module@fixed`, never with a version-less `replace`. Then check
  that `just gen` output is unchanged and the tests pass.
- Prefer a version a few days old over one released yesterday, as with npm.

## Lint and format

- golangci-lint v2, pinned binary. `.golangci.yml` has `version: "2"`,
  `linters.default: standard`, plus `bodyclose`, `noctx`, `errorlint`,
  `gosec` and `nilerr`.
- Formatters: `gofumpt` and `goimports`, checked by `just check`.
  Formatting that nobody enforces drifts.

## Naming and size

- No stutter: `workflow.Definition`, not `workflow.WorkflowDefinition`.
  Receivers are one or two letters.
- Each package has a doc comment saying what it owns and the invariants it
  keeps. That's the one place longer comments belong.
- A file does one thing. Past ~400 lines, look for the seam.

## Docker

- Multi-stage build. The final stage is `gcr.io/distroless/static`, which
  ships CA certificates. A `FROM scratch` image has none, so it can't
  verify TLS, and an API orchestrator lives on outbound HTTPS.
- `go mod download` in the build, never `go mod tidy`. `.dockerignore` sits
  at the build-context root.
