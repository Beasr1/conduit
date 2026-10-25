# Web style

For `web/`. Code only; how we work is in how-i-like-to-work.md.

Built from what worked in earlier React codebases, minus what went wrong in
them (sources.md).

## Stack

Pin exact versions (`saveExact: true` in `web/pnpm-workspace.yaml`; pnpm 12
ignores `save-exact` in `.npmrc`). pnpm also refuses releases younger than
about a day. Keep that guard on: pick a slightly older version instead.

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
| Components | shadcn/ui (its default primitives), Tailwind 4, lucide icons |
| Toasts | sonner |
| API client | openapi-fetch, typed by openapi-typescript from `schema/openapi.yaml` |
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
  lib/                   api.ts, query-client.ts, env.ts
  gen/                   generated from schema/, never edited
  components/ui/         shadcn components (our code, edit freely)
  components/            app-wide composites
  features/<feature>/    components/, hooks/, store.ts, pure *.ts
  routes/<segment>.tsx   pages; thin, they compose features
```

- File names are kebab-case and components PascalCase. Named exports only;
  default exports only where a tool demands it (`vite.config.ts`).
- Import from `src` through the `@/` alias. No `../` across features.
- No barrel `index.ts` files inside the app.
- A feature never reaches into another feature's internals. Code moves to
  `components/` or `lib/` when a second feature needs it.

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
  - base URL comes from `env.ts`;
  - timeouts use `AbortSignal.timeout`;
  - errors are normalised into kinds: offline, timeout, unauthorised,
    client, server.
- Error toasts come from the global `QueryCache` / `MutationCache`
  `onError`. A component handles an error only when it can do something
  about it.
- Server data never gets copied into Zustand. The editor store holds the
  draft; the saved version lives in the query cache.
- Zod is for untrusted edges only: env, forms, imported files. API
  responses are typed by codegen and not parsed again. A schema that's
  declared but never parsed is noise.

## Editor (React Flow)

- The workflow definition from the API is the model. React Flow nodes and
  edges are a view of it. `toFlow(definition)` and `toDefinition(nodes,
  edges)` are pure, tested functions in `features/editor`.
- Graph mode and page mode edit the same definition. Page mode is a
  constrained view: ordered pages, and the nodes on a page run in
  parallel. A definition that doesn't fit page mode opens in graph mode.
- Node positions live in the definition's optional `ui` block. When it's
  missing (an imported or generated definition), the editor lays the graph
  out itself.
- Define `nodeTypes` and `edgeTypes` at module scope. Wrap custom nodes in
  `memo` and keep handlers stable.
- Read store slices through selectors. Never subscribe to the whole nodes
  array.
- Blocking cycles in the UI (`isValidConnection`) is only for UX. Server
  validation is the source of truth.
- JSONata preview calls the server's preview endpoint. The `jsonata` npm
  package never runs in the browser, because preview results must match
  what the engine does.
- Each open run uses one `EventSource`. Events update node status in the
  query cache.

## Components and styling

- Function components. Props are typed next to the component.
- Split a file once it passes ~250 lines or a page juggles a pile of
  `useState`s.
- Theme tokens only: no raw hex, arbitrary values or inline styles.
  Enforce it with `@shadcn/lint`.
- Add primitives with the shadcn CLI and then adapt them. Don't hand-roll
  them.

## Tests

- Pure logic gets unit tests first: `toFlow`/`toDefinition`, the page-mode
  conversion, mapping helpers.
- Component tests render with providers and MSW handlers. They assert what
  a user sees (roles, text), not the implementation.
- MSW handlers are typed from `src/gen`.
- Playwright covers one flow against the real server and Postgres: create a
  workflow, connect two upstreams, run it, see the results.
