# 03 — API

Status: accepted 2026-10-26. Phase A is built; phase B is next. All seven questions are
answered (Answers, at the end), and D4, D5, D8 and D9 are accepted.

## Goal

The engine becomes usable through the API:
- workflows are saved as immutable revisions and published;
- runs are started, recorded and streamed live;
- a published workflow answers at its own endpoint.

Postgres is the only state.

**Done** when one integration test, against the compose Postgres and
`httptest` upstreams, drives the API end to end:
- create a workflow, then save two revisions (the second with a stale
  `If-Match`, refused with `412`);
- publish one, and start a run;
- read the run's events off the stream, in order;
- fetch its node results;
- call the served endpoint and get `200`, plus `400`, `502` and `504` as
  problem details.

Also seen:
- `conduit migrate up` on an empty database;
- a run left `running` by a killed process is marked failed at the next
  start;
- `just check` is green, with Postgres, locally and in CI.

## Decisions this rests on

Roadmap decisions still marked proposed. This plan assumes each as written:

| # | Choice | Why it matters here |
|---|---|---|
| D4 | pgx v5, raw SQL, `CollectRows` | the whole `store` package |
| D5 | goose, migrations embedded in the binary | `conduit migrate up` |
| D8 | runs live in the server process; a run interrupted by a crash is marked failed, not resumed | the `runner` design below |
| D9 | live updates over SSE | the events endpoint. Answer 5: the web app reads it with `fetch()`, since `EventSource` can't send our bearer token |

## Packages

| Package | Owns | Depends on |
|---|---|---|
| `store` (new) | Postgres: workflows, revisions, runs, node runs; embedded migrations; driver errors translated (`ErrNotFound`, `ErrConflict`) | pgx, goose |
| `runner` (new) | Starting runs, recording them as they go, streaming their events, the cap on concurrent runs, marking interrupted runs at startup | `engine`, `store` |
| `httpapi` | Handlers for the generated interface; token auth; body limits; problem details; the event stream; serving | `runner`, `store`, `workflow` |
| `config` | The new variables (below) | |
| `cmd/conduit` | Wiring, plus a `migrate` subcommand | |

`engine` grows two things:
- terminal node events carry the node's result, so it can be recorded and
  streamed as soon as the node ends;
- a node result carries the request it sent (method, URL, headers, body),
  for inspection.

Redaction happens when it's stored, not in the engine.

## Data

Revisions are immutable. Every save creates the next one, so a run can
always point at exactly what it ran.

```sql
CREATE TABLE workflows (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  slug               text NOT NULL UNIQUE,   -- served at /serve/{slug}
  name               text NOT NULL,
  latest_revision    int  NOT NULL,
  published_revision int,                    -- null until published
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workflow_revisions (
  workflow_id uuid  NOT NULL REFERENCES workflows,
  revision    int   NOT NULL,
  definition  jsonb NOT NULL,
  provenance  jsonb NOT NULL,   -- {actor, client} now; model, on_behalf_of, source later (08)
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_id, revision)
);

CREATE TABLE runs (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  workflow_id uuid  NOT NULL,
  revision    int   NOT NULL,
  trigger     text  NOT NULL,   -- editor | served
  status      text  NOT NULL,   -- running | succeeded | failed | cancelled
  input       jsonb NOT NULL,
  output      jsonb,
  error       jsonb,            -- {code, detail, node}
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  FOREIGN KEY (workflow_id, revision) REFERENCES workflow_revisions
);

CREATE TABLE node_runs (
  run_id     uuid NOT NULL REFERENCES runs ON DELETE CASCADE,
  node_id    text NOT NULL,
  status     text NOT NULL,
  attempts   int  NOT NULL,
  request    jsonb,             -- redacted; body capped
  response   jsonb,             -- redacted; body capped, with a truncated flag
  error      jsonb,
  started_at timestamptz,
  ended_at   timestamptz NOT NULL,
  PRIMARY KEY (run_id, node_id)
);
```

- **Ids** come from Postgres 18's `uuidv7()`: time-ordered and mostly
  random, with no Go dependency. A run id must be unguessable, because it's
  half of each `Idempotency-Key` (learning repo file 04).
- **`definition` is `jsonb`.** Node order survives, since it's an array;
  object key order doesn't need to.
- **Problems aren't stored.** They're computed by `engine.Compile` when
  read, published or run, so they always match the current validator.
- **Redaction:**
  - Headers named `Authorization`, `Cookie`, `Set-Cookie` and
    `Proxy-Authorization`, and any whose name contains `key`, `token`,
    `secret` or `password`, are stored as `[redacted]`.
  - So are query values under those names.
  - Run input is stored as sent. Retention is plan 06's.

## API

All under the bearer token (D12) except the two health checks.

| Method and path | Does | Errors |
|---|---|---|
| `GET /healthz` | process up (exists) | |
| `GET /readyz` | the database answers | `503` |
| `POST /v1/workflows` | create: `slug`, `name`, first definition → revision 1 | `409` slug taken |
| `GET /v1/workflows` | list, newest first | |
| `GET /v1/workflows/{id}` | the workflow, its latest revision with its problems, and the published revision | `404` |
| `PUT /v1/workflows/{id}/draft` | save the next revision. `If-Match` must name the latest revision; the response's `ETag` names the new one | `412`, `428` without `If-Match` |
| `GET /v1/workflows/{id}/revisions[/{rev}]` | the history, or one revision | |
| `POST /v1/workflows/{id}/publish` | `{revision}`; the revision must be valid | `422` with every problem |
| `POST /v1/validate` | check a definition without saving it (the agent's `validate` tool in 08) | `422` |
| `POST /v1/workflows/{id}/runs` | `{revision?, input}` → `202`, `Location: /v1/runs/{id}`. Runs in the background | `422` invalid revision, `400` bad input, `503` at the cap |
| `GET /v1/runs`, `GET /v1/runs/{id}` | runs, newest first; one run with every node result | |
| `GET /v1/runs/{id}/events` | the live event stream (SSE) | |
| `POST /serve/{slug}` | the published workflow as an API (D19) | see Serving |

- **The definition** in `openapi.yaml` is a `$ref` to `workflow.yaml`, with
  an oapi-codegen import mapping. Tried on a scratch copy:
  - the generated request body is `type … = externalRef0.Definition`, an
    alias of `workflow.Definition`, so there's no copy;
  - openapi-typescript bundled `Definition` into the web types.
- **Errors** are RFC 9457 problem details. One ordered slice maps errors to
  statuses, in `httpapi`.
- **Bodies** are capped by `http.MaxBytesReader` at 1 MiB, nginx's
  `client_max_body_size`.
  - The generated server decodes with a plain `json.Decoder`: no cap, and
    unknown fields silently dropped (seen in the scratch output).
  - The cap goes in middleware. Unknown fields are errors (answer 2).
- **Lists** page by cursor: `?limit=` (default 50, at most 200) and
  `?before=<id>`, using UUIDv7's time order.

The definition schema gains `input_schema` and `output_schema`, both JSON
Schema 2020-12 (what OpenAPI 3.1 uses):
- `Compile` reports an `input_schema` that doesn't compile, at
  `/input_schema`;
- input is checked before a run starts, every violation with a pointer into
  the input;
- `output_schema` is recorded but not enforced in v1.

The validator is santhosh-tekuri/jsonschema v6.0.3:
- Apache-2.0, and it passes the 2020-12 compliance suite;
- each error carries its location in the input, ready to become a JSON
  Pointer;
- already in the module graph through the codegen tool;
- OSV lists no known vulnerabilities (checked 2026-10-25).

## Runs

- **`runner.Start(ctx, workflow, revision, input, trigger)`:**
  - compile the revision and check the input;
  - insert the run row as `running`;
  - start the engine.
- **Editor runs** start in the background:
  - their context drops the request's cancellation but keeps its values
    (`context.WithoutCancel`), plus the 5-minute run timeout;
  - shutdown cancels them.
- **Served runs** use the request's context: a caller who hangs up cancels
  the run, and it's recorded as cancelled.
- **Recording** (answer 3): terminal node events go to a writer
  goroutine per run, so a slow database never holds up the scheduler.
  - When the run ends, the writer is flushed, then the run row is
    finalised.
  - A served run waits for that before it answers.
- **The cap on concurrent runs** is a semaphore, `CONDUIT_MAX_RUNS`,
  default 32. Past it, a start gets `503` with `Retry-After`.
- **At startup**, every run still `running` is marked `failed` with code
  `interrupted` (roadmap item 9). That's only safe with one server process,
  which is D7 and D8.

**The event stream.**
- **Events:**
  - `node` (started, retrying, then the end with status and summary);
  - `run` (the end, with status and output or error).
  - Each has an `id`: its sequence number in the run.
- **Replay:**
  - A live run's events stay in memory until a minute after it ends, so a
    client that connects late, or reconnects with `Last-Event-ID`, gets
    everything it missed.
  - After that the stream sends only the final `run` event, and
    `GET /v1/runs/{id}` has the details.
- **A slow client** has a buffered channel. If it fills, that client is
  dropped and reconnects, rather than slowing the run.
- **Proxies and timeouts:**
  - The handler clears its write deadline through
    `http.ResponseController`, since the server's 35 s `WriteTimeout`
    would cut the stream.
  - It sends `X-Accel-Buffering: no`, which nginx documents as turning off
    buffering for that response.
  - A `:` comment every 15 s keeps the stream inside nginx's 40 s
    `proxy_read_timeout`.

## Serving (D19)

`POST /serve/{slug}`, with the run input as the body, runs the published
revision synchronously.

| Outcome | Status | Problem `code` |
|---|---|---|
| succeeded | `200`, the `output` value | |
| no such slug, or never published | `404` | `not_found` |
| input fails `input_schema` | `400`, every violation with a pointer | `invalid_input` |
| an upstream failed (status, transport, decode, too_large, blocked) | `502`, naming the node | `upstream_failed` |
| the run, or a node's last attempt, timed out | `504`, naming the node | `timeout` |
| the workflow's own configuration failed: an expression, a template | `500`, naming the node and field (answer 6) | `workflow_error` |
| our bug: a panic, the database | `500`, details only in the log | `internal_error` |
| at the run cap | `503` + `Retry-After` | `busy` |

- **Timing:** served runs time out at 30 s, under the server's 35 s
  `WriteTimeout`, so the `504` gets out before the connection is cut.
- **Version:** the endpoint always runs the current published revision.
- **nginx:** a `location /serve/` proxies it, so external callers don't go
  through `/api/`.

## Config

| Variable | Default | |
|---|---|---|
| `CONDUIT_DATABASE_URL` | required | `postgres://…` |
| `CONDUIT_API_TOKEN` | required | the one bearer token (D12), compared in constant time |
| `CONDUIT_ALLOW_PRIVATE_NETWORKS` | `false` | local development only |
| `CONDUIT_UPSTREAM_PORTS` | `80,443` | |
| `CONDUIT_MAX_RUNS` | `32` | |

`server/.env.example` lists them with development values. Setup settings
(compose's passwords, the tests' database URLs) are in the root
`.env.example`, so the server never sees the superuser's password.

## Infra and tooling

- **Postgres 18.6** in compose, pinned
  `postgres:18.6-alpine@sha256:898c60cb390d1085bc97bdd6a1ae968757421df394b071848b52b1c09c89d6a5`
  (checked 2026-10-25). 19 is at RC1, from 2026-10-15. Moving to 19 is a
  dump and restore of a development database, once 19.1 is out.
- **Postgres configuration.**

  | Setting | Value | Why |
  |---|---|---|
  | The app's role | `conduit`, not a superuser, owning the `conduit` database; created by an init script on first start | least privilege: the app can't touch other databases or roles |
  | Authentication | `scram-sha-256` for every connection | Postgres 18 deprecates md5: "Support for MD5 passwords will be removed in a future major version release". Never `trust` for a network, which lets anyone on it connect as anyone, with no password |
  | Health | a `pg_isready` healthcheck; the server waits on `service_healthy` | the server doesn't start against a database that isn't up |
  | The container | the image's `postgres` user, from the start; the compose hardening anchor; bound to 127.0.0.1 | no root process, nothing exposed |
  | Logs | `log_min_duration_statement=500ms`, and `log_line_prefix` with database, user, application and client. The server connects with `application_name=conduit` | slow queries show up, each attributed |
  | Time | `timezone=UTC`; timestamps are `timestamptz` | no local-time ambiguity |
  | Session timeouts, set by the server's pool | `statement_timeout=5s`, `idle_in_transaction_session_timeout=10s` | a stuck query or forgotten transaction fails instead of holding locks. Migrations connect without them |
  | Memory | the defaults; the pool at pgx's default size | a development database. Tuning is 06's |

  Not set, on purpose:
  - a large `work_mem`. The docs warn that "the total memory used could be
    many times the value of `work_mem`", since every sort and hash in every
    session can use that much;
  - a large `max_connections`. Each connection is a server process, and the
    pool keeps the count small.
- **Store tests** use the compose Postgres, with a fresh database per test
  package, created and migrated by a helper and dropped after.
  - `just check` brings Postgres up first, so local and CI run the same
    command. GitHub's Ubuntu runners have Docker.
  - With no database, store tests fail; they don't skip. A skipped gate
    still reads as green.
- **New recipes:**
  - `just db-up`, `db-reset`, `migrate`;
  - `just dev`, which starts the database, the server and Vite together and
    stops them all on Ctrl-C.
- **Dependabot** gains the `postgres` image, with a rule ignoring major
  versions.
- **Versions** (checked 2026-10-25): pgx v5.11.0 (2026-09-07), goose
  v3.29.0 (2026-10-11).
  - OSV lists no known vulnerabilities in either.
  - goose's compiled dependencies get checked with `go list -deps` when it's
    added. Its module lists many database drivers, and only what's imported
    is built.

## Steps

**Phase A: persistence and workflows** (built 2026-10-26)
- [x] Postgres in compose, config, pgxpool, goose migrations embedded,
      `conduit migrate up`, `/readyz`, `.env.example`, `just db-*`.
- [x] The store-test helper (a fresh database per package). CI runs it on
      the next push; not seen there yet.
- [x] Middleware: token auth with the caller in the context (the 08 seam),
      the body cap, the problem-details mapping.
- [x] `workflow.yaml`: `input_schema`, `output_schema`. `openapi.yaml`: the
      workflow endpoints, through the import mapping.
- [x] `store` and handlers for workflows, revisions (`If-Match`/`ETag`),
      publish and validate. Table tests per error status.

Built differently from the plan above, and why:
- **Docker is one directory per service** (`docker/postgres`, `server`,
  `web`), included by `docker/compose.yaml`. Asked for on 2026-10-26.
  - Postgres has no Dockerfile: the official image is used as it is.
  - Redis waits for a plan that needs it (D7).
  - The server's image runs the migrations as a one-shot service.
- **The session timeouts are set by the server's pool, not on the role**,
  so `conduit migrate` connects without them.
- **Unknown fields and wrong types are refused first**, all at once, with
  `422` and nothing saved. Definition problems are reported once the shape
  is right. Answer 2 had them in one list, but a shape error leaves nothing
  to validate.
- **`input_schema` `$ref`s can't load anything.** The JSON Schema library's
  default loader reads local files: `{"$ref": "file:///etc/passwd"}` would
  have read it. The loader is off; a test covers it.
- **`oapi-codegen/runtime` v1.7.0 is a new dependency.** The generated code
  binds path, query and header parameters with it. It's from August;
  v1.8.0 was three days old.
- **The API answers times in UTC**: pgx returns local time, and the tests
  run in +04:00.
- **Settings are split** (asked for on 2026-10-27): the root `.env` for
  setup, `server/.env` for the server. Each recipe loads only its own, and
  compose hands `server/.env` to the server's containers, overriding only
  the database URL.

**Phase B: runs and serving**
- [ ] The `engine` changes: results on terminal events, the sent request on
      node results.
- [ ] `runner`: start, the writer, the cap, the event log with replay,
      interrupted runs, shutdown. Tests with a fake clock where timing
      matters, and real upstreams.
- [ ] The runs endpoints and the event stream: `Last-Event-ID`,
      keep-alives, the write deadline.
- [ ] Serving: input checks, the status mapping, the 30 s timeout, nginx
      `/serve/`.
- [ ] The end-to-end test from Done.

**Phase C: development loop**
- [ ] `just dev`; CLAUDE.md, go.md, repo.md and the roadmap updated.

Each phase ends with `just check` green and is committed on its own.

## Out of scope

- **Moved from 03 in the roadmap:**
  - openapi-fetch goes to 04, where the web app first calls these
    endpoints;
  - the upstream library goes to 04, where the editor inserts from it.
- **Later:**
  - a per-workflow served timeout: 30 s for all until one needs more;
  - JSON Patch edits for drafts (the 08 seam);
  - test cases and dry-run (07);
  - per-workflow caller keys (07).
- **To 06:** credentials, encryption at rest, retention.

## Answers (2026-10-26)

| # | Question | Answer |
|---|---|---|
| 1 | Can a saved draft be invalid? | **Yes.** It's saved with its problems in the response. Publish and run require a valid revision |
| 2 | How are unknown fields refused? | **B, and they're errors.** The decoded JSON is walked against the generated Go types. Each unknown field comes back as a problem with its pointer, such as `/nodes/0/request/timout_ms` with code `unknown_field`, alongside every other problem. Nothing is silently dropped |
| 3 | Record node results as each node ends, or once when the run ends? | **As each ends,** through the writer goroutine |
| 4 | How much of each body is stored? | **256 KiB,** truncated and flagged. There's no formal standard. AWS Step Functions hard-limits each state's input and output to 256 KiB. Temporal limits a payload to 2 MB and recommends a claim check (store it elsewhere, pass a reference) beyond that. This is only the stored copy; the engine still works with up to 10 MiB |
| 5 | How does the browser read the stream with a bearer token? | **`fetch()` with the `Authorization` header** (04), parsing the SSE lines. The events endpoint is authenticated like every other route. No token in the URL, no cookies |
| 6 | When a served run fails through no fault of the upstream? | **`500`, with the `code` saying whose fault.** `workflow_error`: the workflow's own configuration, naming the node and field. `internal_error`: our bug, details only in the log |
| 7 | Postgres 18.6 now, or wait for 19? | **18.6 now;** move to 19 later. Configuration under Infra and tooling |

Merging results into a particular shape needs no new node kind. That's a
`transform` node (D13): edges from the nodes it merges, and an `expr` that
builds the shape, such as
`{ 'user': nodes.user.body, 'orders': nodes.orders.body.items }`. Its value
is stored, streamed and readable as `nodes.<id>.body`, like any node's.

