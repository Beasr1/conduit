# Conduit

**Compose APIs into APIs.** Wire upstream endpoints into a graph, map data
between them with JSONata, and publish the whole workflow as its own
endpoint. Go engine, React editor.

**Status:** the API works; the editor is next. Workflows are saved as
revisions, run in the background with live events, and published at their
own endpoint. The web app is still a shell. The plan is in
[docs/plans](docs/plans/README.md).

## Run it

You need Go, Node 24 (which ships corepack), [just](https://github.com/casey/just)
and Docker. `server/go.mod` pins Go 1.27.3, and an older `go` downloads it on
first use. corepack runs the pnpm version that `web/package.json` pins.

| Command | What it does |
|---|---|
| `just setup` | creates `.env` (setup settings) and `server/.env` (the server's) from their examples, installs the pinned golangci-lint and the web dependencies |
| `just db-up` | Postgres on 127.0.0.1:5432 (`just db-reset` starts it afresh) |
| `just migrate` | applies database migrations |
| `just dev` | Postgres, the API server and the web app together; Ctrl-C stops them |
| `just dev-server` | API server on http://127.0.0.1:8080, against that Postgres |
| `just dev-web` | web app on http://127.0.0.1:5173, with `/api` proxied to the server |
| `just up` / `just down` | both in Docker behind nginx, on http://127.0.0.1:8088 |
| `just check` | the gate CI runs: format, lint, race tests, coverage floors, typecheck, build and generated-code drift |
| `just gen` | regenerates server and web code from `schema/` |
