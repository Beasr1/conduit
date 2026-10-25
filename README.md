# Conduit

**Compose APIs into APIs.** Wire upstream endpoints into a graph, map data
between them with JSONata, and publish the whole workflow as its own
endpoint. Go engine, React editor.

**Status:** early scaffold. A server with a health route, a web shell, and
nginx in front of both in Docker. The plan is in
[docs/plans](docs/plans/README.md).

## Run it

You need Go, Node 24 (which ships corepack), [just](https://github.com/casey/just)
and Docker. `server/go.mod` pins Go 1.27.2, and an older `go` downloads it on
first use. corepack runs the pnpm version that `web/package.json` pins.

| Command | What it does |
|---|---|
| `just setup` | installs the web dependencies |
| `just dev-server` | API server on http://127.0.0.1:8080 |
| `just dev-web` | web app on http://127.0.0.1:5173, with `/api` proxied to the server |
| `just up` / `just down` | both in Docker behind nginx, on http://127.0.0.1:8088 |
| `just check` | format check, vet, race tests, typecheck and build |
