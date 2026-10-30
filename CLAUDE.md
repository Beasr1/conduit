# Conduit

No-code API orchestration. Users compose upstream API calls into a DAG,
using a graph editor or a page-by-page builder, and map data between steps
with JSONata. A Go engine runs it, fanning out in parallel.

**Status: plan 04, the graph editor, is under way: phase A is committed,
phase B is built (2026-10-30).** The web app signs in with a session
cookie, lists workflows and creates them, and edits, checks, saves and
publishes one in graph mode. What is left is in
docs/plans/04-graph-editor.md; the bigger picture is docs/plans/README.md.

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
  `workflow`, `engine`, `transform`, `upstream`, `store`, `runner` and
  `httpapi`; `migrations/` holds the goose SQL.
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
just setup          create .env; install the pinned golangci-lint (.tools/bin) and web dependencies
just db-up          Postgres on 127.0.0.1:5432; db-reset deletes it and starts afresh
just migrate        apply migrations; `just migrate status` lists them
just dev            Postgres, the server and the web app together; Ctrl-C stops them
just dev-server     API server on http://127.0.0.1:8080, after db-up and migrate
just dev-web        web app on http://127.0.0.1:5173; /api is proxied to the server
just check          the gate: format, lint, race tests, coverage floors, typecheck, build, stale generated code
just fmt            apply formatting: gofumpt + goimports, Prettier
just test           Go and web tests
just gen            regenerate the HTTP layer, the workflow types and web/src/gen from schema/
just hooks-install  pre-push hook that runs just check
just up / down      everything in Docker behind nginx on http://127.0.0.1:8088
```

CI (`.github/workflows/ci.yml`) runs `just setup` and `just check`.

## Gotchas

- Generated code (`server/internal/httpapi/gen`,
  `server/internal/workflow/definition.gen.go`, `web/src/gen`) is never
  edited by hand. Change `schema/` and run `just gen`.
- Settings are in two gitignored files, each loaded only where it's needed:
  `.env` for setup (compose's passwords, the tests' database URLs) and
  `server/.env` for the server. `just setup` makes both from their
  `.env.example`. Store and HTTP tests need Postgres: `just test` and
  `just check` start it.
- One server per database. At startup a server marks every run still
  running as failed (D8), so `just dev` and `just up`, which share the
  compose Postgres, shouldn't run at once, and a deploy must stop the old
  server before starting the new one.
- Coverage floors live in the justfile. Raise one when coverage rises;
  never lower one to get `just check` passing.
- All outbound HTTP goes through `internal/upstream`, which applies the
  SSRF guard, timeouts and size caps. Never use `http.DefaultClient`.
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
