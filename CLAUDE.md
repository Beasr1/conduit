# Conduit

No-code API orchestration. Users compose upstream API calls into a DAG,
using a graph editor or a page-by-page builder, and map data between steps
with JSONata. A Go engine runs it, fanning out in parallel.

**Status: plans 12, 13 and 14 are built (2026-11-02), on plan 04's graph
editor: Publish waits until every way a run can go reaches an answer and
every step's failures are decided, every error is answered in one shape,
the response picks its answer top to bottom, and the editor says only what
a field is, with a short tour and one-line hints. Plan 06's loop guard is
built too: a workflow calling itself is refused after 8 hops. Plan 07's
upstreams are built (2026-11-03): a library of them, each save that
changes something a version that never changes, which a step uses at a
pinned version, edited in place from the step or on the upstream's own
page; Publish takes only steps that use one, a published workflow is one
too, and an upstream no saved revision pins can be deleted.**
The web app signs in with a session cookie, which sign-out or 30 minutes
unused ends, lists workflows and creates them, and edits, checks, saves
and publishes one in graph mode, previewing what each step reads and sends
over sample data, branching on the status a step gets back, and running it
with an input, followed live on the canvas. A step is drawn as its request
and a block per response, and a click opens that part, under two rows of
tabs. Each answer on the response card takes lines from any number of
steps, and a run gives the first answer, top to bottom, that one reached;
Publish finds a line an answer above always beats. Every run is in a W3C
trace, its caller's or its own, and its calls carry it on; a call 8 hops
in, a workflow calling itself, is refused, and one workflow may have a
quarter of the server's runs at once (plan 06). A line from a step's
Unhandled into an answer is drawn only while picked, and the Unhandled
names the answer. A transform's cases are its exits, a tab each with its
condition, JSONata and status: the first that holds answers as an HTTP
step does, down its own lines, and none holding fails the step into its
Unhandled. A step's Unhandled block takes its failures, giving a body you
write if you write one, and the run goes on down its line; or the step
fails the run, as chosen. The error body, problem details unless you write
one, answers a run that gives none, and an answer passing an error on. An
HTTP step runs only when every line into it is taken; a transform waits
for them all too, and runs if every line marked required came and, with
none marked, any did, its expression making its value from what did. Its
preview is a run by each line into it, over what those runs read, merged,
and every Input tags a step a run may come without, or that may answer
more than one way. A run records the lines each step's answer took. An
Upstreams page beside Workflows is the library: an upstream is one API
call and how it's handled, with parameters its request reads. A step that
uses one gives the parameters values, its request and responses the
upstream's version's, is offered a newer version, and can edit the
upstream in place, saving its next version. Add HTTP step makes a new
upstream from a call and its samples, one input object and each response
it can give; a step with a request of its own, from before,
still runs, Publish refuses it, and Save as upstream moves it to the
library. A step can use a published workflow instead, at the revision
served: it gives the workflow's input fields values, its responses the
workflow's answers, previewed by the workflow's own preview, and it runs
as a run of its own, linked to its caller, a hop further in its trace. A
workflow can't use itself, directly or through others. An upstream's page
deletes it once no saved revision of any workflow pins it. What was built, and why, is in docs/plans/04-graph-editor.md, 12-strengthening.md,
13-minimal-editor.md, 14-the-response-picks.md, 06-hardening.md and
07-tests-and-catalogue.md; the bigger picture is docs/plans/README.md.

## Read before working

- docs/working-style/how-i-like-to-work.md: how we work. Binding.
- docs/working-style/go.md, web.md, design.md, repo.md: read the one for
  the area you touch. design.md is for anything a user sees.
- docs/plans/: what's being built, the decisions, current status.

## Hard rules

- Question my decisions at every level: chat, these docs, my habits. When
  best practice disagrees, say so before acting, with a source. I decide.
- Never `git commit` or `git push`. I commit. When I ask, stage the changes
  and suggest a one-line conventional commit message, with no
  Co-Authored-By trailer.
- Stage by file name only. Never `git add -A`, `-u` or `.`.
- Never say a check passed unless it ran in this session. Say what ran.
- Ambiguous spec: use AskUserQuestion with 2–4 options, recommended first.
- Keep it simple. No speculative abstractions. No new dependency without a
  one-sentence reason. No mocks for things that run locally.
- Never run Python, not even a one-off script or `python3 -c`. Use Go,
  Node or shell tools.
- In replies, write file references as plain `path/to/file.go:42`, not
  markdown links.
- Committed files never say where a pattern came from: no other repos,
  companies or people. Local-only references live in CLAUDE.local.md
  (gitignored).

## Layout

- `server/`: Go module. `cmd/conduit`, plus `internal/` packages `config`,
  `workflow`, `engine`, `transform`, `upstream`, `trace`, `store`, `runner`
  and `httpapi`; `migrations/` holds the goose SQL.
- `web/`: React app.
- `schema/openapi.yaml`: source of truth for API types on both sides.
- `schema/workflow.yaml`: the workflow definition; the Go types in
  `internal/workflow` are generated from it.
- `docker/`: a directory per service (`postgres`, `server`, `web`) with its
  compose file, and its Dockerfile when we build one. `docker/compose.yaml`
  includes them all.
- `docs/`: plans and working style.

## Commands

```
just                list recipes
just setup          create .env; install the pinned golangci-lint and corepack (.tools/bin), web dependencies and Chromium
just db-up          Postgres on 127.0.0.1:5432; db-reset deletes it and starts afresh
just migrate        apply migrations; `just migrate status` lists them
just dev            Postgres, the server, the web app and the test upstream together; Ctrl-C stops them
just dev-server     API server on http://127.0.0.1:8080, after db-up and migrate
just dev-web        web app on http://127.0.0.1:5173; /api is proxied to the server
just upstream       the test upstream on http://127.0.0.1:8090, to try runs against
just check          the gate: format, lint, race tests, coverage floors, typecheck, the browser test on a build, stale generated code
just e2e            the browser tests: plan 04's Done flow and plan 07's library, in Chromium, against their own database, server and test upstream
just fmt            apply formatting: gofumpt + goimports, Prettier
just test           Go and web tests
just gen            regenerate the HTTP layer, the workflow types and web/src/gen from schema/
just hooks-install  pre-push hook that runs just check
just up / down      everything in Docker behind nginx on http://127.0.0.1:8088
just images         build the Docker images without starting them, and test nginx's config
```

CI (`.github/workflows/ci.yml`) runs `just setup` and `just check`, and
`just images` as a job of its own.

## Gotchas

- Generated code (`server/internal/httpapi/gen`,
  `server/internal/workflow/definition.gen.go`, `web/src/gen`) is never
  edited by hand. Change `schema/` and run `just gen`.
- Settings are in two gitignored files, each loaded only where it's needed:
  `.env` for setup (compose's passwords, the tests' database URLs) and
  `server/.env` for the server. `just setup` makes both from their
  `.env.example`. Store and HTTP tests need Postgres: `just test` and
  `just check` start it.
- `just dev` lets its server call private networks and port 8090, so runs
  reach the test upstream. `just up` is as production is: runs there reach
  only public addresses on 80 and 443.
- One server per database. At startup a server marks every run still
  running as failed (D8), so `just dev` and `just up`, which share the
  compose Postgres, shouldn't run at once, and a deploy must stop the old
  server before starting the new one.
- Coverage floors live in the justfile. Raise one when coverage rises;
  never lower one to get `just check` passing.
- The browser test (`just e2e`) runs on ports 14173, 18080 and 18090,
  against a database of its own, `conduit_e2e`, made afresh each time, so
  it runs beside `just dev`; Playwright starts and stops the pieces. A
  `.spec.ts` in `web/e2e` is Playwright's, and Vitest skips it.
- All outbound HTTP goes through `internal/upstream`, which applies the
  SSRF guard, timeouts and size caps, and passes the run's W3C trace on,
  one hop further. Never use `http.DefaultClient`.
- A call 8 hops into a trace is refused with 508, and a workflow may have
  a quarter of `CONDUIT_MAX_RUNS` in progress (plan 06). A test that
  starts many runs of one workflow needs a cap that allows them.
- JSONata is untrusted user code. Evaluate it only through
  `internal/transform`, with guardrails on.
- Everything the UI does goes through `schema/openapi.yaml`; no UI-only
  logic. Future agents (plan 08) use the same API.
- TypeScript stays on 6.0.x until typescript-eslint supports 7.
- npm packages younger than a day are refused (pnpm's release-age guard,
  `minimumReleaseAge` in `web/pnpm-workspace.yaml`). It's set explicitly
  because pnpm's own default isn't strict and let exact pins through. Pick
  a slightly older version; don't turn the guard off.
- Safari can't sign in over plain http. WebKit drops `Secure` cookies on
  `127.0.0.1` and `localhost` alike, so use Chrome or Firefox with
  `just dev` and `just up`; Safari works over https (plan 04, answer 8).
- A web test fails on any console warning or error it logs
  (`web/src/test/console.ts`). Fix the cause; don't silence the console.
- The page's CSP (nginx) refuses inline styles and eval, and jsdom has no
  CSP, so a violation shows only in a browser through `just up`. A rule a
  Base UI part would inject as `<style>` goes in `web/src/index.css`
  (web.md).
