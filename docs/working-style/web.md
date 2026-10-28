# Web style

For `web/`. Code only; how we work is in how-i-like-to-work.md.

Built from what worked in earlier React codebases, minus what went wrong in
them (sources.md).

## Stack

Pin exact versions (`saveExact: true` in `web/pnpm-workspace.yaml`; pnpm 12
ignores `save-exact` in `.npmrc`). pnpm also refuses releases younger than a
day: `minimumReleaseAge: 1440`, set explicitly in the same file. pnpm's
built-in default is the same value but not strict, so an exact pin got past
it. Keep that guard on: pick a slightly older version instead.

| Concern | Choice |
|---|---|
| Build | Vite 8 |
| UI | React 19 |
| Language | TypeScript 6.0, strict. Move to 7 once typescript-eslint supports it (its peer range stops at `<6.1.0`) |
| Routing | React Router 8, data mode |
| Server state | TanStack Query 5 |
| Editor state | Zustand 5, one store per open editor |
| Graph | @xyflow/react 12 (v13 is pre-release) |
| Forms | react-hook-form + Zod 4 |
| Components | shadcn/ui on Base UI (shadcn's default since July 2026), Tailwind 4, lucide icons |
| Toasts | shadcn's Toast, built on Base UI |
| API client | openapi-fetch, typed from `src/gen` (openapi-typescript output from `schema/openapi.yaml`), behind `call` in `lib/api.ts` for timeouts and error kinds |
| Tests | Vitest, Testing Library, MSW; Playwright for the editor's happy path |
| Lint and format | ESLint flat config + typescript-eslint + react-hooks; Prettier + tailwind plugin |
| Package manager | pnpm, pinned via `packageManager` |

One library per concern. Adding a second toast, icon or table library blocks
review; duplicates creep in one PR at a time.

## Layout

```
web/src/
  main.tsx
  router.tsx             route table + route builders (routes.workflow(id))
  lib/                   api.ts, query-client.ts, problems.ts
  gen/                   generated from schema/, never edited
  components/ui/         shadcn components (our code, edit freely)
  components/            app-wide composites
  features/<feature>/    components/, hooks/, store.ts, pure *.ts
  routes/<segment>.tsx   pages, loaded lazily; thin, they compose features
  test/                  what tests share: the MSW server, render helpers, fixtures
```

`lib/env.ts` comes with the first setting the app needs. There's none yet:
the API is `/api` on the page's own origin.

- File names are kebab-case and components PascalCase. Named exports only;
  default exports only where a tool demands it (`vite.config.ts`).
- Import from `src` through the `@/` alias. No `../` across features.
- No barrel `index.ts` files inside the app.
- A feature never reaches into another feature's internals. Code moves to
  `components/` or `lib/` when a second feature needs it.

## Routing

- A page is a lazy route module exporting `Component`. `router.tsx` never
  imports a page, so pages can import `routes` from it.
- What shows before a page's code is in, or when it fails to load, can't
  come from that code. The root route holds the first-load fallback and the
  error boundary for 404s; a pathless route under the layout holds the
  pages' boundary, so the header stays when a page fails.
- A route that renders nothing still names a `Component` (`Outlet`, or
  `() => null` behind a loader that redirects), or React Router warns.

## TypeScript

- tsconfig enables `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `verbatimModuleSyntax`, `noUnusedLocals` and
  `noUnusedParameters`.
- `any` is a lint error. `as` is only for a boundary we can't type any
  other way, with a one-line why.
- Types for API data come from `src/gen`. Don't hand-write a type for
  something the API returns.

## Data

- All server data goes through TanStack Query. No `fetch` inside
  `useEffect`.
- Query keys come from one factory per resource (`workflowKeys.detail(id)`).
  No inline key arrays.
- There is one API client, in `lib/api.ts`:
  - requests go to `/api` on the page's own origin, which nginx and Vite's
    dev proxy forward to the server;
  - timeouts use `AbortSignal.timeout`;
  - errors are normalised into kinds: offline, timeout, unauthorised,
    client, server.
- Error toasts come from the global `QueryCache` / `MutationCache`
  `onError`. A component handles an error only when it can do something
  about it, and then marks its query or mutation `meta: { quiet: true }`.
- A `401` anywhere sends the app to sign-in, carrying where you were.
- Server data never gets copied into Zustand. The editor store holds the
  draft; the saved version lives in the query cache.
- Zod is for untrusted edges only: env, forms, imported files. API
  responses are typed by codegen and not parsed again. A schema that's
  declared but never parsed is noise.

## Editor (React Flow)

- The workflow definition from the API is the model. React Flow nodes and
  edges are a view of it, built by `toFlow(definition)`, a pure, tested
  function in `features/editor`. Edits change the definition, and the view
  follows; nothing is read back from the canvas.
- Graph mode and page mode edit the same definition. Page mode is a
  constrained view: ordered pages, and the nodes on a page run in
  parallel. A definition that doesn't fit page mode opens in graph mode.
- Node positions live in the definition's optional `ui` block, and nodes
  are draggable. The editor places a node that has no position (in a
  definition made through the API, or one just added), and the next save
  writes it. The server stores positions and never computes one.
- Define `nodeTypes` and `edgeTypes` at module scope. Wrap custom nodes in
  `memo` and keep handlers stable.
- Read store slices through selectors. Never subscribe to the whole nodes
  array.
- The first edit writes down where every node is drawn (`settle`), so a
  node placed automatically never moves under the user.
- Blocking cycles in the UI (`isValidConnection`) is only for UX. Server
  validation is the source of truth.
- JSONata preview calls the server's preview endpoint. The `jsonata` npm
  package never runs in the browser, because preview results must match
  what the engine does.
- Each open run reads its event stream with one `fetch()` (D9), not
  `EventSource`, which hides a failed connection's status. Events update
  node status in the query cache.

## Components and styling

- Function components. Props are typed next to the component.
- Split a file once it passes ~250 lines or a page juggles a pile of
  `useState`s.
- Theme tokens only: no raw hex, arbitrary values or inline styles.
  Enforce it with `@shadcn/lint`. Its token rules are off in
  `components/ui`, which the shadcn CLI writes.
- Dark mode follows the system (`prefers-color-scheme`); there's no toggle.
- Add primitives with the shadcn CLI and then adapt them. Don't hand-roll
  them.
- A link that looks like a button is a `Link` styled with
  `buttonVariants()`. A `Button` rendering a link would be announced as a
  button.

## Tests

- Pure logic gets unit tests first: `toFlow`, the page-mode
  conversion, mapping helpers.
- Component tests render with providers and MSW handlers. They assert what
  a user sees (roles, text), not the implementation. `src/test/` has the
  one MSW server, `renderAt` for a component, `renderRoutes` for a route
  tree such as the app's, and fixtures.
- MSW handlers and fixtures are typed from `src/gen`.
- A test that renders the canvas calls `shimReactFlow()`
  (`src/test/react-flow.ts`): jsdom does no layout, and React Flow measures
  nodes before it draws edges.
- A test fails on any console warning or error it logs
  (`src/test/console.ts`). That's how React, React Router and Base UI
  report misuse. Vitest would only print it, and hides passing tests'
  output when it detects an AI agent running it.
- Start the MSW server with `onUnhandledFrame: "error"`, so a request with no
  handler fails the test. MSW 3 renamed it from `onUnhandledRequest`, and
  the old name is silently ignored at run time.
- Playwright covers one flow against the real server and Postgres: create a
  workflow, connect two upstreams, run it, see the results.
