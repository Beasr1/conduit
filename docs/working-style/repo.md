# Repo conventions

Layout, the task runner, pinned versions, CI, config and docs.

## Layout

```
conduit/
  CLAUDE.md            agent entry point; short, points into docs/
  CLAUDE.local.md      gitignored; local-only agent notes
  .vscode/             shared editor settings and recommended extensions
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
  | `setup` | install the pinned golangci-lint into `.tools/bin`, and the web dependencies |
  | `dev` | Postgres, the server and Vite together. Ctrl-C stops them, Postgres only if `dev` started it |
  | `dev-server`, `dev-web` | the server, and Vite with `/api` proxied to it |
  | `check` | format, lint, race tests, coverage floors, typecheck, build, generated-code drift. **The gate.** CI runs exactly this |
  | `fmt` | apply formatting |
  | `test *args` | Go and web tests; args pass through to `go test` |
  | `gen` | regenerate code from `schema/` |
  | `hooks-install` | pre-push hook that runs `just check` |
  | `up`, `down` | the Docker stack |
  | `db-up`, `db-reset` | Postgres from compose, on 127.0.0.1:5432; reset deletes the volume |
  | `migrate *args` | `conduit migrate`; `up` by default |
  | `dev` | everything at once: arrives in plan 03 phase C |

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
| JS dependencies | exact versions, via `saveExact: true` in `web/pnpm-workspace.yaml`; nothing younger than pnpm's release-age cutoff |
| golangci-lint | justfile variable, used by `setup` and CI |
| Docker base images | tag + digest |

Nothing is "latest", and CI reads the same pins. An unpinned CI image
freezes on whatever compiler it was built with while laptops move on. Then
lint fails only in CI, on code that's clean everywhere else.

## CI

- One GitHub Actions workflow, `.github/workflows/ci.yml`:
  - Actions are pinned to full commit SHAs, with the release in a comment.
    GitHub's hardening guide recommends this, because a tag can be moved.
  - It installs the pinned tools, then runs `just setup` and `just check`.
  - Building and publishing images comes later.
- Dependabot (`.github/dependabot.yml`) bumps Docker digests, actions, Go
  modules and npm packages weekly, with a 3-day cooldown matching pnpm's
  release-age guard.
- CI and local run the same command, so they can't drift. The pre-push hook
  is a convenience, not a gate. Hooks can be skipped with `--no-verify`, are
  missing in fresh clones, and never run for merges made in the web UI.
- A gate has to be able to fail. A check that isn't a gate yet says so in
  its name.
- Coverage floors only ratchet up. They're the `coverage_floors` variable
  in the justfile, checked by the private `_coverage` recipe that `check`
  runs.
- Generated code is committed. CI runs `just gen` and fails on
  `git diff --exit-code`.

## Editor

- `.vscode/settings.json` formats on save only with the formatters
  `just check` runs (gofumpt, Prettier), so the editor and CI can't
  disagree. Generated code opens read-only.
- `.vscode/extensions.json` lists the recommended extensions; VS Code
  offers them on first open.
- Personal preferences go in your user settings, not here. `.gitignore`
  keeps the rest of `.vscode/` out, using GitHub's standard template.

## Config and env

- Config comes only from environment variables: `CONDUIT_*` for the server,
  `VITE_*` for the web app.
- Each component has a committed `.env.example`, split into commented
  sections. `.env` is gitignored. Today there are two:
  - `.env` at the root, for setup: compose's database passwords and the
    tests' database URLs.
  - `server/.env`, for the server: what `internal/config` reads.

  Each recipe loads only the file it needs, with no `set dotenv-load`, so
  the server process never sees the database superuser's password.
- Secrets never go in the repo, in logs or in API responses.

## Docker

- **Base images are pinned by tag and digest.** The tag is for people; the
  digest is what gets pulled, so a republished tag can't change a build.
  The catch: a digest never picks up patches by itself, so a bot
  (Dependabot or Renovate) has to bump them.
- **One directory per service**, holding its compose file and, when we
  build an image, its Dockerfile:
  - `docker/postgres/`: the official image, as it is, configured by flags
    and `init.sh`. No Dockerfile, since there's nothing to build.
  - `docker/server/`: distroless and non-root. The same image runs
    `conduit migrate up` as a one-shot service before the server starts,
    so migrations need no image of their own.
  - `docker/web/`: the web build behind nginx's non-root image, with its
    config in `nginx/`.
  - A new service, such as Redis when a plan needs it, is a new directory
    plus one line in the top-level file.
- **`docker/compose.yaml` only `include`s them.** Each included file
  resolves its paths from its own directory, and together they make one
  project on one network. Stacking files with `-f` instead resolves every
  path from the first file.
- **`docker/base.yaml`** holds what every service `extends`: read-only,
  no capabilities, `no-new-privileges`, rotated logs. YAML anchors can't
  cross files, so it's written once there.
- **Exposure.** Only nginx (127.0.0.1:8088) and Postgres (127.0.0.1:5432,
  for the host's tests and `just dev-server`) are published, and only on
  loopback. The build context is the repo root, with `.dockerignore` next
  to it.
- **`docker/web/nginx/`, one file per topic.**
  - `conf.d/` loads inside nginx's `http {}` block in file-name order. The
    numbered files define things: `00-logging` (log format),
    `10-security` (CSP map), `20-limits` (rate-limit zones) and
    `30-compression`. `default.conf` is the server, and it uses them.
  - `snippets/` holds pieces a location includes: `security-headers.conf`
    and `proxy.conf`.
  - A new topic gets its own numbered file rather than growing
    `default.conf`.
- **What the nginx config does.**
  - The access log is JSON on stdout, with a request id and no credentials
    or query strings.
  - Security headers go on every response, with the CSP chosen by content
    type. `add_header_inherit merge` stops a location's own headers from
    dropping them.
  - `/api/` and `/serve/` are rate-limited and body-capped, and a client
    address may have 20 requests in progress across them. `/serve/`
    reaches the server unchanged. The server turns buffering off for event
    streams with `X-Accel-Buffering: no`.
  - The server is found through Docker's DNS on every request, so
    recreating it doesn't strand nginx on an old IP.

## Docs

- `docs/plans/NN-slug.md` files, indexed in `docs/plans/README.md`
  (`# | Plan | Goal | Status`). Status is proposed, in progress or done.
- Plans are updated in place as work lands. The decision table in
  `00-roadmap.md` is the decision record, so there's no separate ADR folder.
- Learnings go to my learning repo, not this one; see how-i-like-to-work.md.
