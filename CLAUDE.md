# Conduit

No-code API orchestration. Users compose upstream API calls into a DAG,
using a graph editor or a page-by-page builder, and map data between steps
with JSONata. A Go engine runs it, fanning out in parallel.

**Status: planning.** There's no code yet. Start at docs/plans/README.md.
The commands below arrive with plan 01.

## Read before working

- docs/working-style/how-i-like-to-work.md: how we work. Binding.
- docs/working-style/go.md, web.md, repo.md: read the one for the area you
  touch.
- docs/plans/: what's being built, the decisions, current status.

## Hard rules

- Question my decisions at every level: chat, these docs, my habits. When
  best practice disagrees, say so before acting, with a source. I decide.
- Never `git commit` or `git push` unless I ask for that specific commit.
  Leave changes uncommitted and suggest a one-line conventional commit
  message. No Co-Authored-By trailer.
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
- `web/`: React app.
- `schema/openapi.yaml`: source of truth for API and workflow-definition
  types on both sides.
- `docker/`: compose files and Dockerfiles.
- `docs/`: plans and working style.

## Commands (from plan 01)

```
just              list recipes
just setup        install pinned tools, create .env files
just dev          postgres + server + web, with reload
just check        fmt check, lint, typecheck, tests, codegen diff; CI runs the same
just fmt          apply formatting
just gen          regenerate code from schema/
just db-migrate   apply migrations
```

## Gotchas

- Generated code (`server/internal/httpapi/gen`, `web/src/gen`) is never
  edited by hand. Change `schema/openapi.yaml` and run `just gen`.
- All outbound HTTP goes through `internal/upstream`, which applies the
  SSRF guard, timeouts and size caps. Never use `http.DefaultClient`.
- JSONata is untrusted user code. Evaluate it only through
  `internal/transform`, with guardrails on.
- Everything the UI does goes through `schema/openapi.yaml`; no UI-only
  logic. Future agents (plan 08) use the same API.
- TypeScript stays on 6.0.x until typescript-eslint supports 7.
