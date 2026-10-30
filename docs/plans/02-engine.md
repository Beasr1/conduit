# 02 — Engine

Status: done. Built 2026-10-25, with `just check` passing locally,
golangci-lint included. CI went green on 2026-10-27, once the guardrail test
stopped racing its timeout (plan 03).

The six open questions were answered by going ahead with the
recommendations: on 2026-10-25 the answer to "go with recommendations, or
answer them" was "continue". The answers are at the end.

## Goal

The workflow engine as a Go library, with no HTTP API and no database yet.
It takes a definition, validates it, and runs it against real HTTP upstreams
with independent branches in parallel. It returns every node's result and
the run's output.

**Done** when the spec example (`user` → `orders` ‖ `prefs` → `crm`) runs end
to end in a test against `httptest` upstreams. That test must be race-clean,
and the SSRF and guardrail tests must pass.

Done, and seen:
- `TestRun_SpecExample` (`server/internal/engine/engine_test.go`). Its
  `orders` and `prefs` handlers each wait for the other, so it fails unless
  they're in flight together.
- `go test -race -count=5 ./internal/...` passes.
- SSRF: `TestDo_BlocksNonPublicAddresses` (14 cases),
  `TestDo_BlocksRedirectToInternalAddress` and
  `TestDo_DefaultRefusesLoopbackServer`.
- Guardrails: `TestGuardrails`.

## Packages

Imports point inward.

| Package | Owns | Depends on |
|---|---|---|
| `workflow` | Definition types, generated from `schema/workflow.yaml`; `Validate`, every problem at once, as JSON Pointers | nothing internal |
| `transform` | JSONata through gnata, guardrails always on; `{{ }}` string templates | gnata |
| `upstream` | The only outbound HTTP: SSRF guard at dial time, timeouts, a size cap, retries, error kinds | code.dny.dev/ssrf |
| `engine` | `Compile`: validation plus compiling every expression. `Run`: the scheduler, node execution, events | the three above |

New dependencies, and nothing else:
- gnata v0.6.2, the JSONata evaluator (D6). It brings tidwall/gjson,
  match and pretty.
- code.dny.dev/ssrf v0.3.0, the dial-time address check.

OSV lists no known vulnerabilities in any of the five (checked 2026-10-25).

## The definition

`schema/workflow.yaml` is the source of truth. `just gen` writes the Go
types into `server/internal/workflow/definition.gen.go`.

```json
{
  "nodes": [
    { "id": "user", "kind": "http",
      "request": { "method": "GET",
                   "url": "https://users.example.com/v1/users/{{ input.user_id }}",
                   "retry": { "attempts": 3 } } },
    { "id": "summary", "kind": "transform",
      "expr": "{ 'email': nodes.user.body.email }" }
  ],
  "edges": [{ "from": "user", "to": "summary", "when": "nodes.user.status = 200" }],
  "output": "nodes.summary.body"
}
```

- **`http` nodes.**
  - Fields: `request.method`, `url`, `headers`, `query` and `body`, plus an
    optional `timeout_ms` (1–300,000) and `retry` (`attempts`, 2–5, and
    `idempotent`).
  - `url`, header values and query values are **templates**: literal text
    with `{{ jsonata }}` placeholders. A placeholder ends at the first `}}`.
  - `body` is one JSONata expression, sent as JSON.
- **`transform` nodes:** one JSONata `expr`. Its value becomes the node's
  `body`.
- **`edges`:** `when` is optional, cast to a boolean the way `$boolean()`
  does, and true when absent.
- **`output`:** JSONata over every node that succeeded.
- **What expressions see:** `{ input, nodes: { <id>: { status, headers, body } } }`.
  - A transform node's entry has only `body`.
  - Header names are lower case.
  - Only finished ancestors appear, so what an expression sees never
    depends on timing.

## Validation (on save)

`engine.Compile` reports everything at once, as a `workflow.Problems`.

| Code | Pointer, for example | When |
|---|---|---|
| `required` | `/nodes/0/id` | a required field is missing |
| `invalid_id` | `/nodes/3/id` | not `^[a-z][a-z0-9_]{0,63}$` |
| `duplicate_id` | `/nodes/3/id` | |
| `invalid_kind` | `/nodes/1/kind` | not `http` or `transform` |
| `not_allowed` | `/nodes/1/expr` | a field of the other kind |
| `invalid_method` | `/nodes/5/request/method` | not GET, HEAD, POST, PUT, PATCH or DELETE |
| `invalid_url` | `/nodes/0/request/url` | not absolute http(s) with a host, or has credentials or a fragment |
| `placeholder_in_host` | `/nodes/0/request/url` | a placeholder before the path |
| `invalid_header_name` | `/nodes/0/request/headers/X Key` | not an RFC 9110 token |
| `invalid_timeout`, `invalid_retry` | `/nodes/0/request/timeout_ms` | out of range |
| `too_many_nodes` | `/nodes` | over 200 |
| `unknown_node`, `self_edge`, `duplicate_edge` | `/edges/2/to` | |
| `cycle` | `/edges/4` | the edge is on a cycle; edges behind one aren't blamed |
| `invalid_expression` | `/edges/0/when` | an expression or template doesn't compile |

## Running

1. **The scheduler** is the goroutine that calls `Run`, and it owns the
   run's state. It starts ready nodes in declaration order, up to a
   concurrency limit (default 8). Node goroutines report back on a channel,
   so no mutex guards run state.
2. **A node goroutine:**
   - renders the request: URL, query, headers, then the body;
   - calls `upstream`;
   - evaluates its outgoing edges' `when` conditions, which see its own
     result too: since plan 04's outputs (2026-10-30), those of the edges
     from the output it answered through;
   - reports back.

   A panic is recovered and becomes the node's failure, as a `PanicError`
   with the stack.
3. **Outcomes.**
   - *succeeded*: a 2xx response, a status the node lists as an output
     (plan 04, 2026-10-30), or a transform that evaluated.
   - *failed*: anything else, after retries.
   - *skipped*: every parent ended and no edge in was taken. Skips cascade.
   - *cancelled*: stopped by another node's failure or by the caller, or
     never started.
4. **Fail-fast.**
   - The first failure cancels the run's context, and other nodes that then
     end in error count as cancelled.
   - When the run's deadline (default 5 min) cuts nodes off, they count as
     failed: they're why the run failed.
   - Run statuses are succeeded, failed or cancelled; cancelled means the
     caller stopped it.
5. **Output.** `output` is evaluated after a successful run, over every node
   that succeeded.
6. **Events.**
   - Each event is `{run, node, kind, attempt, at}`.
   - Kinds: started, retrying, succeeded, failed, skipped, cancelled.
   - The callback runs on the scheduler goroutine, one event at a time and
     in order.

## Limits and safety

| What | Value | Why |
|---|---|---|
| Per-attempt timeout | 30 s, or the node's `timeout_ms` | the roadmap |
| Per-run timeout | 5 min (30 s when served, in 03) | the roadmap |
| Concurrency | 8 nodes per run | |
| Response body | 10 MiB, then failure kind `too_large` | memory |
| A node's data document | 16 MiB, then the node fails | each complex expression decodes all of it |
| JSONata | timeout 500 ms, stack 100, sequence 100,000 | measured; see below |
| Retries | off. When on: transport errors, timeouts, 429 and 5xx. Backoff from 100 ms to 10 s with full jitter. `Retry-After` is a floor, and over 30 s or over the time left means give up. POST and PATCH only when `idempotent`, sent with `Idempotency-Key: <run>:<node>` | learning repo file 04 |

**SSRF.** The `net.Dialer.Control` check runs after DNS on every connection,
redirect hops included. It refuses:
- every IANA special-purpose IPv4 range: loopback, RFC 1918, link-local
  (so 169.254.169.254), CGNAT and more;
- IPv6 outside global unicast: loopback, ULA, link-local, IPv4-mapped;
- Azure's 168.63.129.16;
- ports other than 80 and 443 (`upstream.Options.Ports` widens them).

Proxies are off and at most five redirects are followed. A 2130706433 host
(127.0.0.1 written as one number) was resolved by macOS and then blocked at
dial time. `upstream.Options.AllowPrivateNetworks` turns the check off, for
local development.

**Templates can't change a URL's shape.**
- A placeholder's value in the path must stay one segment, even after a
  server decodes it.
  - `""`, `.`, `..` and any value holding `/` or `\` fail the node.
  - Everything else but unreserved characters is escaped.
  - Escaping alone isn't enough. Under Measurements, nginx turned an escaped
    `..%2Fadmin` into a request for `/admin`.
- In the query, a value is escaped as one value, so `a&admin=1` can't add a
  parameter.
- Placeholders in the scheme, host or port are refused on save.

## Measurements

**Guardrails.** Peak memory is the maximum resident set size from
`/usr/bin/time -l` (Apple M4 Pro, 24 GB, Go 1.27.0, gnata v0.6.2).

| Expression | Sequence limit | Timeout | Peak | Stopped by |
|---|---|---|---|---|
| `$count([1..10000].([1..10000]))` | 1,000 | 500 ms | 6 MB | D2015 at once: the range alone is over the limit |
| the same | 10,000 | 500 ms | 1.36 GB | D1012 (timeout) at 641 ms |
| the same | 10,000 | 5 s | 4.80 GB | D2015 at 2.9 s, once the whole product existed |
| the same | 100,000 | 100 ms | 279 MB | D1012 at 115 ms |
| the same | 100,000 | 500 ms | 1.72 GB | D1012 at 601 ms |
| `$count([1..1000].([1..1000]))` | 10,000 | 500 ms | 71 MB | D2015 at 29 ms |
| `$count([1..3000].([1..3000]))` | 10,000 | 500 ms | 510 MB | D2015 at 222 ms |
| a string doubled 40 times by recursion | 100,000 | 100 ms | 2.06 GB | D1012 at 148 ms |
| the same | 100,000 | 500 ms | 5.03 GB | D1012 at 1.34 s |
| `$pad("", 500000000)` | any | 500 ms | 6 MB | D3010: gnata caps `$pad` at 10,000 |

The sequence check runs after a mapping step has built its whole result, so
no limit bounds a cross product's memory, and string growth isn't a sequence
at all. The plan's step was to pick a limit that keeps a runaway expression
under about 100 MB. No limit that real mappings can live with does:

| Over a 9.4 MiB document with 100,000 items | limit 10,000 | limit 100,000 |
|---|---|---|
| `$count(nodes.orders.body.items)` | 12 ms | 8 ms, 26 MB |
| `$sum(nodes.orders.body.items.(price * qty))` | D2015 | 47 ms, 105 MB |
| `$count(nodes.orders.body.items[price > 40].sku)` | D2015 | 41 ms, 88 MB |
| `$count(nodes.orders.body.items^(>price))` | D2015 | 204 ms, 86 MB |

So the limit is 100,000, sized to the 10 MiB body cap. The timeout stays at
500 ms, above the 204 ms sort. Memory needs a process limit (06).

**Path values.** What a server did with each request path:
- Go 1.27's `ServeMux` had routes for `/v1/users/{id}/orders`,
  `/v1/admin/orders` and `/v1/users/orders`.
- nginx 1.27.5 forwarded to a backend that echoed the path it got, with
  `proxy_pass http://b/v1/;` (a URI part) or `proxy_pass http://b;` (none).

| Request path | Go `ServeMux` | nginx, with a URI | nginx, without |
|---|---|---|---|
| `/v1/users/7/orders` | the user's orders | `/v1/users/7/orders` | unchanged |
| `/v1/users/..%2Fadmin/orders` | the user's orders, id `../admin` | **`/v1/admin/orders`** | unchanged |
| `/v1/users/%2E%2E/admin/orders` | 404 | **`/v1/admin/orders`** | unchanged |
| `/v1/users/../admin/orders` | **redirected to `/v1/admin/orders`** | **`/v1/admin/orders`** | unchanged |
| `/v1/users//orders` | **redirected to `/v1/users/orders`** | **`/v1/users/orders`** | unchanged |
| `/v1/users/./orders` | **redirected to `/v1/users/orders`** | **`/v1/users/orders`** | unchanged |

`..`, `.` and an empty value come out of any escaper unchanged, since dots
are unreserved.

nginx with a URI on `proxy_pass` decodes the path, resolves dot segments
and merges slashes before it forwards. So an escaped slash is data only
until it reaches such a proxy. That's why a path value holding a slash is
refused rather than escaped.

## Decisions made while building

1. **Generated definition types.**
   - `schema/workflow.yaml` holds them, so the schema stays the source of
     truth, as CLAUDE.md says.
   - It's a file of its own because nothing serves it yet. In 03,
     `openapi.yaml` references it, and an oapi-codegen import mapping lets
     the HTTP layer reuse these same Go types.
   - `request` and `retry` are pointers, so nil means absent; other
     optional fields are plain values.
2. **Expressions are compiled by `engine.Compile`.** `workflow` imports
   nothing internal, so it can't compile JSONata. Compile merges its
   problems into `Validate`'s.
3. **Cycles are found with Tarjan's algorithm, not Kahn's.**
   - It names exactly the edges on a cycle, in linear time.
   - Checking, for each edge, whether its target leads back to its source
     was quadratic in edges. A dense 200-node graph could have made saving
     slow.
4. **Conditions and placeholders are wrapped**, as `$boolean(…)` and
   `$string(…)`, and evaluated by gnata. So their semantics are JSONata's
   own, not a Go copy.
   - Truthiness matches roadmap item 4.
   - Numbers keep their digits: a 64-bit id stays exact.
5. **Nothing is an error.**
   - When a body, transform, output or placeholder gives JSONata's
     undefined, the node or run fails instead of sending a silent `null`.
   - A condition that gives nothing is false.
   - A function value fails too: marshalled, it would dump its closure,
     data document included.
6. **The response.**
   - An empty body is `null`.
   - A 2xx body that isn't JSON fails as `decode`.
   - A non-2xx fails as `status`, and keeps its body when that's JSON.
   - After five redirects, the last 3xx fails as `status`.
7. **A path value can't hold a slash.** It's refused, not escaped (see Path
   values). A path parameter that legitimately spans segments, such as a
   file path, can't use a placeholder yet; an explicit multi-segment form
   could come later, still refusing dot segments.
8. **The `Idempotency-Key` value is bare** (`run-1:crm`), not the draft
   standard's quoted string, because most APIs document a bare token. A
   node that sets the header itself wins.
9. **Coverage floors.**
   - The first pass measured workflow 88.1%, transform 84.9%, upstream
     91.5% and engine 96.7%.
   - Each floor is that number rounded down, held in the justfile's
     `coverage_floors` and enforced by `just check`.
   - It was seen failing, on a raised floor and on a failing test.

## Divergences from this plan

- The sequence limit target, "under about 100 MB", can't be met. See
  Measurements.
- Tarjan instead of Kahn (decision 3), and compiling in `engine`, not
  `workflow` (decision 2).
- The engine's tests were written after its code. The other three
  packages' tests came first and were seen failing.

## Steps

- [x] `workflow`: generated types, `Validate`, cycle reporting. Table tests,
      one per validation code.
- [x] `transform`: the gnata wrapper with guardrails; templates; golden
      tests for this plan's expressions.
- [x] Measure gnata's peak memory at several sequence limits, then pick one.
- [x] `upstream`: the guarded client, timeouts, the size cap, retries and
      error kinds. SSRF tests cover each range, a decimal-IP host and a
      redirect to an internal address.
- [x] `engine`: the scheduler, outcomes, fail-fast, events and output.
      Tests:
      - the spec example end to end;
      - a skip cascade, and a join where only one edge is taken;
      - fail-fast cancelling an in-flight call;
      - a panicking node;
      - the concurrency limit honoured;
      - a deterministic start order;
      - only ancestors visible;
      - URL escaping;
      - the run timeout and the caller cancelling;
      - retries with an `Idempotency-Key`;
      - the document cap;
      - no goroutines left behind.
- [x] Coverage floors for the four packages.
- [x] go.md, CLAUDE.md, the README and repo.md updated.
- [x] See golangci-lint pass on this code. Its one finding was gosec G101
      on a test's deliberate URL credentials, suppressed on that line with
      the reason.

## Deferred

- **To 03:**
  - read `CONDUIT_ALLOW_PRIVATE_NETWORKS` and an upstream ports setting in
    `config`, once the server runs workflows;
  - record each node's sent request, for inspection;
  - a gnata panic in `Compile` isn't recovered; in 03 net/http's handler
    recovery would catch it.
- **To 06:**
  - a memory limit on the server's container;
  - a cap on a run's total held data: 200 nodes × 10 MiB is 2 GB;
  - redacting secrets from recorded requests.
- **Later:**
  - reject references to non-ancestors at save time, with gnata's
    `ReferencedPaths`;
  - evaluate expressions at save time too: a regex lookahead compiles and
    only fails when evaluated (D3137);
  - an *outcome unknown* state for an ambiguous POST failure, as in
    learning file 04.

## Out of scope

- Persistence, the HTTP API, SSE, serving, and `input_schema` checks: 03.
- Credentials: 06.
- Loops and continue-on-error: later.

## Open questions (answered 2026-10-25)

| # | Question | Answer |
|---|---|---|
| 1 | How to write `url`, headers and query: `{{ }}` templates, or JSONata expressions everywhere? | Templates. JSONata stays for `body`, `when`, `output` and transforms |
| 2 | Placeholders only in a URL's path and query, with scheme, host and port fixed when the workflow is saved? | Yes |
| 3 | Restrict node ids to `^[a-z][a-z0-9_]{0,63}$`? | Yes |
| 4 | Include `transform` nodes now? | Yes |
| 5 | Check run input against `input_schema` now? | No, in 03 |
| 6 | Is any non-2xx upstream response a node failure? | Yes in v1. Since plan 04 (2026-10-30), not a status the node lists as an output: that's an answer its edges can branch on |
