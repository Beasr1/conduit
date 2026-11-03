# Web style

For `web/`. Code only; how we work is in how-i-like-to-work.md, and how
the app looks, reads and moves is in design.md.

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
| Tests | Vitest, Testing Library, MSW; Playwright for plan 04's Done flow (`web/e2e`, `just e2e`) |
| Lint and format | ESLint flat config + typescript-eslint + react-hooks; Prettier + tailwind plugin |
| Package manager | pnpm, pinned via `packageManager` |

One library per concern. Adding a second toast, icon or table library blocks
review; duplicates creep in one PR at a time.

## Layout

```
web/src/
  main.tsx
  router.tsx             route table + route builders (routes.workflow(id))
  lib/                   api.ts, query-client.ts, query-keys.ts, problems.ts
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
  No inline key arrays. A factory two features use lives in
  `lib/query-keys.ts`.
- There is one API client, in `lib/api.ts`:
  - requests go to `/api` on the page's own origin, which nginx and Vite's
    dev proxy forward to the server;
  - timeouts use `AbortSignal.timeout`;
  - errors are normalised into kinds: offline, timeout, unauthorised,
    client, server.
- Error toasts come from the global `QueryCache` / `MutationCache`
  `onError`. A component handles an error only when it can do something
  about it, and then marks its query or mutation `meta: { quiet: true }`.
- A `401` anywhere sends the app to sign-in, carrying where you were
  (`sendToSignIn`), and says on the way that the session ended
  (`sessionEnded`). The editor's leave dialog, which stops that while
  there are unsaved changes, signs in again there instead, then asks
  again for what was refused on the page.
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
  That last rule is open again: page mode is now also the keyboard way to
  build, so every definition may have to fit (roadmap, 05).
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
- An edit that changes nothing returns the draft itself, and the store
  drops it. A form that applies as it's typed can then notify freely.
- `toFlow` gives each node its fixed size as `measured` too. React Flow
  keeps a node's handle positions only when it says it was measured, and
  every edit draws new node objects; without it, every edit blinked the
  edges off.
- The response card is the canvas's, not `toFlow`'s: it isn't a node of
  the definition. Its `#response` key keeps it out of positions,
  connections and deletion, and the selection keeps it through edits.
- Anything over the editor that takes keys (the side panel, the toolbar, a
  dialog) carries React Flow's `nokey` class. React Flow deletes the selection on
  Delete or Backspace anywhere but in a text field, buttons included.
- Blocking cycles in the UI (`isValidConnection`) is only for UX. Server
  validation is the source of truth.
- The server's problems with the draft reach the editor through React
  context, never the store, and components read them through selectors
  (`useProblems`, `useProblemCount`), so a step redraws only when its own
  problems change. A problem is placed in the draft as it is now, and goes
  once what it's about has changed; the next check, when the draft has
  stood still for a moment, says again.
- The editor words problems itself, by code (`features/editor/problems.ts`),
  in the screen's words; the server's detail shows where it's the specific
  part. A mark for problems is an icon with words for screen readers
  (`ProblemMark`), never colour alone.
- Leaving with unsaved changes asks first: `useBlocker` for pages in the
  app, and `beforeunload`, added only while there are unsaved changes, for
  closing the tab.
- JSONata preview calls the server's preview endpoint, which simulates the
  steps before the expression over their samples, or uses the last run's
  responses. The `jsonata` npm package never runs in the browser, because
  preview results must match what the engine does.
- What asks the server about the draft as it's typed, the check and the
  preview, waits for it to stand still for a moment (`useStill`,
  `PAUSE_MS`), and keeps showing the last answer while the next comes.
- Each open run reads its event stream with one `fetch()` (D9), not
  `EventSource`, which hides a failed connection's status. Events update
  node status in the query cache.
- The run the canvas shows is the store's, by its id; the run itself is the
  query cache's, and its stream is a query that ends with the run. How a
  step went is said in words with a mark, never by colour alone.

## Components and styling

- Function components. Props are typed next to the component.
- Split a file once it passes ~250 lines or a page juggles a pile of
  `useState`s.
- Theme tokens only: no raw hex, arbitrary values or inline styles.
  Enforce it with `@shadcn/lint`. Its token rules are off in
  `components/ui`, which the shadcn CLI writes.
- Dark mode follows the system (`prefers-color-scheme`); there's no toggle.
- The page's CSP refuses inline styles and eval. Base UI's own `<style>`
  elements are off (`CSPProvider disableStyleElements` in `main.tsx`), so a
  rule one of its parts needs goes in `index.css`; zod runs `jitless`.
  jsdom has no CSP, so a violation only shows in the browser.
- Add primitives with the shadcn CLI and then adapt them. Don't hand-roll
  them.
- A tab opens as an arrow key reaches it (`activateOnFocus`), as the
  WAI-ARIA tabs pattern recommends when panels show at once. A tab holding a
  form stays mounted while hidden (`keepMounted`), so text that doesn't
  count yet survives a switch.
- A control that repeats, such as Format beside each JSON field, says what
  it acts on in its accessible name ("Format sample input").
- Each field is edited in one place. Two editors for one field drift apart:
  a hidden one keeps its old text, and its next change writes that back.
- A canvas node whose handles change after it mounts says so with
  `useUpdateNodeInternals`. React Flow finds a node's handles when it
  mounts, so a connection from a handle added later isn't drawn.
- A transform with cases is drawn as an HTTP step is: an exit block per
  case, then + Case, each exit with its handle, named by its status, as a
  line from it says `on: <status>`. Its panel has a tab per case, keyed by
  its place (`case:<k>`), not its status, so typing a new status keeps the
  tab open; the store keeps those parts open across edits as it keeps an
  HTTP step's responses.
- An Input tags each earlier step the preview's `outcomes` says a run may
  come without, "conditional", or that may answer more than one way, "2xx
  or 400" (`outcomeTag`, which names outputs as a way into a step is
  named), and the Input's hint says what to check.
- A run's lines into steps are taken as the steps' `took` says; lines into
  answers, as the answer the run gave.
- An answer takes lines from any number of steps, in the order joined, and
  a run gives the first answer, top to bottom, that one reached (plan 14).
  Each line is drawn into its answer's point. A block gives one answer:
  joined to another, its line moves there, but a transform with an
  expression gets cases, as it picks. Lines go by identity (`leaveLines`),
  so the canvas deletes several from one answer at once, and every edit of
  them goes through `mapLines`, so one that changes nothing gives back the
  draft itself. The response's panel numbers the answers and moves them
  with Move up and down.
- Each line into a transform with more than one is one of its ways
  (`data.way`), unless it's marked required: it's dashed until a run says
  whether it came, as dashed means it may not be taken, or wasn't. A
  transform's preview is a run by each line into it, required ones too,
  the server's `ways`; its Input is what those runs read, merged, and it
  gives what the first run that comes gives (`givesOf`), as which way a
  run came is the transform's to decide (plan 13). A `MappingField`'s
  `result` gets the draft previewed, so a result reads that draft.
- An HTTP step is drawn as blocks, each saying which part of the step it
  is (`data-part`). The canvas reads the block a click lands in
  (`onNodeClick`), and the store's `part` holds what's open, so the canvas
  and the panel's tabs agree. A click on a point opens rather than
  connects, so `connectOnClick` is off (design.md, the floor).
- A step's Request is a second row of tabs: URL, Headers, Query, Body and
  Retry. The one open is the store's (`requestTab`), kept as another step
  is picked, so the problem list opens the tab a field is on
  (`requestTabOf`). Each row is a tab list with a name (`aria-label`),
  Blocks and Request, so a screen reader tells them apart.
- A step's Unhandled has two places for problems: `unhandled`, what's
  chosen for its failures (plan 12), and `unhandled_body`, its body.
- A step that uses an upstream (plan 07) is filled from its version as the
  editor opens (`fill`) and stripped before anything is sent (`strip`), so
  it's drawn and edited as any HTTP step while the server gets only `uses`
  and `with`. Its request and responses are locked (`isLocked`) unless the
  upstream is being edited in place: a disabled `fieldset` round the tab
  panels, never round a tab list, as HTML disables every button in one,
  tabs too (sources.md). Its body reads its parameters, the preview's
  `parameters`, not the run's input.
- A step that uses a workflow (plan 07) is filled from the revision it
  pins, kept in the store's `called` by `versionKey` (`wf:` and the id):
  its responses are the workflow's answers besides 2xx (`answersOf`), and
  its Input tab, in place of Request, the fields of the workflow's input
  (`inputOf`), as the server has both. Its request block opens its Input,
  and its previews are the workflow's own, so it has no samples.
- Add HTTP step always makes a step that uses an upstream
  (`upstream-choice.tsx`): one from the library, a published workflow but
  the one being edited, at the revision served, or a new one made from a
  call whose URL reads the run, each placeholder a parameter the step gives
  what it read (`asUpstream`, as Save as upstream does). A step with a
  request of its own, saved before, shows Publish's `own_request` by Save
  as upstream.
- An upstream is made with its samples (`components/upstream-samples.tsx`,
  as the library and the editor both make one): one input object, its keys
  the parameters the URL reads, and each response, the 2xx first. What
  doesn't fit is said when it's made, and the next change clears it; the
  upstream's page applies its sample input as it's typed, once it fits.
- A field is labelled, not explained. What it's for is a `Hint`
  (`components/hint.tsx`) beside its label: a Base UI Popover with
  `openOnHover`, which opens on hover or a press. Not a Tooltip, which
  Base UI turns off on touch (sources.md). A problem stays under its field.
- The tour (`features/editor/components/tour.tsx`) finds its stops' parts
  a frame after it opens, and points each stop at the element it found.
  It gives Base UI the element, not a function: a function anchor is read
  once, so every stop stayed at the first. It's offered once per browser,
  remembered in local storage, read and written in `try`, and Tour in the
  toolbar opens it again.
- A link that looks like a button is a `Link` styled with
  `buttonVariants()`. A `Button` rendering a link would be announced as a
  button. A trigger rendered as a `Button` takes `render={<Button />}`, as
  a class built by `buttonVariants()` can't be checked by the linter.

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
- A field on a hidden tab is still in the page, as the tabs stay mounted,
  so a test finds a field by role and label, which skips hidden ones as a
  screen reader does, rather than by label alone. A tab's panel is named
  by its tab, so to reach a field on a hidden tab by label alone, as a
  test of what's kept across tabs does, it takes `selector: "input,
  textarea"`.
- jsdom let a test click a tab that a disabled `fieldset` disabled, which
  Chromium refuses, so a test of something locked checks `:disabled`,
  which jsdom works out from the fieldset, and Chromium sees the rest.
- Base UI's select takes a click that no press came before only on the
  option highlighted, so a test picking an option presses it
  (`pointerDown`, then `click`), as a mouse does: options that arrive
  after it opens move what's highlighted.
- A test fails on any console warning or error it logs
  (`src/test/console.ts`). That's how React, React Router and Base UI
  report misuse. Vitest would only print it, and hides passing tests'
  output when it detects an AI agent running it.
- Start the MSW server with `onUnhandledFrame: "error"`, so a request with no
  handler fails the test. MSW 3 renamed it from `onUnhandledRequest`, and
  the old name is silently ignored at run time.
- Playwright covers plan 04's Done flow against the real server, Postgres
  and the test upstream (`web/e2e/done.spec.ts`, `just e2e`, in `just
  check`): build the spec example, save it with a problem and fix it, run
  it and watch it, see what crm sent and got, publish it and call it; and
  a definition with no layout opening laid out. The app is served as built,
  by `vite preview`, whose proxy `CONDUIT_API_ORIGIN` points at the test's
  server. It presses Fit View before clicking a card, as an open panel
  narrows the canvas, and reads a card's run line as it streams ("200")
  and once recorded ("200, 12 ms"). On its first visit it goes through
  the tour, checking a stop sits beside its part, which jsdom can't show,
  and it decides each step's failures before it publishes (plan 12). A
  second test covers plan 07's library (`web/e2e/upstreams.spec.ts`): it
  makes an upstream, uses it from a step, runs and publishes it, edits it
  in place, and saves a step's request as one; and a published workflow
  is picked as a step, reopened, run and served. Their steps, such as
  opening a panel or joining a block, are in `web/e2e/editor.ts`. A
  button is named exactly where another's name holds it, Save beside Save
  as upstream, as Playwright otherwise matches a name as a substring
  (sources.md).
