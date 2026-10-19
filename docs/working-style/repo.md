# Repo conventions

Layout, the task runner, pinned versions, CI, config and docs.

## Layout

```
conduit/
  CLAUDE.md            agent entry point; short, points into docs/
  CLAUDE.local.md      gitignored; local-only agent notes
  justfile             the one entry point; `just` lists every recipe
  server/              Go module: API + execution engine (go.md)
  web/                 React app (web.md)
  schema/              openapi.yaml: the API and the workflow definition;
                       codegen source for both sides
  docker/              compose files, Dockerfiles
  docs/plans/          numbered plans + index
  docs/working-style/  this folder
```

The layout is flat on purpose: two deployables don't need `apps/` +
`packages/`. Move to that shape when a third deployable appears, or
when a second consumer of shared TypeScript code does.

## just

- `default: @just --list`. Every recipe has a one-line comment, which shows
  in the list.
- `set shell := ["bash", "-euo", "pipefail", "-c"]`, so a failure anywhere
  in a pipe fails the recipe.
- Core recipes:

  | Recipe | Does |
  |---|---|
  | `setup` | install pinned tools, copy missing `.env` files from `.env.example` (`cp -n`) |
  | `dev` | Postgres up, migrate, server with reload, Vite |
  | `check` | format check, lint, typecheck, tests, generated-code diff. **The gate.** CI runs exactly this |
  | `fmt` | apply formatting |
  | `test *args` | tests, args passed through |
  | `gen` | regenerate code from `schema/` |
  | `db-migrate`, `db-reset` | migrations |
  | `hooks-install` | pre-push hook that runs `just check` |

- Start with one justfile. Once it passes ~15 recipes, split into
  `mod name 'just/name.just'` modules. Each module sets
  `working-directory` and says why.
- Recipes stay thin. Logic beyond a few lines becomes a small Go program or
  a script with a test, so it is typed and shell-independent.

## Pinned versions, one place each

| Tool | Pinned in |
|---|---|
| Go | `server/go.mod` `toolchain` line |
| Node | `web/.node-version` |
| pnpm | `web/package.json` `packageManager` (corepack) |
| JS dependencies | exact versions, `save-exact=true` |
| golangci-lint | justfile variable, used by `setup` and CI |
| Docker base images | tag + digest |

Nothing is "latest", and CI reads the same pins. An unpinned CI image
freezes on whatever compiler it was built with while laptops move on. Then
lint fails only in CI, on code that's clean everywhere else.

## CI

- One GitHub Actions pipeline: install the pinned tools, run `just check`,
  then build images on `main`.
- CI and local run the same command, so they can't drift. The pre-push hook
  is a convenience, not a gate. Hooks can be skipped with `--no-verify`, are
  missing in fresh clones, and never run for merges made in the web UI.
- A gate has to be able to fail. A check that isn't a gate yet says so in
  its name.
- Coverage floors only ratchet up.
- Generated code is committed. CI runs `just gen` and fails on
  `git diff --exit-code`.

## Config and env

- Config comes only from environment variables: `CONDUIT_*` for the server,
  `VITE_*` for the web app.
- Each component has a committed `.env.example`, split into commented
  sections. `.env` is gitignored.
- Secrets never go in the repo, in logs or in API responses.

## Docker

- `docker/compose.yaml` runs Postgres from a pinned tag, with a healthcheck,
  a named volume, and its port bound to `127.0.0.1`.
- `docker/Dockerfile.server` (distroless) and `docker/Dockerfile.web`
  (static files behind nginx). The build context is the repo root, with
  `.dockerignore` next to it.

## Docs

- `docs/plans/NN-slug.md` files, indexed in `docs/plans/README.md`
  (`# | Plan | Goal | Status`). Status is proposed, in progress or done.
- Plans are updated in place as work lands. The decision table in
  `00-roadmap.md` is the decision record, so there's no separate ADR folder.
- Learnings go to my learning repo, not this one; see how-i-like-to-work.md.
