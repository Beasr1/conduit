# Conduit

No-code API orchestration. Users compose upstream API calls into a DAG,
using a graph editor or a page-by-page builder, and map data between steps
with JSONata. A Go engine runs it, fanning out in parallel.

**Status: engine built (plan 02), not yet wired to the API (03).** A server
with a health route, a web shell, nginx and Docker, plus the workflow engine
as a library. What's left is in docs/plans/02-engine.md and
01-foundation.md; the bigger picture is docs/plans/README.md.

## Read before working

- docs/working-style/how-i-like-to-work.md: how we work. Binding.
- docs/working-style/go.md, web.md, repo.md: read the one for the area you
  touch.
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
  `workflow`, `engine`, `transform`, `upstream`, `store` and `httpapi`.
  `store` doesn't exist yet (03).
- `web/`: React app.
- `schema/openapi.yaml`: source of truth for API types on both sides.
- `schema/workflow.yaml`: the workflow definition; the Go types in
  `internal/workflow` are generated from it.
- `docker/`: compose files and Dockerfiles.
- `docs/`: plans and working style.

## Commands

```
just                list recipes
just setup          install the pinned golangci-lint (.tools/bin) and web dependencies
just dev-server     API server on http://127.0.0.1:8080
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
- Coverage floors live in the justfile. Raise one when coverage rises;
  never lower one to get `just check` passing.
- All outbound HTTP goes through `internal/upstream`, which applies the
  SSRF guard, timeouts and size caps. Never use `http.DefaultClient`.
- JSONata is untrusted user code. Evaluate it only through
  `internal/transform`, with guardrails on.
- Everything the UI does goes through `schema/openapi.yaml`; no UI-only
  logic. Future agents (plan 08) use the same API.
- TypeScript stays on 6.0.x until typescript-eslint supports 7.
- npm packages younger than about a day are refused (pnpm's release-age
  guard). Pick a slightly older version; don't turn the guard off.
