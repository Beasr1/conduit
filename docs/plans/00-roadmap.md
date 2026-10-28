# 00 — Roadmap

Status: proposed. Each decision's own status is in the table below; D2,
D3, D4–D13, D15, D16, D18 and D19 are decided; D1, D14 and D17 are open.
Updated 2026-10-28.

## Goal

Conduit lets someone build an API workflow without writing code:
1. Pick upstreams (single API endpoints).
2. Connect them into a graph.
3. Map data between them with JSONata.
4. Run it. Independent branches run in parallel, and every step is visible
   live.

Long term, an agent builds the workflow from a business spec and people
review and test it (08). v1 has no AI, but it keeps the seams that make
adding it cheap.

## Positioning

Kestra and Airflow run **jobs**. A trigger starts a run, a scheduler and
workers carry it out, and the result is stored for later. Kestra splits
that across separate server components (executor, scheduler, workers and
more) ✓, and ships 2,200+ plugins for databases, scripts, queues and
files ✓.

Conduit does less, on purpose. **A workflow is an API:** it's called, fans
out to upstreams, and answers within the caller's deadline.

| | Job-style engines | Conduit |
|---|---|---|
| A workflow is | a job: triggered, queued, seconds to hours | a request handler: called, answers within the caller's deadline |
| Scope | anything a plugin reaches | JSON over HTTP(S) for now (D18); other step types parked in 09 |
| Runtime | separate scheduler, executor and worker components | one Go binary, a scheduler goroutine per run |

That isn't unique. An n8n workflow can answer a request with its "Respond
to Webhook" node ✓, and KrakenD, a Go API gateway, aggregates and chains
backend calls ✓. Conduit sits between them: request-style like the
gateway, plus a builder, per-run visibility and typed contracts.

Where it can genuinely differ (each is also good to learn):
- **Typed end to end.** Upstreams come in from their OpenAPI documents, so
  a mapping like `nodes.user.body.emial` can be flagged at save time
  instead of failing at run time (07).
- **Latency as a feature.** A request-style run has a budget, so
  persistence has to stay off the hot path. That's an open question for
  02 and 03.
- **Tests and dry-run at the core.** Kestra's flow unit tests are an
  Enterprise feature ✓. Here they're the base the agent loop stands on
  (07, 08).
- **Depth over breadth.** One step type, done properly: auth schemes,
  pagination, retries, idempotency, SSRF.

## v1 scope

In:
- **Upstreams:** method, URL, headers, query, body, timeout, retry. There's
  a library of upstreams to insert from.
- **Workflows:** a DAG of nodes, with JSONata mapping into each request,
  conditional edges, an input schema, and a new immutable version on every
  save.
- **Two editors, one definition:** graph mode (React Flow) and page mode
  (ordered pages; the nodes on a page run in parallel).
- **Runs:** start with a JSON input, watch node status live, then inspect
  each node's request and response.
- **Serving (D19):** a published workflow answers at its own endpoint,
  separate from the management API. This is the identity (Positioning).
- **One user**, one API token. Callers of served workflows use it too
  until 07.
- **AI-ready seams** (08): every action in the API contract, structured
  validation errors, draft and published versions, provenance, optional
  layout.

Out until a plan says otherwise:
- Multiple users, orgs, RBAC.
- Per-workflow keys for callers (07).
- Webhook and cron triggers (09).
- Redis, multi-instance execution, resuming a run after a crash.
- Loops (running a node once per array item).
- Other step types: database, queue and script plugins, SOAP/XML, gRPC
  (D18, parked in 09).
- Code nodes. JSONata is the only user-written code.
- AI authoring (08).

## The spec's example

```
fetch user ──► orders ───┐
     └───────► prefs  ───┴──► send to CRM
```

`orders` and `prefs` start together as soon as `user` finishes. `crm` waits
for both. Its request body is one JSONata expression over
`nodes.orders.body` and `nodes.prefs.body`. "Merge" and "transform" aren't
separate steps here; they're the mapping on `crm`'s request (D13).

## Architecture

```
browser (web/)
   │  REST + SSE, contract in schema/openapi.yaml
   ▼
server (one Go binary)
   ├─ httpapi     handlers, token auth, SSE
   ├─ engine      one scheduler per run, node goroutines
   │    ├─ transform   JSONata via gnata, guardrails on
   │    └─ upstream    outbound HTTP, SSRF guard ──► external APIs
   └─ store       pgx ──► Postgres: workflows, versions, runs, node runs
```

One process serves the API and runs workflows on goroutines. Postgres is the
only state.

## Workflow definition (sketch)

Plan 02 made it exact in `schema/workflow.yaml`. `input_schema`,
`output_schema` and `ui` aren't in it yet; they arrive with 03 and 04.

```json
{
  "input_schema": {
    "type": "object", "required": ["user_id"],
    "properties": { "user_id": { "type": "string" } }
  },
  "nodes": [
    { "id": "user", "kind": "http",
      "request": { "method": "GET",
                   "url": "https://users.example.com/v1/users/{{ input.user_id }}" } },
    { "id": "orders", "kind": "http",
      "request": { "method": "GET",
                   "url": "https://orders.example.com/v1/orders?user={{ nodes.user.body.id }}" } },
    { "id": "prefs", "kind": "http",
      "request": { "method": "GET",
                   "url": "https://prefs.example.com/v1/{{ nodes.user.body.id }}" } },
    { "id": "crm", "kind": "http",
      "request": { "method": "POST", "url": "https://crm.example.com/v1/contacts",
                   "body": "{ 'email': nodes.user.body.email, 'orders': $count(nodes.orders.body.items), 'channel': nodes.prefs.body.channel }" } }
  ],
  "edges": [
    { "from": "user", "to": "orders" },
    { "from": "user", "to": "prefs" },
    { "from": "orders", "to": "crm" },
    { "from": "prefs", "to": "crm" }
  ],
  "output": "{ 'crm_id': nodes.crm.body.id }",
  "ui": { "positions": { "user": [0, 0], "orders": [240, -80] } }
}
```

- Every expression sees one document:
  `{ "input": <run input>, "nodes": { "<id>": { "status", "headers", "body" } } }`.
  Only finished ancestors appear under `nodes`, keyed by node ID, never by
  arrival order.
- `input_schema` validates run input. An optional `output_schema`
  describes `output`. Together they're the contract of the workflow's
  served API (D19).
- `ui` is optional. A definition without it (imported or generated) gets
  laid out by the editor.

## Execution semantics (v1)

1. **On save:**
   - Node IDs are unique and every edge points at real nodes.
   - There are no cycles (checked with Kahn's algorithm).
   - Every expression compiles.

   Every problem comes back at once as RFC 9457 problem details, each with
   a JSON Pointer to the offending field. The server is the source of
   truth; the editor's checks are only UX.
2. **On run:**
   - The input is validated against `input_schema`.
   - Nodes with no parents start first.
   - One scheduler goroutine per run owns the state and launches ready
     nodes, up to a per-run concurrency limit.
3. **A node ends** as succeeded, failed, skipped or cancelled. Each result
   is written to Postgres and published over SSE.
4. **Edges:** an edge is active when its source succeeded and its `when`
   expression is truthy. `when` defaults to true.
   - A node runs once all its parents have ended and at least one incoming
     edge is active.
   - If none are active, the node is skipped, and skips cascade.
5. **Failure:** the first failure fails the run. In-flight nodes are
   cancelled and the rest are marked cancelled. A per-node "continue on
   error" setting is an open question for plan 02.
6. **Retries:** off by default. When on, they cover transport errors, 5xx
   and 429 (honouring `Retry-After`). POST and PATCH are retried only if
   the node opts in, and then they carry `Idempotency-Key: <run>:<node>`.
7. **Timeouts:** 30 s per attempt and 5 min per run by default, both
   configurable.
8. **Limits:** response bodies are capped (the stored copy is truncated and
   flagged). JSONata gets a timeout, a stack depth limit and a sequence-size
   limit, and nodes per workflow are capped.
9. **Crash:** at startup, any run still marked running is marked failed
   (interrupted). v1 doesn't resume runs.
10. **Serving (D19):** a call to a published workflow's endpoint is a run
    whose caller is waiting.
    - The body is validated against `input_schema` first. A bad body gets
      400 with problem details and never starts a run.
    - Success returns 200 with the result of the `output` expression.
    - An upstream failure returns 502 and a timeout returns 504, both as
      problem details naming the failed node. Conduit is acting as a
      gateway here (RFC 9110 §15.6.3, §15.6.5). The workflow's own failure,
      such as an expression, returns 500 (plan 03, answer 6).
    - Served runs get a shorter timeout than editor runs: 30 s, for every
      workflow in v1. A per-workflow setting can come when one needs it. The server's `WriteTimeout` sits just above it,
      so the 504 gets out before the connection is cut (learning repo,
      go-services file 03).
    - The endpoint always runs the current published version, so
      publishing changes the API immediately. Versioned endpoints can come
      later if callers need them.
    - It's recorded like any other run, so it shows up in history.

## Decisions

| # | Decision | Choice | Why | Alternatives | Status |
|---|---|---|---|---|---|
| D1 | Repo shape | flat: `server/`, `web/`, `schema/` | two deployables | `apps/` + `packages/` | proposed |
| D2 | Go router | `net/http` ServeMux | `http.Handler` everywhere, no dependency; keep it simple | gin (familiar), chi | accepted |
| D3 | API contract | OpenAPI 3.1 in `schema/`; oapi-codegen for Go, openapi-typescript for TS | one source, both sides typed, CI fails on drift; agents read it too (08) | hand-written types on both sides | accepted |
| D4 | DB access | pgx v5, raw SQL, `CollectRows` | familiar; no generator | sqlc | accepted (2026-10-26, plan 03) |
| D5 | Migrations | goose, embedded | familiar | golang-migrate | accepted (2026-10-26, plan 03) |
| D6 | JSONata | gnata, pinned exact, behind `transform`; preview runs on the server | only maintained JSONata 2.x in Go; no preview/engine mismatch | jsonata-js in goja; CEL for conditions | accepted |
| D7 | Redis | not in v1 | one process; Postgres holds the state | the spec's execution cache | accepted (diverges from spec) |
| D8 | Run durability | in-process; interrupted runs marked failed | simple and honest | DBOS Transact Go, Temporal | accepted (2026-10-26, plan 03) |
| D9 | Live updates | SSE | one-way, plain HTTP. `EventSource` can't send a bearer token, so the web app reads the stream with `fetch()` | WebSocket | accepted (2026-10-26, plan 03) |
| D10 | Editor state | Zustand | what React Flow uses internally (12 still bundles zustand 4; 13 moves to 5) | Jotai | accepted (2026-10-28, plan 04) |
| D11 | Web router | React Router 8, data mode | familiar | TanStack Router | accepted (2026-10-28, plan 04) |
| D12 | v1 auth | one bearer token from env; listen on localhost by default | an open server that calls arbitrary URLs is an open proxy | user accounts | accepted |
| D13 | Node kinds | `http` and `transform`; merge and branch are mappings and edge `when`s | fewer node types, same reach | dedicated merge, branch and filter nodes | accepted (2026-10-28, plan 04) |
| D14 | Upstream reuse | the library is a template; a node keeps its own copy; credentials are by reference | workflow versions stay immutable and self-contained | nodes reference live upstream records | proposed |
| D15 | Host and CI | GitHub, Actions running `just check` | personal account | GitLab CI | accepted |
| D16 | Commit trailer | none | one-line commits | Co-Authored-By | accepted |
| D17 | AI readiness | v1 keeps the seams listed in 08; no AI code | cheap now, a rewrite later | build AI first; ignore it until later | proposed |
| D18 | Scope | JSON over HTTP(S) only, for now. The step's `kind` (D13) is the seam, so a new kind is additive; keep HTTP-only assumptions inside `internal/upstream` | depth over breadth; it's what makes "a workflow is an API" work. Databases and queues are reachable through an API in front of them | deferred to 09: database, queue and script plugins; SOAP/XML (needs XML↔JSON at the step boundary, since JSONata reads JSON); gRPC | accepted |
| D19 | Serving workflows as APIs | in v1, moved from 07: a published version answers at its own endpoint, synchronously, within a timeout; 03 gains it. Callers use the v1 token; per-workflow keys come in 07 | it's the identity (Positioning), and small once the engine and API exist | keep it in 07 | accepted |

## Notes on decisions

### D2: gin or the standard library (decided: standard library)

You know gin, and that counts. Here's what changes with each:

| | gin | `net/http` ServeMux (Go 1.22+) |
|---|---|---|
| Handler type | `func(*gin.Context)` | `http.Handler`, the type every Go HTTP library speaks |
| Routing | groups, params, wildcards | method and path patterns (`GET /v1/runs/{id}`) and wildcards; the most specific pattern wins; conflicting patterns panic at startup |
| Binding and validation | built in (`ShouldBindJSON` + validator tags) | not built in; with D3, the generated server decodes requests |
| Middleware | gin's own `gin.HandlerFunc` chain | plain `func(http.Handler) http.Handler`; any Go middleware fits |
| Context | `*gin.Context` is pooled and reused, so a goroutine must take `c.Copy()` (gin's docs) ✓. Passed as a `context.Context`, it ignores the request's cancellation by default, so use `c.Request.Context()` (measured) | `r.Context()` is the request's own context; it's cancelled when the client goes away |
| Dependencies | v1.12.0's go.mod: 15 direct, 35 total ✓. A small server compiles in 19 modules, 20.5 MB (measured) | none; 8.0 MB (measured) |
| SSE | `c.SSEvent`, `c.Stream` | `http.ResponseController` and `Flush` |
| With D3 | oapi-codegen has `gin-server` ✓ | oapi-codegen has `std-http-server` ✓ |

Speed isn't a factor. Measured on a laptop: routing takes 28–255 ns across
ServeMux, chi and gin. One loopback HTTP request takes about 30 µs, and a
real upstream call takes milliseconds.

"Measured" means the programs in go-services file 10 of my learning repo,
which covers all of this with code you can run.

I still recommend the standard library: handlers stay `http.Handler`, there
are no dependencies, and D3's generated server already does what gin's
binding gives you. gin is the right call if you'd rather move fast on what
you know. chi sits in between: stdlib handler types plus route groups.

Read:
- https://go.dev/blog/routing-enhancements — what Go 1.22 added to ServeMux.
- https://pkg.go.dev/net/http#ServeMux — the pattern and precedence rules.
- https://www.alexedwards.net/blog/which-go-router-should-i-use — compares
  30 routers. All five on the shortlist are `http.Handler`-compatible, and
  it recommends "http.ServeMux as your go-to router" ✓. gin isn't in it;
  it's a framework rather than a router.
- https://eli.thegreenplace.net/2023/better-http-server-routing-in-go-122/ —
  expects many people to find the new mux "sufficient", and notes that
  frameworks like Gin add more tools ✓.
- https://calhoun.io/go-servemux-vs-chi — uses chi for his own production
  apps, but will try ServeMux on new projects, because switching later
  "historically this hasn't been a painful refactor" ✓.
- https://github.com/gin-gonic/gin/blob/master/docs/doc.md#goroutines-inside-a-middleware —
  gin's own rule: "you SHOULD NOT use the original context inside it" ✓.
- https://github.com/oapi-codegen/oapi-codegen — server generators for gin,
  chi and net/http.

### D3: what "OpenAPI codegen" means

`schema/openapi.yaml` is one file that lists every endpoint: its path, its
method, and the exact JSON going in and coming out. `just gen` reads it and
writes the boring code on both sides:
- **Go:** the request and response structs, plus an interface with one
  method per endpoint. We write the methods; the generated code decodes
  requests and encodes responses.
- **TypeScript:** types for every request and response, used by the web
  app's API client.

Think of it as a database schema for the API. Change it in one place,
regenerate, and both sides follow. A mismatch becomes a compile error
instead of a bug found at runtime, and CI fails if anyone hand-edits one
side. It pays off again in 08: the same file tells an agent what the API
can do.

## Milestones

| # | Goal | Done when |
|---|---|---|
| 01 foundation | skeleton on both sides, `just`, CI, gates | `just check` green locally and in CI; `just dev` serves a page showing a green health badge |
| 02 engine | definition types, validation, scheduler, upstream caller, transform | the spec example runs end to end in a test against `httptest` upstreams; `-race` clean; SSRF and guardrail tests pass |
| 03 api | persistence, REST, SSE, serving. Also, moved from 01: Postgres in compose, pgx, goose, `migrate`, `/readyz`, `.env.example`, `just dev` | through the API: create and version a workflow, start a run, stream its events, inspect node runs. A published workflow answers at its own endpoint, with 400, 502 and 504 as problem details |
| 04 graph-editor | build, edit, save and run in graph mode. Also, moved from 01: Tailwind 4 and shadcn, React Router, `env.ts`, lucide, toasts (shadcn's, not sonner: plan 04 answer 7); from 03: openapi-fetch | the spec example built and run from the browser, statuses updating live |
| 05 page-mode | step builder over the same definition | the same example built in page mode; switching modes keeps the definition intact |
| 06 hardening | credentials, limits, images, observability | credentials encrypted at rest and redacted everywhere; distroless image; traces on runs |
| 07 tests-and-catalogue | dry-run; test cases; the upstream library (moved from 04, plan 04 answer 2), filled by importing upstreams from OpenAPI; per-workflow caller keys | a workflow's tests pass in dry-run without calling anything external; each served workflow has its own caller key |
| 08 ai-authoring | an agent turns a spec into a draft workflow with tests (08-ai-authoring.md) | the eval set passes at an agreed rate; a person publishes every draft |
| 09 later | parked ideas | Redis response cache, cron triggers, durable runs, loops, import/export; other step types: database, queue and script plugins, SOAP/XML, gRPC (D18) |
| 10 jsonata-editing | after 04: your own JSONata language package for CodeMirror 6, in its own repo and published, starting from gnata-sqlite's MIT grammar; the editor's textareas become CodeMirror (plan 04 answer 3) | expressions highlighted, completed (`input.`, `nodes.<id>.body`, `$` functions), checked by the server inline, and formatted in your style |

## Risks

| Risk | Mitigation |
|---|---|
| gnata is young (created 2026-03, pre-1.0, ported with AI) | pin exact; keep it behind `transform`; golden tests for every example expression; the jsonata-js suite already passes |
| SSRF through user-configured URLs | dialer-level IP check after DNS; tests for each blocked range and for redirects; the dev override is explicit |
| JSONata is user-written code | guardrails always on; tests that runaway expressions stop. Guardrails don't bound memory: measured in 02, the sequence limit fires only after a cross product is built, and a doubling string reached 5 GB inside the 500 ms timeout. So the document a node sees is capped (16 MiB), and the process needs a memory limit (06) |
| Large payloads | caps on the response body, the stored copy and the JSONata sequence size |
| Large graphs in React Flow | target ≤ 200 nodes in v1; follow React Flow's performance guide |
| Agent-built workflows with side effects (08) | agents only write drafts; drafts run in dry-run; a person publishes |
| Scope creep | new ideas go into 09 first |
