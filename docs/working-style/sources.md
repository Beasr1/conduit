# Sources and battle test

What checking the working style against outside sources changed, what it
kept, and what stays contested. Done 2026-10-19.

✓ means re-checked first-hand that day (registry, README, changelog, or the
quoted line on the page). Unmarked links come from the research pass. They
resolve, but their claims weren't re-read.

## Changed

| Area | Was | Now | Why |
|---|---|---|---|
| Precedence | chat > docs > habits > best practice | no ranking; anything can be questioned, with a source | best practice is a reason to push back, not a tiebreaker |
| Go layout | hexagonal, interfaces in central `port/` packages | domain packages, interfaces at the consumer | go.dev: "interfaces generally belong in the package that uses values of the interface type" ✓ [1][2] |
| Router | gin | `net/http` ServeMux (D2) | stdlib has method + path patterns since Go 1.22 [3]; no dependency; gin's `c` used as a context ignores request cancellation by default (measured) |
| Logging | zap behind a shared logger without `With()` | `log/slog` | stdlib, structured, has `With()` [4]. The Go team: "It was never a goal to replace existing third-party logging packages" ✓. zap can run underneath slog through `go.uber.org/zap/exp/zapslog` if profiling ever says logging is hot ✓ |
| Config | kelseyhightower/envconfig | ~50 lines in `internal/config` | envconfig's last release was May 2019 ✓; stdlib is the default |
| Error→HTTP | `map[error]APIError` | ordered slice | map iteration is random, so an error matching two sentinels maps unpredictably |
| Responses | `{success, data, message, errors, meta}` envelope | the resource itself; errors as RFC 9457 problem details | the HTTP status already says success; 9457 is the standard error format, and its `errors[].pointer` example is what the editor and agents need ✓ [28] |
| Fan-out | bare `WaitGroup`, errors dropped with `_` | the scheduler owns state; per-node results; panic recovery | errgroup cancels on the first error, which only fits fail-fast [5] |
| Test doubles | hand-written mocks of repositories | real Postgres, `httptest` upstreams | a real dependency catches what a mock agrees to |
| CI | security scans only, no lint or test | CI runs `just check` | one command, locally and in CI, can't drift |
| Images | `FROM scratch`, no CA certs | `distroless/static` | it ships CA certificates, which outbound HTTPS needs [6] |
| Editor state | Jotai | Zustand | React Flow uses Zustand internally; TanStack says visual editors still need a client store [7][8] |
| Zod | schemas declared, never parsed | validate untrusted edges only; API types from codegen | a rule nobody enforces is noise |
| "no any, no as" | written in docs, broken in code | `no-explicit-any` as a lint error | "Never send an LLM to do a linter's job" [9] |
| TypeScript | latest is 7.0.2 ✓ | pin 6.0 | typescript-eslint 8.71.2 requires `typescript <6.1.0` ✓ |
| JSONata | jsonata-js only | gnata in Go; preview runs on the server | the only maintained JSONata 2.x in Go ✓ [10]; one evaluator means no parity gap. jsonata-js 2.x before 2.2.1 had code-execution advisories ✓ [29], and on `^(a+)+$` it ran 5.2 s past a 100 ms timeout while gnata took 0 ms (measured) |
| Redis | in the spec as the execution cache | not in v1 (D7) | durable records belong in a database [11][12]; one process needs no shared cache |
| SSRF | not applicable before | guard in the dialer, after DNS resolution | OWASP SSRF cheat sheet, case 2: apps that must call arbitrary URLs [13][14] |
| CLAUDE.md | long, everything inline | short; points to these docs | "target under 200 lines per CLAUDE.md file" ✓ [15] |
| Hard rules | prose only, and broken by agents again and again | also deny rules in `.claude/settings.json` for `git commit` / `git push` (recommended, not added) | rules that must always hold belong in settings or hooks [15][16] |
| shadcn primitives | Radix | shadcn's default | "Base UI as the Default", June 2026 ✓ [17] |
| Exact JS versions | `save-exact=true` in `.npmrc` | `saveExact: true` in `web/pnpm-workspace.yaml` | pnpm 12 doesn't read the `.npmrc` line: `pnpm config get save-exact` said `undefined`, and with the YAML setting a real `pnpm add` wrote `7.0.0` (checked 2026-10-20) |
| Base images | tag only | tag + digest, bumped by a bot | Docker: "pin the image version to a specific digest… even if a publisher replaces the tag" ✓ [30] |
| nginx image | official image (master process runs as root) | NGINX's non-root variant on 8080 | its README: "runs NGINX as a non root, unprivileged user" ✓ [31] |
| nginx security headers | headers copied from an older config, including `X-XSS-Protection` | nosniff, Referrer-Policy, Permissions-Policy, COOP, and a CSP chosen by content type with `frame-ancestors`; no `X-XSS-Protection` | OWASP: "Do not set this header or explicitly turn it off"; `frame-ancestors` "obsoletes X-Frame-Options" ✓ [32] |
| nginx header inheritance | `add_header` in locations | `add_header_inherit merge` | a location with its own `add_header` drops every server-level one; `add_header_inherit` arrived in 1.29.3 ✓ [33] |
| nginx access log | JSON including `Authorization` and the query string | JSON with a request id; path only, no credentials | a token in a log is a leaked token (measured: the query string stays out) |
| nginx error log | default level | rate-limit refusals below the logged level | error lines quote the whole request line, query string included (measured 2026-10-25) |
| nginx → server address | `proxy_pass` with a fixed host | Docker's DNS, resolved per request | measured: the server moved from .2 to .4 and requests still reached it |
| CI actions | `uses: owner/action@v7` | pinned to a full commit SHA, release in a comment | GitHub: pinning to a full-length commit SHA mitigates "a bad actor adding a backdoor to the action's repository" ✓ [34] |
| Installing golangci-lint | `go install` or a `tool` line | the release binary: `just setup` locally, the official action in CI | its docs: `go install`/`tool` installs "aren't guaranteed to work"; they recommend binaries, and their action for CI ✓ [35] |
| Dependency bumps | by hand | Dependabot with a 3-day cooldown | `cooldown` delays version updates by a set number of days ✓ [36] |
| MSW 3 strict mode | `onUnhandledRequest: "error"` | `onUnhandledFrame: "error"` | MSW 3 renamed it; the old option still compiles in plain JS and is ignored at run time (checked in its types and with a probe test, 2026-10-25) |
| openapi-typescript on TS 6 | (its peer range is `typescript: ^5.x`) | used with TypeScript 6.0.3 | generated `src/gen/schema.d.ts` correctly; pnpm reports the unmet peer (checked 2026-10-25) |
| Vulnerable tool dependencies | (none raised before) | raise the requirement directly | kin-openapi v0.142.0 had nine advisories, fixed in v0.143.0–v0.149.0. oapi-codegen v2.8.1 still requires v0.142.0, so we raised it to v0.152.0 ourselves, and `x/mod`/`x/text` to their fixed releases. Generated output is identical; OSV finds 0 vulnerabilities in compiled modules, and the server binary has no third-party modules at all (checked 2026-10-25) |
| New releases | install whatever is latest | nothing younger than about a day | pnpm 12 refused `@tanstack/react-query` 5.104.5, published the day before, with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` (checked 2026-10-20) |

## Kept, and backed

| Rule | Backed by |
|---|---|
| Explore, plan, code; skip the plan when the diff fits in a sentence | Anthropic best practices ✓ [16] |
| Verify with a real check; say what ran | "Give Claude a way to verify its work" ✓ [16] |
| Small changes, one logical change per commit | Google small CLs [18]; DORA |
| Trunk-based, short-lived branches | DORA [19] |
| Conventional commits | the spec [20] |
| No speculative abstractions; refactor on the third copy | Sandi Metz, "The Wrong Abstraction" [21] |
| No global state in libraries; wire in `main` | Peter Bourgon, "A theory of modern Go" [22] |
| Pinned toolchains; CI as the real gate | the Go toolchain directive [23]; a past CI toolchain drift |
| goose; pgx without an ORM | familiar; goose 3.29.0 ✓, pgx 5.11.0 ✓ |
| TanStack Query with key factories | TanStack docs [24] |
| React Router | familiar. Contested, see below |

## Contested: kept anyway, revisit if it hurts

| Rule | The other view | Why we keep it |
|---|---|---|
| One-line commits | git's docs and cbea.ms want a body that explains the why [25] | the why goes in the subject as a clause; longer reasoning goes in the plan |
| Coverage floors | coverage targets get gamed [26] | floors only on pure-logic packages, and they only ratchet up |
| React Router | TanStack Router has stronger type safety | familiar; few routes |
| Context files at all | ICLR 2026 paper: no significant gain, >20% more cost ✓ [27] | keep CLAUDE.md minimal; the substance lives in docs read on demand |
| gnata | created 2026-03-10 ✓, ported with AI, pre-1.0, breaking changes in 0.6.0 ✓ | the alternatives are stale (blues/jsonata-go targets JSONata 1.5.4). Pin it exact, wrap it, golden-test it |
| No Redis in v1 | the spec lists it | nothing in v1 needs it; agreed as D7 |

## gnata facts (checked ✓)

- MIT. v0.6.2 tagged 2026-10-18. 255 stars and 0 open issues on 2026-10-19.
- Reports 0 failures and 0 skips on the jsonata-js 2.2.2 test suite. Its
  README gives 1,778 cases in one place and 1,704 in another.
- Guardrails are opt-in: `WithTimeout`, `WithStack`, `WithSequence`. Always
  set them, since expressions are user-written.
- Regex is RE2, so lookahead, lookbehind and backreferences are
  unsupported. Numbers are float64 unless `WithDecimalPrecision` is set.
- Builds to WASM (~1.2–1.4 MB compressed) if browser-side evaluation is
  ever needed.
- jsonata-js 2.2.1 fixed prototype pollution (PR #799) ✓. Any JS use pins
  ≥ 2.2.2.
- Measured in the learning repo (api-orchestration file 03):
  - Guardrails bound time and depth, not memory. A sequence limit of
    1,000,000 fired only after a 5.5 GB peak.
  - The same `stack` number means different limits in different
    implementations: at 50, gnata allowed 49 recursive calls and the others
    15.
  - The README's case counts (1,778 and 1,704) don't match the portable
    suite's 1,686 cases.
- Measured in plan 02: the sequence limit is checked after a mapping step
  has built its result, so it can't bound a cross product's memory, and a
  limit of 10,000 broke real mappings over a 100,000-item response. The
  limit is 100,000.

## Versions on 2026-10-19 ✓

Go 1.27.2 · golangci-lint 2.15.0 · gin 1.12.0 · pgx 5.11.0 · goose 3.29.0 ·
gnata 0.6.2 · oapi-codegen 2.8.0 · code.dny.dev/ssrf 0.3.0 · x/sync 0.24.0 ·
React 19.3.1 · Vite 8.3.4 · TypeScript 7.0.2 · typescript-eslint 8.71.2 ·
@xyflow/react 12.12.0 · TanStack Query 5.104.4 · React Router 8.4.0 ·
Zustand 5.0.15 · Tailwind 4.3.3 · Zod 4.6.7 · react-hook-form 7.90.0 ·
Vitest 5.0.5 · MSW 3.0.3 · Playwright 1.64.1 · ESLint 10.13.0 ·
Prettier 3.9.10 · pnpm 12.14.0 · openapi-typescript 7.13.0 ·
openapi-fetch 0.17.0 · shadcn 4.22.1

## Links

1. https://go.dev/wiki/CodeReviewComments
2. https://go.dev/doc/modules/layout
3. https://go.dev/blog/routing-enhancements
4. https://go.dev/blog/slog
5. https://pkg.go.dev/golang.org/x/sync/errgroup
6. https://github.com/GoogleContainerTools/distroless
7. https://reactflow.dev/learn/advanced-use/performance
8. https://tanstack.com/query/latest/docs/framework/react/guides/does-this-replace-client-state
9. https://www.humanlayer.dev/blog/writing-a-good-claude-md
10. https://github.com/RecoLabs/gnata
11. https://docs.temporal.io/encyclopedia/retry-policies
12. https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dags.html
13. https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
14. https://pkg.go.dev/code.dny.dev/ssrf
15. https://code.claude.com/docs/en/memory
16. https://code.claude.com/docs/en/best-practices
17. https://ui.shadcn.com/docs/changelog
18. https://google.github.io/eng-practices/review/developer/small-cls.html
19. https://dora.dev/capabilities/trunk-based-development/
20. https://www.conventionalcommits.org/en/v1.0.0/
21. https://sandimetz.com/blog/2016/1/20/the-wrong-abstraction
22. https://peter.bourgon.org/blog/2017/06/09/theory-of-modern-go.html
23. https://go.dev/doc/toolchain
24. https://tanstack.com/query/latest/docs/framework/react/guides/query-keys
25. https://cbea.ms/git-commit/
26. https://testing.googleblog.com/2020/08/code-coverage-best-practices.html
27. https://arxiv.org/abs/2602.11988
28. https://www.rfc-editor.org/rfc/rfc9457.html
29. https://github.com/jsonata-js/jsonata/security/advisories
30. https://docs.docker.com/build/building/best-practices/
31. https://github.com/nginx/docker-nginx-unprivileged
32. https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html
33. https://nginx.org/en/docs/http/ngx_http_headers_module.html
34. https://docs.github.com/en/actions/reference/security/secure-use
35. https://github.com/golangci/golangci-lint/tree/main/docs/content/docs/welcome/install
36. https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference

Also used while designing the engine: Windmill OpenFlow
(https://www.windmill.dev/docs/openflow), Kestra outputs
(https://kestra.io/docs/workflow-components/outputs), n8n execution order
(https://docs.n8n.io/flow-logic/execution-order/), the Idempotency-Key draft
(https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header),
DBOS Transact Go (https://github.com/dbos-inc/dbos-transact-golang).
