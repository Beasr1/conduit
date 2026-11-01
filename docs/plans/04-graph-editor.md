# 04 — Graph editor

Status: accepted 2026-10-28, with all seven questions answered (Answers, at
the end); D10, D11 and D13 accepted with it, and D14 waits for 07. Phase A
is committed (69bb36e), and so is Phase B, its last step in eabb7b6. Phase D
came before C: its samples, previews, outputs by status and a step's blocks
are committed (f9e7484, e98e50a, 2026-10-30), and so is Phase C, runs
(ad89609, 2026-10-30), and D's API's answers, after C (8cbc5b1,
2026-11-01), and a step's Unhandled block (80d55d4), its body (4fb0aec)
and strict joins (e898238). A step that runs if any of its lines came,
once all have ended, was built as Either (4877f7a), reworked into Merge
(4c8ef26), then folded into transform, which now merges its lines, and a
transform's cases became its exits: "a step and a transform", parts 1 and
2 (84fc8dd), then its lines its parameters, each required or not, and its
preview a run by each way (5adbc71). Then the finish (2026-11-01): an
Input tags a conditional step, a run records the lines it took, two small
fixes, and Phase E, the browser test. **Done**: the browser test passes in
`just check`; the leftovers went to plan 07, and headers are held.
Building Phase A raised question 8, since answered.

## Goal

The editor: build, save and run a workflow in the browser, in graph mode.

**Done** when one Playwright test drives the app against the real server,
Postgres and test upstreams:
- sign in with the API token;
- create a workflow and build the spec example in graph mode (`user` →
  `orders` ‖ `prefs` → `crm`): four http nodes, their mappings, four edges,
  an input schema and an output;
- save it, and see a problem on the field it points at, then fix it;
- run it with an input, and watch each node change status as it happens;
- open `crm`'s node and see the request it sent and the response it got;
- publish it, and see its served URL.

Also seen:
- a definition with no `ui` block (made through the API) opens laid out;
- `just check` green, the browser test included, locally and in CI.

## Decisions this rests on

| # | Choice | Status | Why it matters here |
|---|---|---|---|
| D6 | JSONata previews run on the server | accepted | the preview endpoint below |
| D9 | live updates over SSE, read with `fetch()` | accepted | the stream reader below. With the session cookie (answer 1) the browser no longer needs the `Authorization` header, so `EventSource` would work again; the reader stays on `fetch()` for the status codes (Decided while drafting) |
| D10 | Zustand for editor state | proposed: accept | one store per open editor. Its "why" was "what React Flow uses internally": React Flow 12 still bundles zustand 4.5.7, so the app's zustand 5 is a second copy (Dependencies) |
| D11 | React Router 8, data mode | proposed: accept | the routes below |
| D13 | node kinds `http` and `transform` only | proposed: accept | the engine already has both; the editor draws them |
| D14 | upstream library entries are templates a node copies | proposed: accept | only if the library stays in 04 (question 2) |

## What it adds

**Server:**
- **`ui` in the definition** (`schema/workflow.yaml`): each node's position,
  `{"positions": {"<id>": {"x": 120, "y": 40}}}`. Optional. A position for a
  node that doesn't exist is ignored rather than reported: it harms nothing,
  and the editor never writes one. The server stores positions and never
  computes one. Planned as `[x, y]`; built as `{x, y}`, your call in Phase B,
  because Go and TypeScript both type it exactly and the request shape check
  reports a wrong or extra field with its pointer. Dropped and then restored
  in Phase B: in a graph editor, the arrangement is part of what the user
  built.
- **`POST /v1/preview`**: evaluate one expression, template or condition
  against a document, through `internal/transform` with its guardrails on,
  and answer with the value or the error. This is D6: the browser never
  evaluates JSONata itself, so a preview can't disagree with a run.
- **A browser session** (answer 1): `POST /v1/session` takes the API token
  and sets the session cookie; `DELETE /v1/session` clears it. The auth
  middleware accepts the cookie as well as the bearer token, and checks
  `Sec-Fetch-Site` on writes that come with the cookie.

**Web**, all through `schema/openapi.yaml`, with no UI-only actions (plan
08's first seam):
- the libraries plan 01 moved here: Tailwind 4 and shadcn/ui, React Router,
  `env.ts`, lucide, and toasts (question 7); and from 03, openapi-fetch;
- a sign-in screen for the API token (question 1);
- the workflow list: create, open;
- the editor: graph, node forms, edge conditions, the workflow's input
  schema and output, save, problems, publish;
- runs: start one with an input, follow it live, inspect each node;
- previews beside every expression field.

## The editor

**The model and the view.**
- The definition from the API is the model. React Flow's nodes and edges
  are a view of it, built by `toFlow(definition)`, a pure function in
  `features/editor` (web.md). Nothing is read back from the canvas: an edit,
  a new edge or the end of a drag changes the draft, and the view follows.
  The plan also had a `toDefinition(nodes, edges)`; with edits going
  straight into the draft, it had nothing to do, so Phase B dropped it.
- One Zustand store per open editor holds the draft and the editor's state
  (selection, open panel). The saved revision stays in the query cache;
  it's never copied into the store.
- **A refetch never touches the draft.** The store is seeded once, when a
  workflow's revision is opened, never by an effect that watches query
  data. The plan said the open revision is never refetched; it is, since the
  workflow's query is its latest revision and refetches like any other (when
  the window regains focus). The editor ignores it, and since step 4 a
  refetch that fails keeps the editor on screen.
- Canvas nodes don't fetch: a node component reads what it draws from the
  store, through a selector. Every handle has an id, since an edge names
  the handle it joins. Derived nodes are never mirrored into state by an
  effect, which loops when its input is a fresh `[]` on every render.
- Positions come from `ui.positions`, and nodes are draggable. A node
  without a position, in a definition made through the API or one just
  added, is placed by the editor, left to right (library: see
  Dependencies), and the next save writes where it went. A drag moves the
  node on the canvas as it happens, and writes its position into the draft
  when it ends.
- Node ids are the names expressions use (`nodes.fetch_user.body`), so the
  editor asks for one, suggests one from the node's label, and checks it
  against the definition's id pattern as it's typed. Renaming a node warns
  when an expression still mentions the old id, by a plain text match, since
  the browser doesn't parse JSONata. Rewriting references is later.

**Nodes and edges.**
- Two node kinds (D13): `http`, with method, URL, headers, query, body,
  timeout and retry; `transform`, with one expression.
- Each node's settings are a form (react-hook-form + Zod), in a side panel.
  The form remounts per node (`key={nodeId}`) rather than resetting in an
  effect.
  - Headers and query are key–value lists (`useFieldArray`), with rows
    keyed by field id, not by index, so deleting a row keeps the others'
    state.
  - Numbers (timeout, attempts) are typed as text and parsed on blur. A
    controlled number input that reparses on every keystroke eats a
    half-typed value.
- An edge is drawn by dragging between handles. Its optional `when`
  condition is set on the edge. A connection that would make a cycle is
  refused as you drop it; that's only for feel, and the server's validation
  still decides (web.md).

**Saving.**
- An explicit save (button, or Ctrl-S), never autosave: each save is a new
  immutable revision, and autosave would make hundreds.
- Saves send `If-Match` with the revision the draft started from. A `412`
  means another tab, or later an agent, saved first, and nothing is saved
  over it: the editor says a newer revision was saved, and Save and Publish
  stay off until it's loaded (decided with you, 2026-10-30, late night).
- **Problems** come back with every save, each with a JSON Pointer. The
  editor maps a pointer to its node and field (`/nodes/2/request/url` is
  node 2's URL field), marks the node on the canvas, and shows the detail
  under the field. Question 6 asked whether to check as you type too:
  yes (answer 6).
  - The mapping is a pure function, tested on every pointer shape the
    validator produces.
  - A save's errors go to the fields, not to a toast as well. The save
    tells the global error toast to stay quiet (TanStack Query's `meta`),
    so one failure doesn't show twice.
- Publishing a revision with problems is refused by the server; the button
  says why. As built, Publish opens the list of problems instead.

**Runs.**
- Run asks for an input (a JSON field, checked by the server against the
  input schema: a `400` points into it). Unsaved changes are saved first,
  since a run needs a revision.
- The stream is read by `lib/events.ts`: `fetch()` with the token, the
  event-stream format parsed as the WHATWG spec defines it, a reconnect
  with `Last-Event-ID` after a dropped connection, and a stop at the `run`
  event or a `204`. Events update the run's node statuses in the query
  cache, and the canvas colours each node from there.
  - The parser handles what the spec allows and a quick one forgets: CR,
    LF and CRLF line ends, multi-line `data`, comments, and an id that
    only counts once its event is dispatched.
  - The stream closes when its component unmounts, and survives React's
    StrictMode running effects twice in development.
- web.md says each run uses one `EventSource`. That predates answer 5 of
  plan 03: `EventSource` can't send the token. web.md gets corrected.
- Clicking a node that has ended shows what it sent and got back, from
  `GET /v1/runs/{id}`.

**Previews.**
- Beside each expression field, Preview evaluates it on the server against
  a document like the one the engine would build for that node, and shows
  the value or the error. Question 4 is where that document comes from.

## Signing in

Every API call needs the bearer token (D12). The browser trades it once for
a session cookie that scripts can't read (answer 1):
- **Sign-in** posts the token to `POST /v1/session`. The server checks it
  as it checks a bearer token, and sets a cookie holding an expiry and an
  HMAC of it. The key is derived from the API token, so changing the token
  ends every session. Nothing is stored server-side.
- **The cookie** is `__Host-conduit_session`: `HttpOnly`, `Secure`,
  `SameSite=Strict`, `Path=/`, for 12 hours.
- **Writes** (`POST`, `PUT`, `DELETE`) made with the cookie must come with
  `Sec-Fetch-Site: same-origin`, on top of `SameSite`. The browser sets
  that header, so the server needn't know its own origin behind nginx and a
  TLS proxy. A write without it is refused, which shuts out browsers from
  before 2023. Planned as an `Origin` check; changed in Phase A.
- **Bearer tokens are unchanged:** scripts, agents and served callers keep
  using `Authorization`. A request with both is judged by the header.
- **A `401`** sends the app back to sign-in; **sign-out** calls
  `DELETE /v1/session`.
- The token never goes in a URL, a log or an error message.
- Checked in Phase A: Chromium and Firefox keep the `Secure` cookie over
  plain `http://127.0.0.1` and `http://localhost`. WebKit keeps it on
  neither, so Safari can't sign in over plain http (question 8).

## Testing

| Layer | What | How |
|---|---|---|
| Pure functions | `toFlow`, placing nodes that have no position, pointer → field, the stream parser | Vitest |
| Components | the editor renders the spec example; adding a node; connecting two; a save that comes back with problems | Vitest, Testing Library, MSW handlers typed from `src/gen` |
| The flow | Done, above | Playwright (`web/e2e`, `just e2e`, in `just check`) against `just dev`'s pieces, its own: a database made afresh, the server, the built web app (`vite preview`), and the test upstream, each on a port of its own. The server runs with `CONDUIT_ALLOW_PRIVATE_NETWORKS=true`, so it can reach the test upstream on loopback |

## Dependencies

Checked 2026-10-28 against the npm registry, each package's releases and
its docs, and tried together on a copy of `web/`: `pnpm peers check`,
`tsc -b`, ESLint, Prettier, `vite build` and a Vitest render all passed.
Each version is the newest in its major that's at least five days old; it's
checked again when it's added.

| Package | Version | Published | Licence | Why |
|---|---|---|---|---|
| react-router | 8.5.0 | 2026-10-19 | MIT | D11. Data mode: `createBrowserRouter` from `react-router`, `RouterProvider` from `react-router/dom` |
| tailwindcss, @tailwindcss/vite | 4.3.3 | 2026-07-16 | MIT | styling (web.md); Vite 8 support since 4.2.2 |
| shadcn (CLI) | 4.22.1 | 2026-10-18 | MIT | adds components as our own code (web.md) |
| @base-ui/react | 1.9.0 | picked by shadcn's init | MIT | the primitives shadcn's components are built on; Base UI is shadcn's default since July 2026 (below) |
| cn, class-variance-authority, tw-animate-css | 0.5.0, 0.7.1, 1.4.0 | picked by shadcn's init | MIT, Apache-2.0, MIT | what shadcn's components import. `cn` is shadcn's own package (maintainer shadcn, repo shadcn-ui/cn), replacing clsx and tailwind-merge |
| lucide-react | 1.61.0 | 2026-10-21 | ISC | icons (web.md); shadcn's default set |
| @shadcn/lint | 0.2.3 | 2026-10-19 | MIT | theme tokens only (web.md): no raw colours, arbitrary values or inline styles |
| @xyflow/react | 12.12.0 | 2026-09-24 | MIT | the graph (web.md). 13 is pre-release (13.0.0-next.0) |
| zustand | 5.0.16 | 2026-10-22 | MIT | D10 |
| react-hook-form | 7.90.0 | 2026-10-11 | MIT | node forms (web.md) |
| zod | 4.6.7 | 2026-10-12 | MIT | form and env schemas (web.md) |
| @hookform/resolvers | 6.0.0 | 2026-10-19 | MIT | Zod schemas in react-hook-form |
| openapi-fetch | 0.17.0 | 2026-02-11 | MIT | a client typed from `src/gen`; released with openapi-typescript 7.13.0. `parseAs: "stream"` hands back the event stream's body unread |
| eventsource-parser | 4.1.2 | 2026-10-12 | MIT | the event-stream format by the spec's rules, in 1.9 kB gzip with no dependencies, so we don't keep our own. Reconnecting stays ours |
| @dagrejs/dagre | 3.1.1 | 2026-08-08 | MIT | placing nodes that have no position; React Flow's guide: "If you need to organize your flows into a tree, we highly recommend dagre". 16 kB gzip |
| @playwright/test | 1.64.1 | 2026-10-14 | Apache-2.0 | the browser test (web.md) |
| prettier-plugin-tailwindcss | 0.8.1 | 2026-07-15 | MIT | class order; needs `tailwindStylesheet` for Tailwind 4 |

Not added, and why:
- **elkjs**: 436 kB gzip against dagre's 16 kB, and its licence changed to
  `EPL-2.0 OR GPL-3.0-or-later` in 0.12.0. React Flow's guide: "We don't
  often recommend elkjs because it's complexity makes it difficult for us to
  support folks when they need it."
- **A code editor** (question 3). CodeMirror 6 with JSON is about 96 kB
  gzip. No maintained JSONata mode for it exists: the candidates are years
  stale, single digits of downloads a week, or ship broken types. Monaco is
  3.2 MB gzip, and its React wrapper loads it from a CDN by default, which
  our CSP refuses.
- **@microsoft/fetch-event-source**: last published 2021-04-25.
- **sonner**, if question 7 goes with shadcn's toast.

Found along the way:
- **shadcn's default primitives are now Base UI, not Radix**: "New projects
  now use Base UI by default. Radix is still fully supported"
  (https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default). web.md's
  "its default primitives" therefore means Base UI; web.md gets named
  explicitly.
- **shadcn's init has two traps here.** The root `tsconfig.json` needs
  `compilerOptions.paths` for `@/*`, or init writes a literal
  `./@/lib/utils.ts`. Its guide also adds `baseUrl`, which TypeScript 6
  rejects (TS5101: deprecated, gone in 7). Init also lists `shadcn` and
  `tw-animate-css` as runtime dependencies; they're only read at build
  time, so they go in devDependencies.
- **@shadcn/lint flags shadcn's own components** (arbitrary values in
  `button.tsx`, an unknown class in the toaster), so its token rules are
  off for `components/ui`. It's pre-1.0 and six weeks old.
- **React Flow's stylesheet loads before Tailwind**, on the base layer:
  `@import '@xyflow/react/dist/style.css' layer(base);` then
  `@import 'tailwindcss';` (https://reactflow.dev/learn/customization/theming).
- **Two zustands.** React Flow 12 depends on zustand 4.5.7, so the app's 5
  is a second copy (0.5 kB). xyflow issue #5685, open, reports runtime
  TypeErrors when 4 and 5 meet; the trial build and render didn't show
  them. If the browser test does, the app pins zustand 4.5 until React
  Flow 13, which moves to 5.
- **openapi-typescript 7.13.0 declares a TypeScript 5 peer**, and the repo
  already runs it on 6.0.3; that's the one unmet peer. Upstream support
  for 6 is pending (issue #2723, PR #2872).
- **Playwright** needs only the headless shell for headless runs
  (`install --only-shell chromium`): about 122 MiB on Linux, 100 MiB on
  macOS, against 313 MiB for full Chromium. Its `webServer` entries start
  one at a time in list order, by 1.64.1's source, though the docs say
  "simultaneously"; the Go server goes before Vite.
- **pnpm's release-age guard wasn't enforced for exact pins.** pnpm's
  built-in `minimumReleaseAge` (1440) "is non-strict for backward
  compatibility", so when nothing older fits, it installs the young
  version, and an exact pin never has anything older
  (https://pnpm.io/settings/dependency-resolution). The trial installed a
  four-hour-old react-router without a word. Fixed apart from this plan:
  `web/pnpm-workspace.yaml` sets it explicitly, which makes it strict;
  seen refusing that same release.

## Steps

**Phase A: the app's foundation** (built; Phase A, as built)
- [x] Tailwind 4, shadcn/ui on Base UI, lucide, toasts (question 7);
      @shadcn/lint; the plan 01 CSS replaced.
- [x] React Router 8 (data mode), openapi-fetch in `lib/api.ts`, query-key
      factories. `env.ts` waits for a first setting.
- [x] The session: `POST`/`DELETE /v1/session`, the cookie in the auth
      middleware, the `Sec-Fetch-Site` check, and their tests.
- [x] Sign-in, sign-out, and the `401` path in the app.
- [x] The workflow list: list, create, open.

**Phase B: the editor** (built; Phase B, as built)
- [x] `ui` in `schema/workflow.yaml`.
- [x] `toFlow`, placing nodes that have no position, and their tests.
- [x] Nodes, edges, forms, the workflow's settings (input schema, output).
      The canvas draws the draft; nodes can be dragged, connected (a cycle
      refused as you drop it), deleted and added; a side panel edits what's
      picked: a step (3c; an HTTP step's in Request and Preview tabs), a
      connection's condition, or the response card's
      output and output schema; a button opens the workflow's settings,
      the input schema (3d). Plan 11's brief applies: text on screen says
      "step" and "connection"; a step's name and the look wait for 11, and
      building from the keyboard for page mode (05).
- [x] Save with `If-Match`, problems on fields (a tab hiding one is
      marked), publish. Problems are checked as you type and listed behind
      a button (step 4).

**Phase D: samples and previews** (before C since 2026-10-30, your call;
it was after)
- [x] Samples in `schema/workflow.yaml`: an optional `sample` on http steps
      (`status`, `headers`, `body`) and an optional `sample_input` on the
      definition. Real runs ignore them, as they ignore `ui`. A sample's
      body is at most 64 KiB, so a definition with several stays under the
      API's 1 MiB request limit (`server/internal/httpapi/router.go:20`).
      Validation checks the status is 100 to 599; since outputs, 200 to
      299, as it's the 2xx response's.
- [x] Samples are typed or pasted: the sample input in the workflow's
      settings, a step's sample response in its Preview tab, the notes on
      reading it below. Made-up samples for the Spec example
      come with it, in the test fixtures and as a new revision of your local
      Spec example.
- [x] `POST /v1/preview` simulates one step, or the response card, over the
      samples: each http step before it stands in with its sample, each
      transform before it is evaluated, then the step's own expressions.
      It answers with what goes in, the document the step would read, built
      by the engine's own code (`server/internal/engine/run.go:263`), so a
      preview can't disagree with a run; and what comes out: an http step's
      request (method, URL, headers, query, body), a transform's value, or
      the workflow's output, with an error on each part that failed. A step
      before it with no sample is named as missing, never guessed. Every
      expression goes through `internal/transform` with its guardrails, and
      the whole preview has a deadline. Tests for each kind, missing
      samples and the guardrails.
- [x] The Preview tab: an http step's panel has Request, Response and
      Preview. Preview shows what it reads (the document: the input and
      the steps before it), what it sends (the request, each part
      evaluated), and what it gets back (its sample). It follows the draft
      as it's typed, like the check. A transform step and the response card
      have one field each, so they show what they read and what they give
      under it rather than in a tab.
- [x] After C: preview beside each expression field (D), and a run's real
      response kept as a step's sample (C). Moved to plan 07 (2026-11-01,
      your call): an expression that reads nothing in the samples, or the
      wrong type, marked under its field (the inferred schema below), and
      fetching a sample from a GET.

**Phase D: outputs by status** (2026-10-30, your call, before C; built)

An HTTP step answers through outputs: 2xx, which every HTTP step has, and
each status you add, such as 404. A connection leaves from one output, and
is taken when the step's answer comes out there and its condition holds. A
status with no output fails the step and the run, as now.
- [x] `schema/workflow.yaml`: `outputs` on an http node, a list of
      `{status, sample}`; `on` on an edge, the status of the output it
      leaves from, absent for 2xx. The 2xx output's sample stays `sample`.
- [x] Validation: an output's status is 300 to 599 and listed once; only
      an http node has outputs; an edge's `on` names an output its source
      has, and an edge from a transform has none; an output's sample takes
      its output's status, so it has none of its own, and the 2xx sample's
      status is 200 to 299; two steps are joined at most once per output.
- [x] The engine: a status with an output is an answer. The step
      succeeds, its part of the document built as for a 2xx (the body when
      it's JSON, else null, as now), and only the connections from that
      output can be taken.
- [x] The preview: each step on the way answers with the sample of the
      output that leads to the step previewed, 2xx when several do; an
      output without a sample is named as missing. Previewing the
      response, each step answers 2xx. `POST /v1/preview` also takes a
      connection, `edge`, its place in `edges`: it previews up to the
      source, answering through the connection's output, and gives what
      the condition reads and whether the connection is taken.
- [x] The canvas: an HTTP step draws a handle per output on its right,
      labelled `2xx`, `404`, and grows to fit them; a connection drawn from
      one leaves from that output. A transform step keeps its one handle.
- [x] The Preview tab: "Responses", one per output, each with its sample
      (the 2xx one also has a status), then how the steps after read them.
      A response is added by its status and removed with a button; its
      connections go with it, as a deleted step's do.
- [x] A connection's panel says which output it leaves from, and becomes a
      workbench like a step's body: what the condition reads, as a tree;
      the condition; then "Taken" or "Not taken" with these samples.
- [x] The input tree opens the steps connected to the one it's for and
      folds the rest; the response card's opens the steps its output reads,
      a connection's its source.
- [x] Problems placed and worded for outputs, their samples and `on`.
- [x] Failing tests first; mutation checks; Chromium through nginx.
- [x] Docs: plan 02's answer 6 and the roadmap's edges amended; Phase D,
      as built.

Decided while drafting, yours to overrule:
1. **The names**: `outputs` and `on` in the definition. On screen the
   handles say `2xx` and `404`, the Preview section says "Responses" (your
   word for the blocks), and a connection says "From user, on 404, to
   create_user".
2. **An output's status is 300 to 599**: 2xx is every step's, and a call
   never ends on a 1xx. It ends on a 3xx only after five redirects, or on
   a 304.
3. **`on` is the status, a number, and absent means 2xx**, so every saved
   workflow means what it did.
4. **Two steps can be joined once per output**, so a step can follow user
   whether it answered 2xx or 404. Today it's once in all.
5. **Retries come first**: a 503 retried to the last attempt that's still
   503 goes to a 503 output.
6. **Removing a response removes its connections**, as deleting a step
   does. A response's status isn't edited in place: remove it and add
   another.
7. **Outputs keep the order they're added in**, after 2xx. When several of
   a step's outputs lead to the step previewed, the preview takes 2xx,
   else the first.
8. **The 2xx sample's status narrows from 100–599 to 200–299**, and "a
   sample outside 2xx fails its step" leaves the preview: the response it
   stood for is now an output's. Your Spec example's samples get checked
   first.
9. **The response's preview reads every step's 2xx sample**; choosing
   another branch for it waits.
10. **A connection is previewed by its place in `edges`**, as the editor
    names it.

Left open: classes (4xx) as outputs, and a "failed" output for timeouts,
transport errors and statuses with no output (the roadmap's "continue on
error"). Done means the steps above, `just check` green, and your 404
example built on the canvas, each branch previewed.

**Phase D: a step's blocks** (2026-10-30, your call, before C; built)

Graph mode put a step's every part in one place: its request body and all
its responses on one tab. Now a step is drawn as you pictured it: its
request, a block on the left, and a block per response on the right. A
click on a block or its point opens that part, and only that part. A
wireframe, not a design: the look stays plan 11's.
- [x] The canvas draws an HTTP step as blocks: the request on the left (its
      id, method and URL, and the point connections come in at), and on the
      right a block per response, `2xx` then each status, with the point its
      connections leave from; `+ Add` below them. A transform step and the
      response card keep their shape.
- [x] A click opens what it's on: the request block or its point opens
      Request, a response's block or point opens that response, `+ Add`
      opens "Add a response". A drag from a point still draws a connection;
      clicking one point and then another no longer does (`connectOnClick`
      off).
- [x] The step's panel keeps its id on top, then a tab per block: Request,
      2xx, one per response, and `+ Response`. The canvas and the tabs open
      the same part, and a keyboard reaches a response through its tab. The
      Preview tab goes, its parts moving to these.
- [x] Request: method and URL, headers, query, then the body's workbench
      (what it reads, the JSONata, what it sends), then timeout, attempts
      and idempotent.
- [x] A response's tab: its sample (body, headers, and for 2xx its status);
      "Then, on 404", the connections leaving from it; "Connect to", a step
      picked from a list, which connects without dragging (WCAG 2.5.7); and
      what the steps after read, `nodes.user.status`, `.headers` and
      `.body`. A response besides 2xx has Remove.
- [x] A transform's panel gets "Then" and "Connect to" too, after its
      expression.
- [x] A click on a line opens its panel, as now: from, on and to, its
      condition, Taken or Not taken. Each "Then" row opens its line too.
- [x] Problems mark the tab they're on, and the problem list opens it.
- [x] Failing tests first; Chromium through nginx, light and dark, with
      screenshots.
- [x] Docs: design.md's floor (connecting without dragging is Connect to),
      web.md, and A step's blocks, as built.

Decided with you on 2026-10-30 (night), from wireframes:
- **Blocks, with `+ Add`**: the request on the left, a block per response
  on the right, and a response added from the canvas. The same blocks with
  adding in the panel only was the other.
- **Tabs mirroring the blocks**, one part showing at a time. Only the part
  clicked, with no tabs, was the other: the least on screen, but a keyboard
  couldn't reach a response, since points can't take focus.
- **Connect to, in a response's tab.** A click on a point opens it, so
  clicking one point and then another can't also connect. WCAG 2.5.7 asks
  for a way that isn't a drag, and a list is one a keyboard can use too.
  A word that opens beside a dot that connects, two targets side by side,
  was one other; a click that opens and arms a connection, so that the
  next step looked at gets connected, was the last.
- **The line keeps its condition**, so a click on it opens its panel, as
  now: the condition is the line's own, the way Make sets a filter by
  clicking the line between two modules and Camunda puts a condition on a
  sequence flow (sources.md). You'd asked whether the click could go to
  something else later; whatever comes, such as a run showing whether the
  line was taken, goes in the same panel. Conditions in the response's
  tab, a click on a line only selecting it, was the other.
- **This replaces "Preview holds it all"** (below): Preview's parts went to
  the tabs of the blocks they belong to, the body to Request and each
  sample to its response.

Decided while drafting, yours to overrule:
1. **A click on a step's id, method or URL opens Request**: the whole left
   block is the request's.
2. **`+ Response` is the last tab**, holding "Add a response", the status
   field as now; once one is added, its tab opens. A dialog was the other
   way; a tab keeps the panel the one place parts open.
3. **The open tab is the editor's**, not the panel's, so a click on the
   canvas switches it, and removing the response open takes it back to
   Request.
4. **"Connect to" lists the steps a connection could reach**: not the step
   itself, not one already joined from this response, none that would make
   a loop. The response card isn't one: it reads steps by name.
5. **A "Then" row says the step and its condition**, "always" or "if …".
6. **A transform keeps one panel**, its expression, then Then and Connect
   to, opened wherever it's clicked.

Left out: moving a connection to another response from its panel (remove
it and connect again), and a button on a line to put a step in between.
Done means the steps above, `just check` green, and your 404 example
clicked through: user's 404 block opens its tab, Connect to joins it to
create_user, and the line opens its condition.

**Phase C: runs** (after D; detailed 2026-10-30, late night, from wireframes; built)
- [x] A test upstream, `server/cmd/testupstream`: a small server answering
      known requests, a user by id or a 404, orders, preferences, a contact
      created with 201, a slow answer and a failing one, so runs repeat
      exactly. `just upstream` runs it on 127.0.0.1:8090, and `just dev`
      starts it too, the server allowed to call it (private networks and
      port 8090, in dev only).
- [x] `lib/events.ts` and its tests: a run's event stream read with
      `fetch()`, parsed as the WHATWG spec says, resumed with
      `Last-Event-ID` after a dropped connection, and stopped at the `run`
      event or a `204`. Events update the run in the query cache.
- [x] Run, beside Save: it asks for an input, the sample input to start,
      saves unsaved changes first, since a run needs a revision, and shows
      a `400` under the input. It's off while a newer revision exists.
- [x] The run bar, above the canvas: the run, its revision, how it went and
      how long it took; Runs, the history (the editor's runs and callers'
      alike), and Close run. It says when the draft has moved on from the
      revision that ran.
- [x] Statuses on the canvas: each step's request block says how it ended,
      in words and a mark (running, retrying, ✓ 201, ✗ timeout, skipped),
      and the response it got is marked. A line taken is solid, one not
      taken dashed.
- [x] A step's real data in its tabs: Request shows what it sent, above the
      preview of what it would; the tab of the response it got shows what
      came back beside its sample, with Keep as sample. A failed or skipped
      step says why. The response card shows what the run answered.
- [x] Failing tests first; Chromium through nginx (the CSP, runs that
      fail) and through `just dev` with the test upstream (runs that
      succeed), light and dark.
- [x] Docs: web.md, Phase C as built.

Decided with you on 2026-10-30 (late night), from wireframes:
- **A run shows on the canvas, with a run bar.** A page of its own per run,
  a read-only copy of the graph, was the other option: two views of one
  graph to keep in step.
- **A step's real data shows in its blocks' tabs**: what it sent in
  Request, what it got in that response's tab, beside the sample. A Run tab
  of its own while a run is shown was the other.
- **Runs call a local test upstream** while we build and check them. A
  public test API was the other: nothing to build, but checks would need
  the internet and couldn't make an answer slow or fail on cue.

Decided while drafting, yours to overrule:
1. **The run shown is the editor's**, by its id; the run itself lives in
   the query cache, which its events update (web.md: server data never
   goes in the store).
2. **A line counts as taken** when its step answered on its response and
   the step it leads to ran. The server doesn't say which lines it took,
   so a line whose condition failed, into a step another line took it to,
   shows as taken. Telling it exactly needs the engine to record taken
   lines: a TODO, at `web/src/features/editor/runs.ts:96`, done on
   2026-11-01 (the lines a run took).
3. **Keep as sample** copies the run's body and headers into that
   response's sample, and for 2xx its status too.
4. **Runs lists the workflow's latest 50 runs**, newest first; more pages
   come later.
5. **`just up` stays as production is**: its server can't call private
   addresses, so runs there reach only public APIs.

Samples and previews, decided with you on 2026-10-30:
- **They come before runs.** You couldn't tell what a request could be
  built from, with no data to look at. n8n, Zapier and Make all show a
  step's data to map from, and get it by running the step once
  (sources.md). Runs first was the other option, and needs upstreams that
  answer; a list of readable names with no values was the third.
- **A sample is typed or pasted first.** Fetching one from the API is later,
  and for GETs: a real call to a POST creates real things, as Zapier warns
  of its step tests.
- **The tab is called Preview**, after Request and Response. "Try it" reads
  as if it calls the API; "In and out" is a phrase, not a name.
- **Preview holds it all** (later the same day): an HTTP step's data, in the
  order it flows. The input the step reads, the JSONata of its request body,
  what it sends, then its sample response and how the steps after it read
  that. The Request tab keeps the call itself: method, URL, headers, query,
  timeout and retries. The Response tab went, its sample moved into Preview,
  so each field is edited in one place. One page with no tabs, or Preview
  only showing while the tabs edit, were the other options.
- **Picking a field of the input writes its path** where the cursor is in
  the JSONata, as n8n's drag from its input does. JSON text to copy from
  was the other option.
- **A response gets no JSONata of its own**, not now: the whole of it goes on
  to every step after, read by name. What a step hands on stays parked (Out
  of scope).

Outputs, decided with you on 2026-10-30 (night):
- **A status can be a branch.** Until now any status outside 2xx failed
  the step and stopped the run, so a connection's condition never saw a
  404 (plan 02, answer 6). n8n's "Never Error" and Make's "Return error if
  HTTP request fails" let a step take any status as its answer; Step
  Functions' Catch, Logic Apps' "run after" and n8n's error output route
  failures instead (sources.md).
- **Outputs on the step**, your picture: the request on the left, a block
  per response on the right, each a handle a connection leaves from. The
  branch shows on the canvas, and nobody writes `nodes.user.status = 404`.
  Response blocks as nodes of their own was the other option: twice the
  nodes, and blocks that aren't steps (D13).
- **2xx, plus the statuses you add.** Classes and a "failed" output wait.
- **One sample per output**, so each branch previews without editing a
  sample. One per step, its status picking the branch, was the other.
- **No mapping on connections.** You asked whether one could filter what
  the step after gets. A step sends only what its own JSONata picks, and
  reads earlier steps by name, so a mapping there would shape the same data
  a second time; reshaping once for several steps is a transform step.
  None of n8n, Make, Step Functions, Logic Apps, Argo or Camunda maps data
  on a connection: they put a condition or an outcome there, and shape
  data in steps (sources.md). The noise is the input tree's, so it folds
  the steps not connected.
- **Built before C**, since it changes what a run does.

Samples, decided with you on 2026-10-28:
- **A sample response** (example JSON), not a hand-written JSON Schema:
  anyone can paste one, and it's enough to evaluate expressions over.
- **Stored in the step, in the definition**, so revisions, dry runs (07)
  and agents (08) share it. The field asks for made-up or redacted data,
  since whatever is pasted stays in every revision.
- **Arriving with previews**, which they exist to feed.
- **The schema inferred from a sample is internal**: computed on the
  server when needed, never stored, never shown. One sample can't show
  what's optional, what an empty list holds, the type behind a `null`, or
  a fixed set of values, so the inferred schema requires nothing and
  allows extra fields. It can say a path isn't in the sample, never that a
  response is wrong. Several kept samples could refine it; OpenAPI schemas
  take over in 07.

**Phase D: the API's answers** (2026-10-30, your call; after C; reworked and built 2026-10-31)

The response card is the overview of everything the workflow's API can
answer, and every run gives exactly one answer, with one status and one
shape. Before it, the API answered 200 with one output whatever the run
did: in your "Fixes check", prefs answering 400 still answered
`200 {"msg": "yo"}`.
- [x] The definition's `response`: its `answers`, each a status (200 to
      599), the step joined to it (`from`), the response of that step its
      line leaves on (`on`, as an edge's), and a schema, the shape a caller
      is promised (checked when saved, not on runs yet); and `unhandled`.
      `output` and `output_schema` stay for the revisions saved with them:
      such a definition answers 200 with its output, as before, and one has
      a response or an output, not both.
- [x] A line per answer: each answer has its own point on the card, and
      one line, from the step that gives it, whose result is the body: a
      transform's value, an HTTP step's response body. Each output of an
      HTTP step can answer through its own, 2xx to 200 and 404 to 404. A
      transform joined to several answers picks one: with a switch, or
      with JSONata giving `{ "status": …, "body": … }`.
- [x] The switch: a transform has an `expr`, or a `switch` of `cases`, each
      a condition, a status and a body, JSONata all, ending with
      `otherwise`, which every switch has. The first case whose condition
      holds gives the answer, else Otherwise.
- [x] Validation: each answer's step exists and has the response its line
      leaves on; each status is listed once; an output of an HTTP step
      gives one answer, as its result is the response it got; a switch's
      statuses are answers it's joined to, and it gives each of those; two
      answers one run can reach are a problem, to merge; each schema is a
      JSON Schema; unhandled has a body.
- [x] The engine gives each run its answer once its steps have ended,
      through the one line into the response it took. None taken, two, a
      status the step isn't joined to, or a value that isn't
      `{status, body}`, fails the run as the workflow's fault,
      `workflow_error`. A definition with neither a response nor an output
      succeeds and answers nothing.
- [x] Unhandled answers a run that gives no answer: a step fails or
      times out, no answer is reached, or two are. Its body is JSONata over
      the run with its `error`; its status is the cause's, 502 when an
      upstream failed, 504 when time ran out, 500 otherwise. Bad input
      (400), a bad token (401), busy (503) and a cancelled run stay
      Conduit's.
- [x] A run records the status it answered (`answered`, a column on
      `runs`), unhandled's when that answered; a served run answers with
      that status and the body, else with Conduit's problem details.
- [x] The canvas: the card is drawn as a step is, mirrored: its answers as
      blocks on the left, each a point a line arrives at, then + Add; on
      the right, the steps that answer, and "also 4xx · 5xx", the answers
      Conduit gives on its own, with ", your unhandled body" when there's one. A
      line dropped anywhere on an answer's block joins it. Connect to lists
      each answer with no line yet.
- [x] The card's panel, the overview: each answer, the step that gives it
      (a click opens it), Disconnect, and its schema; Add an answer;
      Unhandled, or Write your own; then Conduit's own answers, each saying
      when it's given and what body a caller gets.
- [x] The switch's panel: what the step reads, once; each case's
      condition, status and body, moved and removed; Otherwise's; then what
      it answers over the samples. Use cases makes a transform a switch,
      and so does joining one that gives one value to a second answer:
      Otherwise keeps its expression as the first answer's body, and a case
      for the new status waits to be filled.
- [x] An output becomes a step: a definition with an output opens with a
      transform step, `respond`, holding it, run after the steps it reads,
      joined to 200, its output schema 200's; saved, it stays so.
- [x] A run on the canvas marks the answer it gave, and dashes the lines
      into the others.
- [x] A line the response refuses says why, under the card.
- [x] A body that is `$$`, or reads the steps' headers, gets a note once
      it answers: it sends callers what the run read, upstream headers
      included.
- [x] Failing tests first; mutation checks; Chromium through nginx.
- [x] Chromium through `just dev`, the test upstream answering: Phase E's
      browser test does it, in `just check`.

Decided with you on 2026-10-30 (late night), from wireframes:
- **The card shows every answer: yours, and Conduit's own.** Listing only
  what it answers today was one other option, but every success would stay
  200, so a user that isn't found couldn't answer 404. Only your answers,
  with Conduit's in the docs, was the last.
- **One status, one shape**, so a caller reads the card as an API's
  reference, and the format and structure of the contract stay consistent.
- **One exit per status** (corrected 2026-10-31): each answer takes one
  line, from the one step that gives it, so branches that answer the same
  status meet in a step first. This said "one exit" at first: one step,
  joined to the card by one line, making every answer, and a line per
  answer turned down, as two answers a run could reach together would
  have to be found. That was my reading of your "only one exit point for
  the status code"; your "Fixes check", its 200s merged into one step and
  its 400s into another, showed you meant one per status. Two answers a
  run can reach together are found when saved (as built, below).
- **The card is an overview; the steps joined to it make the answers.** The
  first draft gave each answer a JSONata body on the card.
- **Today's output moves into a step**, so every answer is made the same
  way. Keeping it on the card for a plain 200 was the other option.
- **No fallbacks, and no order on the card.** 200 answering only when
  nothing else is reached, and the first answer on the card winning, were
  both turned down: the person configuring decides. Unhandled
  (2026-10-31) isn't one: it answers only a run that gives no answer, at
  its cause's status.
- **A run that reaches no answer answers 500**, the workflow's fault, with
  a link to the run, or with unhandled's body. 200 with an empty body
  was the other.
- **A workflow may answer 400 itself**, beside Conduit's own 400 for input
  that doesn't match the schema; the card shows both, and a caller tells
  them apart by the body.
- **Built now, after C.**

A line per answer, decided with you on 2026-10-31 (your "Fixes check"):
- **Each status has its own point, and takes one line.** A step joined to
  two picks between them with a switch. Two answers one run can reach are
  a problem when saved, "merge them into one node", and a run that
  reaches two fails. One line into the card, a switch picking every
  status, was the other option: two answers could never both be reached,
  but every branch would have to meet in that one step.

The switch, decided with you on 2026-10-31 (your idea):
- **The step that answers can be a switch**: cases checked in order, the
  first whose condition holds answering. Step Functions' Choice state takes
  JSONata conditions the same way, and n8n's Switch has a rule per output
  (sources.md).
- **Built right after the card**, in this phase.
- **Cases in the step**, so each status is checked when saved. A builder
  over one JSONata expression, reading cases back out of it, was the other.
- **Otherwise is required, and editable**, so a run that reaches a switch
  always answers. Step Functions' Default is "Optional, Recommended", the
  run failing without one, and n8n's fallback is off by default; that was
  the other option.
- **Joining a step that gives one value to a second answer turns it into
  a switch** (from your "Fixes check": `transform` gave `$$`, and the 400
  from `crm` had nowhere to go). Leaving the step as it was, and warning,
  was the other option: runs would fail until its expression gave
  `{status, body}`.
- **A refused line says why**, under the card: "200 takes one line, from
  respond. To answer 200 from spare too, merge them into one step."
  Joining the line to the step that answers, by itself, was the other
  option: quicker, but the line would land where it wasn't dropped. (Asked
  while the card took one line; it held for a line per answer.)
- **`$$` in an answer is warned about, not refused.** OWASP's API Security
  Top 10 lists an endpoint exposing sensitive properties, and advises
  against generic methods like `to_json()` (sources.md). The run's record
  keeps the whole state for debugging.

The default, now Unhandled, decided with you on 2026-10-31 (your idea):
- **It answers any run that gives no answer**: a step fails (an upstream
  error, a timeout, an expression that breaks), no answer is reached, or
  two are. Bad input (400), a bad token (401) and busy (503) stay
  Conduit's, as no run happens. Only when no answer is reached was the
  other option, a step that fails keeping Conduit's own 500, 502 or 504.
- **Your body, the status by cause**: 502 when an upstream failed, 504
  when it timed out, 500 otherwise, as RFC 9110 defines them (sources.md),
  so callers and their retries still read it right. Your body and one
  status of yours was the other option: simpler, but a timeout and a
  broken expression would look the same to a caller.
- **Renamed Unhandled** (2026-11-01, your call): `response.unhandled` in
  the definition and Unhandled in the panel, the word a step's Unhandled
  block uses (below), so one idea has one name. `default` was never
  committed.

Decided while drafting, yours to overrule:
1. **Each answer holds its line**, `from` and `on`, rather than an edge
   ending at the card, so edges stay between steps.
2. **A step that picks with JSONata gives `{ "status", "body" }`**, as a
   Lambda behind API Gateway's proxy integration returns its `statusCode`
   and `body`, its own example a 400 for missing parameters (sources.md),
   so one JSONata decides both; a switch gives the same. Only those two
   keys: a third, such as `headers`, fails the run rather than being
   ignored, so it can mean something later. Its status is a whole number
   however the JSON writes it.
3. **An output of an HTTP step gives one answer**: its result is the
   response it got, so a problem says one output joined to two answers
   needs a transform to pick. Each output can have an answer of its own.
4. **A definition with neither a response nor an output succeeds and
   answers nothing**, so a workflow being built runs from the editor;
   served, it answers 500, "The workflow has no response". Publishing
   doesn't refuse it: a revision publishes when it has no problems, and
   refusing would add a check only publishing makes.
5. **Runs that succeeded before `answered` existed answered 200**, so the
   migration records that.
6. **Converting an output marks the draft as changed**, so saving keeps it,
   and says why.
7. **The lines lead, and the cases follow** (changed while building):
   joining a switch to an answer adds a case for it, and a case whose
   status the step isn't joined to is a problem, "respond isn't joined to
   a 409 answer". The draft had a case with a new status add the answer
   to the response, but the answer would then have no line.

Open: headers per answer, a case's later; enforcing each answer's schema on
runs, which OWASP also advises (sources.md); an OpenAPI document for
callers, built from the card (07); a Merge action, making one step of two
that answer one status.

**Phase D: Unhandled, then strict joins** (2026-11-01, your calls, in that
order; both built the same day)

Your "Fixes check" showed both. A failing step stops the run, with nowhere
to map what it got back: "a 'failed' output" was left open (Phase D,
outputs, above). And a step ran once every step with a line into it had
ended, if any of those lines was taken (the roadmap's edges rule), so crm
ran on orders' 2xx while prefs answered 400.

A step's Unhandled, decided with you on 2026-11-01:
- **Every step has an Unhandled block**, there by default, as a try/catch
  is in code: a strip along the bottom of its card, muted and saying
  "fails the run" until something is joined to it. It takes what the
  step's other blocks don't: a status with no block; the connection, or
  a timeout, after its retries; a body over the cap, or a 2xx body that
  isn't JSON; an address the SSRF guard refuses; and its own JSONata
  failing, in its URL, query, headers, body, expr or a case. n8n, Make
  and Step Functions all send a step's failure on, each as an opt-in;
  Step Functions catches its JSONata errors too (sources.md).
- **Joined, the run goes on** down its lines. The step still shows
  failed, with Unhandled marked, and the run succeeds if it answers. Not
  joined, the run fails as it does now, and the response's Unhandled
  answers.
- **It hands on** `nodes.<step>.error`, `{code, detail}`, with `status`,
  `headers` and `body` when the upstream answered a status with no
  block: where a step's own result gets mapped.
- **It doesn't take** a line's condition failing, as the step has
  answered; a transform's `{status, body}` that isn't one of its answers;
  the run's own time; a cancelled run; or our bugs. The response's
  Unhandled answers those.
- **Joined straight to an answer**, the body is the step's, as with any
  block, and it joins one answer at most. Its panel warns that callers
  get whatever the upstream sent, stack traces included (OWASP API8,
  sources.md).
- **The response card's Unhandled** becomes the same strip, with no point.
  It's there by default too: a run nothing answers gets your body, or
  Conduit's problem details.
- **Its status stays by cause** (asked again on 2026-11-01): 502, 504 or
  500, as the roadmap's serving rule and RFC 9110 have it, so callers and
  their monitoring tell a down upstream from a broken workflow. Always
  500, as for an exception nobody caught, was the other option; a step's
  Unhandled lets a workflow answer any status itself.
- **In the definition**, an edge or an answer's line gets
  `unhandled: true`, beside `on`; a caught failure keeps its step
  `failed`, with `caught: true` in its error. A preview after an
  Unhandled line reads a made-up `error`.
- **A body of its own** (2026-11-01, your call, after the block was
  built): Write your own in the Unhandled tab, JSONata over what the step
  read and its own failure. Its value is what the steps after read as
  `nodes.<step>.body`, its status, headers and error staying, and the
  body of an answer joined straight to the block; on a transform, a
  fallback value, as a catch returns one. Step Functions' Catch shapes
  what it passes on the same way, `$states.errorOutput` being readable in
  its `Output` (sources.md). Only for an answer, and joining a transform
  that returns it, which worked already, were the other options.
- [x] The engine, validation, runs and previews.
- [x] The strips, their panels and the run's marks.

Strict joins, decided with you on 2026-11-01:
- **A line into a step is a dependency**: a step runs only when each step
  with a line into it answered through a block joined to it, and that
  line's condition held. Otherwise it's skipped, and skips cascade.
  Airflow waits by default "for all upstream (direct parents) tasks for a
  task to be successful", and BPMN's parallel join "until each incoming
  sequence is taken" (sources.md).
- **Lines from one step are alternatives**, your idea: join a step's 2xx
  and its Unhandled both to the next step, and the next runs whichever it
  took. Following either of two steps, the any-line rule until now, waits
  for a step type of its own, the Merge above, or an option; Airflow and
  BPMN both offer that kind too (sources.md). Changed the same day, once
  the Either below was built (your call): every line is needed, and a step
  that follows whichever of a step's responses comes joins them in an
  Either first.
- **What it costs**: a step can't follow both arms of a branch. Your
  success_200, after test_400 (prefs 400) and crm (prefs 2xx), can never
  run, and the editor will say so.
- [x] The engine: a step runs once each step with a line into it took
      one of them.
- [x] Validation: a step's route is, for each step before it, the blocks
      it may answer through. A route that leaves a step no block can
      never run, a problem; two answers can both be reached only when
      their routes agree, which ends the false alarms (as built, below).
- [x] The editor names that problem, "success_200 can never run: it needs
      prefs to answer 400 and 2xx"; the roadmap's rule and plan 02 change.

**Phase D: Either** (2026-11-01, your call, built before Phase E;
committed as 4877f7a, then reworked into the Merge below the same day)

Strict joins left your success_200 no way to follow prefs' 2xx and, through
test_400, its 400 ("we might need to fix it"). Decided with you on
2026-11-01:
- **A step type of its own, Either.** It runs once every line into it has
  ended, with the one that came, and is skipped when none did. Every other
  step keeps waiting for all, and a transform joined to several steps stays
  the way to wait for all and combine them, so there's no second new type.
  Make pairs If-else with a Merge module that "passes data from the active
  route"; Airflow's own docs warn against its wait-for-all default after a
  branch; n8n's Merge waits for both inputs, so Merge was turned down as the
  name (sources.md).
- **A body per way**: each line into an Either can have a JSONata body, what
  the Either gives when that line comes; without one it gives the body of
  the step the line comes from, as it is. The steps after read
  `nodes.<either>.body` whichever way came, as code reads a variable each
  arm of an if/else sets (SSA's Φ, sources.md). No bodies, each step after
  checking which step ran, was the other option.
- **Two ways one run could both bring are a problem when saved**, as two
  answers are, but only when no condition lies before either of them (asked
  again while planning): a switch picks among answers, but a line from one
  to a step can't follow a case, so steps branch on a body with conditions,
  which the check can't read. When one does, a run in which both come fails
  the Either, and its Unhandled block can take that, as a run that reaches
  two answers fails. Reporting those too, as answers are, and the first
  way in order winning were the other options.
- **Ways are edges** (asked while planning): an edge into an Either may have
  a `body`, so scheduling, cycles, the canvas, deletes, renames, conditions
  and Connect to work as for any line. Ways listed on the Either, as answers
  hold their lines, was the other option; it needed a second path through
  all of those.
- **One route per step** (asked while planning): an Either's route merges
  its ways', a step that a way rules out counted as not running, so the
  checks stay linear. They stay exact when ways part at one step's
  responses, chains of those included; ways that differ in two steps'
  answers at once are read as independent, and the check may then report
  two answers that can't both come, as it does for conditions. A list of
  routes per step, exact but doubling at each Either, was the other option.

Decided while planning, yours to overrule:
1. **A way's body reads what its line's condition reads**: the steps before
   the step it comes from, and that step. A preview of the line shows it as
   a run gives it.
2. **An Either has one output**, as a transform has, and an Unhandled block,
   which takes a body that fails.
3. **An Either with no line into it is a problem**: it would never run.
4. **A run records the way that came**, `way` on a node's run and on the
   event that ends it, the step it came from and its output, so the canvas
   marks that block, and the others as not come.
5. **The check's ways and a run's agree on order**: a problem names the
   later of two ways, and a failing run names both, in the definition's
   order.
6. **The never-runs problem names the fix**: "…: to run it after either,
   join them in an Either".

Decided with you while building (2026-11-01), from your Fixes check:
- **Every line into a step is needed**, one step's lines included: crm's
  2xx and 500 into success_200 can't both be taken, as crm answers once, so
  success_200 can never run, and the check says so, pointing to an Either.
  An ordinary step is the AND: a line it needs not taken, it's skipped,
  and its path stops there. The Either is the OR: a way that didn't come
  counts as null, and it goes on with the one that came. Keeping one step's
  lines as alternatives was the other option: less to draw for "go on
  either way", but alternatives would come two ways, and the step after
  would read bodies of two shapes as one.
- **An Either waits for every line into it to end** (your point), taken,
  skipped or failed into Unhandled, before it runs, so it never runs on
  the first that comes. That was built so from the start.
- **Both kinds stay** (asked again): an Either can't do an ordinary
  step's job. Both wait for every line, and any step reads every earlier
  one by name; what differs is a line that doesn't come. An ordinary step
  then doesn't run, so crm never calls with prefs missing; an Either runs
  with what came. Only Either-style joins, the rule before strict joins,
  and one kind of step with an "after all" or "after any" setting, as
  Airflow's trigger_rule, were the other options. The Merge below keeps
  the two.
- **Dashed means may, or didn't**: while building, a way into an Either is
  dashed, as it may not be taken, and every other line is solid. While a
  run is shown, a line is solid when the run took it and dashed when not,
  so the way that came turns solid. Ways dotted beside untaken lines
  dashed, and a run fading untaken lines instead, were the other options.
- [x] Schema: `either` beside `http` and `transform` (D13 amended); `body`
      on an edge; `way` on a node's run and its event; a line's preview
      gives what the Either gives.
- [x] Validation: an Either's own rules, a body only into one, its route,
      and two ways one run could both bring.
- [x] The engine runs an Either with the way that came, and a run records
      it (`node_runs.way`, a migration).
- [x] Previews: a line into an Either gives its value; the steps after read
      the way previews take, 2xx first.
- [x] The editor: the Either card, a block per way and a point to add one;
      its panel, a tab per way with its body and preview; Add step offers
      it; a run marks the way that came; problems in the editor's words.
- [x] Every line needed; ways dashed.
- [x] Failing tests first; mutation checks; Chromium through nginx.
- [x] Docs: the roadmap's D13 and rule, plan 02, CLAUDE.md, web.md,
      sources.md.

**Phase D: Merge, the Either reworked** (2026-11-01, your call, after the
Either was committed in 4877f7a; committed as 4c8ef26, then folded into
transform below)

You asked whether a join that accepts whatever comes, its JSONata handling
it, would be simpler than the Either. Decided with you on 2026-11-01:
- **One merge step, Merge, that accepts whatever comes.** It waits for every
  line into it to end, as every step does, and runs if any came; it's
  skipped if none did. One JSONata expression, as a transform's, reads
  every step before it by name and makes its value from what came; a step
  that didn't run is missing. Two coming is fine: the expression decides.
  It's a transform that runs when any of its lines came rather than all.
  BPMN's inclusive join and Airflow's `none_failed_min_one_success` work
  this way (sources.md). The exclusive Either as committed, one way at a
  time with a value per way, and a value per way given together as one
  object, were the other options.
- **Ordinary steps keep needing all their lines**: that's no merger step,
  just how a step works, and what stops crm running with prefs missing.
- **Named Merge**: Either promised one or the other, which it no longer is,
  and Make and n8n both call bringing branches back together Merge.
- **What goes**: a way's own value (`body` on an edge), the check of two
  ways one run could both bring, the run failing when two come, and a way
  reading its own slice of the run. **What stays**: waiting for every line,
  dashed ways, + Way, the route check for answers. A run records every way
  that came, so `way` becomes `ways`, a list (a migration).
- [x] Schema, validation, the engine, previews, runs and the editor: Either
      becomes Merge.
- [x] Failing tests first; mutation checks; Chromium through nginx.
- [x] Docs: the roadmap's D13 and rule, plan 02, CLAUDE.md, web.md,
      sources.md, and this plan as built.

**Phase D: a step and a transform, the transform merging, its cases as
exits** (2026-11-01, your call, before Phase E; it replaces the Merge,
staged)

In your Fixes check, merge_200's Input held people and prefs only: a
preview follows one run, each step answering 2xx where that leads on, so
prefs answered 2xx and test_400 never ran there, whatever its sample. You
asked how a transform and a Merge differ (when they run, and cases, which
only a transform has), then cut it down: "its just step and
merger/transformer". Decided with you on 2026-11-01:
- **Two kinds.** A step is an HTTP call, and still runs only when every
  line into it is taken. A transform is the merger: it waits for every
  line into it to end and runs if any came, a step whose line didn't come
  missing from what it reads, as the Merge's did. The merge kind goes,
  and a setting for when a transform runs was the other option, dropped
  as one thing too many.
- **Its lines**: with more than one into it, each is dashed, as each may
  not come; with one, it's needed, and solid. A line comes to its one
  point: no ways column, no point per way, no Add a way from, as Connect
  to on the step before adds one without drawing.
- **Its preview comes by one way at a time**, picked in its Input:
  "Preview a run that comes by", its first way by default. The steps
  before that way answer through the outputs that lead there, so picking
  test_400 runs it with its sample, prefs answering 400 with its own. The
  preview request names the way as `way`, the edge's place.
- **Cases are tabs, and exits.** Each case is a tab with a name you can
  change, a condition, its JSONata and its exit code, a status. The first
  case whose condition holds runs its JSONata and exits with its code;
  steps after read nodes.<id>.status and nodes.<id>.body. Each is a block
  on the card's right, "found · 200", with its point, and a click opens
  its tab; a line leaves it for a step, a transform or an answer.
- **No Otherwise** (your call once it was built): when no case holds, the
  step fails, and its Unhandled block takes that, as it takes any of its
  failures; with none joined, the failure fails the run. Otherwise, a last
  case with no condition, was the other option, one thing more.

Mine, while planning, for you to veto:
- **An exit is its code**: a line from a case is written `on: <status>`,
  as a line from an HTTP step's response is, so a transform gives a code
  once; two conditions for one code join with `or`. An answer takes one
  line, so two cases with one code couldn't both answer anyway. A name is
  a label, so renaming moves no line; changing a code takes its lines
  along. Unnamed, a case is Case and its place.
- **An exit joined to the response answers its own code**: a case that
  exits 404 joins the 404 answer, and the editor says so if it doesn't.
  Each exit gives one answer. A transform with one expression keeps
  picking among answers with {status, body}, as today.
- **A transform with an expression** keeps its card and panel; Use cases
  makes its expression the first case's JSONata, its lines going along,
  and each case waits for its condition.
- **Saved workflows**: steps after a transform with cases read
  nodes.<id>.status and .body, not body.status and body.body; only the
  two pw-cases test workflows have cases. A transform with several lines
  now runs when any came, not all; none of yours has two. Your Fixes
  check moves its merge to a transform, as a new revision.
- **The words**: no Merge step; problems name the kind once, not in two
  copies; Then's "merge this step with the one that gives the answer"
  becomes "join both to a transform"; never-runs, now a step's problem
  only, ends "to run it after whichever comes, join them to a transform
  first".
- **A run** records the code a transform with cases exited with, as an
  HTTP step's status, and the lines it came by.

Part 1, the transform merging:
- [x] Schema, validation, routes, the engine and previews (`way`): the
      merge kind folded into transform.
- [x] The editor: dashed lines, the way picker, It came by; the Merge
      card, its ways and Add a way from gone.
Part 2, cases as tabs and exits:
- [x] Schema and validation: a case's `name`, lines `on` a code, a code
      once per transform, an exit's answer; Otherwise gone.
- [x] The engine and runs: a case's status and body, its exit, the code
      recorded, no case holding a failure.
- [x] The editor: tabs, blocks with points, renaming, a code change moving
      its lines, Use cases moving them to the first case.
Both:
- [x] Failing tests first; mutation checks; Chromium through nginx, light
      and dark.
- [x] Docs: the roadmap's D13 and rule, plan 02, CLAUDE.md, web.md,
      sources.md, and this plan as built.

**Phase D: a transform's lines as its parameters** (2026-11-01, your
call, before Phase E)

You see a transform as a function: the steps before it are its parameters,
any of which can be missing, and some it can't do without. Its preview
picked one run at a time, but lines can come together, and a transform is
a merger. Decided with you on 2026-11-01:
- **Required or optional lines.** A line into a transform is optional, as
  now: its step may be missing, and reads as nothing. Marked required, it
  must come: without it the transform is skipped, as an HTTP step is, and
  so are the steps after it. With none required, it runs if any line
  came, as now. Leaving it to the expression, `$exists` and `$error`, was the
  other option.
- **Its preview shows them all.** No picker: its Input holds every step it
  can read, each with its sample, and the expression's conditions decide
  what to make of whatever comes. One run at a time, picked, was the
  other option.

Mine, while planning, for you to veto:
- **Where it's marked**: `required: true` on the edge, set in its line's panel,
  "Required: the transform runs only if this line comes". Only a
  transform's lines take it, as an HTTP step needs every line anyway.
  Required lines are solid; optional ones dashed, once a transform has
  more than one line in.
- **What a run checks**: once every line into the transform has ended, it
  runs if every required line came, and, with none required, if any did.
  The check flags required lines that can't come in one run (never_runs),
  as it does an HTTP step's.
- **What the preview gives**: a result for each line it can come by, as
  the conditions pick differently in each: "By test_400 · 2xx: {...}",
  "By crm · 500: nothing, crm has no sample for it". With one line, or
  every line required, that's one run and one result. The Input merges
  what those runs read; a step they read differently, as prefs answering
  2xx in one and 400 in another, shows the first.
- **The API**: a preview of such a transform gives `ways`, a result each,
  beside `reads`, the merged Input; the preview request's `way` goes, as
  nothing picks one now.
- [x] Schema, validation and routes: `required` on an edge into a
      transform.
- [x] The engine: the join; a preview's merged reads and a result per way.
- [x] The editor: Required in a line's panel, solid and dashed lines, the
      merged Input, a result per way, the picker gone.
- [x] Failing tests first; mutation checks; Chromium through nginx.
- [x] Docs: the roadmap's rule, plan 02, CLAUDE.md, web.md, and this plan
      as built (A transform's lines as its parameters, as built).

**Phase D: headers sent when they're needed, and the caller's to read**
(2026-11-01, your call, before Phase E; held, your call, the same day)

You asked for JSONata on headers "to ensure headers are propagated when
and if required". A step's headers are templates today: each is always
sent, one whose placeholder gives nothing fails the step, and a served run
reads only the request's body, so there's nothing to propagate. Decided
with you on 2026-11-01:
- **A condition per header.** A header keeps its row and its template, and
  may have a condition, JSONata as a line's or a case's: it's sent only
  when that holds; empty, always. One JSONata object for every header, as
  the body is, and a template that gives nothing leaving its header out,
  were the other options.
- **A run reads the caller's headers**, as `request.headers`, names in lower
  case, beside `input`, so a step can forward a trace id or a token for an
  upstream. What reaches Conduit as Conduit's own is held back:
  `authorization`, which on /serve is Conduit's token, `proxy-authorization`
  and `cookie`, the session.

Mine, while planning, for you to veto:
- **The conditions sit beside the headers, by name**:
  `` header_when: {"X-Trace": "$exists(request.headers.`x-trace`)"} `` on the
  request, so a header saved before stays as it is; a condition for a
  header the request doesn't have is a problem.
- **Where the caller's headers come from**: a served run, the request it
  answers; a run from the editor, none; a preview, the workflow's sample
  headers, a field in Workflow settings beside the sample input, which
  the Input tree shows as `request.headers`.
- **A run's record keeps them**, redacted as a step's sent headers are, so
  the run view can say what came.
- **Query parameters** stay templates; a condition there can come when one
  needs it.
- [ ] Schema: `header_when`, the sample headers, `request.headers` in the data
      document, what's held back.
- [ ] The engine and runs: a header sent only when its condition holds;
      served runs taking the caller's headers, recorded redacted.
- [ ] The editor: a condition on each header row, the sample headers in
      Workflow settings, `request.headers` in the Input tree.
- [ ] Failing tests first; mutation checks; Chromium through nginx.
- [ ] Docs: the roadmap, CLAUDE.md, web.md, and this plan as built.

**Phase D: conditional steps, told in the Input** (2026-11-01, your call,
before Phase E)

You asked for the preview to say when a step is conditional, so whoever
configures a step knows to check for it, or to mark its line required.
Decided with you on 2026-11-01:
- **Tagged in every step's Input**, worked out from the lines rather than
  the samples: each step before it that a run can reach it without is
  "conditional", and one that may answer more than one way says which,
  "2xx or 400". Tagging only what may be missing, or only what a
  transform's runs by each line had, were the other options.

Mine, while planning, for you to veto:
- **How it's worked out**: from what validation knows of a step, the
  outputs each step before it must answer through for it to run (its
  route), and, for a step its route says nothing of, whether that step
  always runs: a first step does, and so does one whose lines always come,
  each without a condition, from a step that always runs and answers only
  through that line's output. A step that may be skipped is conditional;
  its outputs are the route's, or else every one it has. The samples don't
  change it.
- **The API**: a preview of a step or a connection gives `outcomes`, by
  step id, for each step before it: the `outputs` it may answer through,
  and whether it's `conditional`.
- **The words**: a tag beside the step in the tree: "conditional", "2xx or
  400", or both; a case's exits by name, Unhandled as Unhandled. Under the
  tree, "fallback is conditional: a run can reach this step without it.
  Check it with $exists(nodes.fallback), or mark its line required.", and
  "prefs answers 2xx or 400: check nodes.prefs.status before reading its
  body."
- [x] workflow: the outcomes of the steps before a step.
- [x] The engine and the API: `outcomes` on a preview.
- [x] The editor: the tags and the notes in an Input.
- [x] Failing tests first; mutation checks.

**Phase D: the lines a run took** (2026-11-01, your call: plan 04's TODO,
before Phase E)

A run's canvas guessed which lines the run took: a line counted as taken
when its step answered on its output and the step it leads to ran, so a
skipped step's taken lines showed as not taken. A transform's came from
`ways`, recorded on it. Decided with you on 2026-11-01:
- **The engine records the lines each step's answer took**, `took`, on its
  run and on the event that ends it: for each, the step it leads to and the
  output it leaves. The canvas and It came by read it, and guess nothing.
- **`ways` goes**, as a transform's ways are the lines into it some step
  took. No data migration (your call: only you run it): a new migration
  drops `node_runs.ways` and adds `took`, so older runs lose their ways.
- [x] The engine, the runner, the store and the API: `took`; `ways` gone.
- [x] The editor: a line taken as `took` says; It came by from it; the
      TODO at `web/src/features/editor/runs.ts:103` gone.
- [x] Failing tests first; mutation checks.

**Phase D: two small fixes** (2026-11-01)
- [x] Renaming a step warns of every place that reads it: cases'
      conditions and bodies, a step's Unhandled body and the response's
      Unhandled body too (`web/src/features/editor/edits.ts:619`).
- [x] A preview's problem says its field once: under Case 1 · Body, "The
      expression gave no value.", not "Case 1: body: the expression gave no
      value."

**Phase E: the browser test** (its flow brought up to date on 2026-11-01)

The Done flow as the editor is now: a definition has answers, not an
output, so the spec example joins crm to the 200 answer.

Mine, while planning, for you to veto:
- **`@playwright/test` 1.64.1** in `web/` (in the dependencies above), the
  test in `web/e2e/`, Chromium only.
- **Its own database and ports**, so it runs beside `just dev` and `just
  up`: a database made afresh and migrated for each run; Playwright
  starts the server (private networks and the upstream's port allowed),
  the test upstream, and the built app (`vite preview`, /api proxied).
- **`just e2e`**, which `just check` runs; CI installs Chromium.
- [x] Playwright, against the test upstream (built in C), and the Done flow.
- [x] web.md corrected; CLAUDE.md, repo.md and the roadmap updated.

Moved to plan 07 (2026-11-01, your call): an expression that reads what
its samples lack marked under its field, and fetching a sample from a GET.

Each phase ends with `just check` green and is committed on its own.

## Phase A, as built

Built 2026-10-28. `just check` passes up to its last step, the one that
compares generated code with what's staged.

**Seen in a browser**, with Playwright 1.64.1, against `just dev` and
against the Docker stack through nginx: sign in (a wrong token first),
list, create, open, the same slug again, sign out, and a page sending you
back to sign-in.

| Engine | Over plain http, on 127.0.0.1 or localhost |
|---|---|
| Chromium 156 (headless shell) | the flow passes. The cookie is `Secure`, `HttpOnly` and `SameSite=Strict`, and `document.cookie` doesn't show it |
| Firefox 157 | the same |
| WebKit 27.2 | sign-in answers `204`, but the cookie isn't kept, so the next call gets `401` (question 8) |

WebKit calls both origins secure contexts and still refuses the cookie.
Its tracker agrees: bug 218980, treating loopback as trustworthy, is open.
The change that landed for bug 281149 in April 2026 lets WebKit send
loopback `Secure` cookies on macOS 26 or later, once the system's cookie
store accepts them. This Mac's (macOS 26.1) doesn't. Real Safari wasn't
tried.

**Changed from the plan:**
- **`Sec-Fetch-Site`, not `Origin`** (Signing in). Checking `Origin` needs
  the server to know its public origin, which nginx and a TLS proxy hide.
- **No `env.ts`** while there's nothing to configure.

**Decided while building, without a question** (each can be overruled):
- Sessions last **12 hours**.
- Pages are **lazy route modules**. The root route holds a blank
  first-load fallback and the error boundary for 404s; a pathless route
  under the layout holds the pages' boundary, so the header stays when a
  page fails. A failure offers Reload, which is what a tab opened before a
  deploy needs; a 404 offers the workflow list.
- **shadcn's `base-nova` style**, neutral colours and the Geist font.
  **Dark mode follows the system**, with no toggle.
- **@shadcn/lint**: `no-raw-colors`, `no-arbitrary-values`,
  `no-inline-styles`, `no-unknown-classes` and `require-static-classes`,
  as errors outside `components/ui`.
- **Queries retry twice**, and only after an offline, timeout or server
  error, never after a refusal.
- **One toast per message**, so the same failure updates it in place. A
  query or mutation that shows its own error sets `meta: { quiet: true }`.
- **openapi-fetch looks `fetch` up on each request**, so MSW sees it in
  tests; by default `createClient` keeps the one there was when it loaded.
- **A request whose client went away is logged at Info**, not as "request
  failed" at Error. Leaving a page cancels its queries, so it happens in
  normal use.

**Found along the way:**
- **nginx blanked every page fetched a second time**, a bug in plan 03's
  config. A `304` has no `Content-Type`, so it got the API's
  `default-src 'none'` policy, and a browser copies a `304`'s headers onto
  its cached copy (RFC 9111, 4.3.4). Seen in Chromium and Firefox; fixed
  (below).
- **Vite forwards the browser's console to the terminal only when it
  detects an AI agent** running it (`server.forwardConsole`'s default),
  and **Vitest 5 then hides passing tests' console output** (its `minimal`
  reporter). Otherwise Vitest prints warnings but never fails on them.
  React Router's warnings went unseen until a browser check.

**Decided with you after building:**
- Safari over plain http is left as it is (answer 8).
- **A `304` carries no policy**, so it never changes the one a browser
  stored, whatever kind of response it is. Sending the page's policy on
  `304`s was tried as well. It also repairs a copy the bug broke, and gets
  a policy-only change to returning visitors before the page next changes.
  But nothing is live to repair, and it assumes every `304` is a page,
  which stops holding if the API ever answers `If-None-Match`. Checked on
  a throwaway nginx, in one browser session per engine (Chromium 156,
  Firefox 157): with the bug, the second visit was blank; with no policy
  on the `304`, a copy already broken stayed broken; with the page's
  policy, it was repaired.
- `vite.config.ts` turns `forwardConsole` on, so the browser's warnings
  and errors print in the `just dev` terminal for everyone. Checked with
  the agent variables removed: before, a page's warning didn't print;
  after, it did.
- A web test fails on any console warning or error it logs
  (`src/test/console.ts`). Checked: with the root route's `Component`
  taken out, the 404 test fails on React Router's warning.
- **The standard library has a check like ours**:
  `http.CrossOriginProtection` (Go 1.25). It lets through a request with
  neither `Sec-Fetch-Site` nor `Origin`, and `Sec-Fetch-Site: none`; ours
  refuses any cookie write that isn't `same-origin`. Ours stays, being the
  stricter.

## Phase B, as built

Decided with you:
- **Positions are stored**, in the definition's `ui` block, as `{x, y}`. Not
  storing them was tried first, then reversed: in a graph editor, the
  arrangement is part of what the user built.
- **The editor places a node that has no position**, never the server. Layout
  depends on how the browser draws a node, and one layout engine, not a
  second in Go, keeps every placement the same.
- **The canvas reads in run order** (2026-10-28): arrows point the way data
  and time go, so a step that stitches others' results sits after them,
  and the response comes last. Drawing it as calls, the response first
  with arrows to what it's built from, was the other option; it puts what
  runs first at the far end, and plan 11's run playback needs run order.
- **"Upstream" means only the API a step calls** (2026-10-28). Graph
  direction is before and after (design.md, Words).
- **A step joins its own branches** (2026-10-28). It can take several
  arrows, waits for all of them, and stitches them in its own mapping: what
  it receives is its parents' results keyed by name. Forcing every join
  into a transform step, so a call takes one arrow, was the other option:
  a rule that's easier to state, for one more step per join on the canvas.
  Transform steps stay optional, for a named combine or a reshape several
  steps share.
- **The workflow's settings open behind a button**, in the side panel, so
  the graph stays roomy (2026-10-28). The other option showed them
  whenever nothing was picked, keeping the panel always open.
- **The response is a card on the canvas** (2026-10-28), the last one,
  holding the output and its schema, so the graph shows what goes back to
  the caller. The other option kept the output only in the settings.
- **On screen, an edge is a "connection"** (2026-10-28); the API and code
  keep "edge". "Edge" and "link" were the other options.
- **A step reads every earlier step by name** (2026-10-28), as the engine
  already does (`server/internal/engine/run.go:262`). Reading only what
  points into it would make the arrows carry the data, at the cost of long
  extra arrows; Step Functions moved the other way in 2024 (sources.md).
- **An HTTP step's panel has Request and Response tabs** (2026-10-28),
  after a field called only "Body" left you unsure whether it was sent or
  received. The Response tab says how the steps after it read
  `nodes.<id>.status`, `.headers` and `.body`; phase C's last response and
  phase D's sample go there too. Headings on one scroll were the other
  option, with the response below the fold on a laptop; renaming the field
  was the third. Since 2026-10-30 Preview holds the body and the sample, and
  the Response tab is gone (Decided with you, phase D).
- **A step's sample response stays in phase D** (confirmed 2026-10-28),
  arriving with the previews it feeds.
- **Publish puts what's on screen live** (2026-10-30): unsaved changes are
  saved first, as Run will; a draft with problems isn't sent. "Save first",
  two clicks, and publishing the last saved revision were the other options.
- **Problems are listed behind a button** (2026-10-30): "2 problems" beside
  Save opens them in the side panel, and each entry opens what it's in. A
  strip under the canvas, or marks with no list, were the other options.
- **The editor words problems itself** (2026-10-30), by their code and
  place, in the screen's words ("Add a URL."), and shows the server's detail
  where that's the specific part: a JSONata syntax error, which URL rule
  broke. The server's text says "node" and "/nodes/0"; showing it, or
  rewording it on the server, were the other options.
- **A newer revision is loaded, never saved over** (2026-10-30, late
  night, your call). Saving anyway was built first: it made this draft the
  next revision, the other kept in the history. You took it back out to
  keep it simple, and deferred branches and merges, as in git, as likely
  more harm than use for now. The editor also learns of a newer revision
  when the window regains focus, as the workflow is fetched again, so it
  says so before a save is tried.
- **After a save the editor stays as it is** (2026-10-30, your "continue"
  after I recommended it): the new revision is the next save's base, and
  the open panel, tab and picked step stay. Reloading the saved revision was
  the other option.
- **Tests open the editor through one helper**, `renderEditor` in
  `web/src/test/editor.tsx` (2026-10-30), extracted before step 4 changed
  the editor's props, rather than patching 18 copies of the call.
- **The look waits** (2026-10-30). After step 4 comes a "v0": the editor
  working, and which elements each screen will have, with no visual design,
  which stays plan 11's. What v0 covers is agreed once step 4 is in.

Decided while building, without a question (each can be overruled):
- **No `toDefinition`.** The draft is the one source: edits change it, and
  `toFlow` redraws. A drag moves the node as it happens and writes its
  position when it ends.
- **Every node is drawn 240 by 72**, so placement and drawing agree.
- **Nodes without a position are laid out with dagre, then put below the
  placed ones**, so a node an agent or a script adds never lands on one
  somebody placed.
- **A draft saved with problems still draws.** A repeated or empty id gets a
  `#<index>` key, which no valid id can clash with; an edge whose end names
  no node isn't drawn but is listed, so the problems panel can offer to
  remove it; an unknown kind draws as an `unknown` node.
- **@dagrejs/dagre stays at 3.1.1**: 3.1.2 and 3.1.3 were under five days
  old when it was added. zustand is 5.0.16, six days old when added.
- **The editor's store is made once**, from the revision the page loaded,
  with the editor keyed by workflow id, so a refetch never touches the
  draft.
- **React Flow follows the system's colour mode**, as the rest of the app
  does.
- **The shell is the window's height**, and `main` scrolls inside it, so the
  canvas can fill what's left of the page.
- **Canvas tests run in jsdom with a small shim** (`src/test/react-flow.ts`)
  for what React Flow measures with. React Flow's own guide prefers a
  browser for this, so the canvas's look is checked in Chromium: the spec
  example drew four nodes and four edges through nginx, light and dark, with
  no console errors.
- **The first edit settles the layout**: before any edit, each node placed
  automatically gets the position it's drawn at written into the draft, so
  nothing moves under the user. Found in the browser: the first drag of a
  workflow made through the API sent the other nodes below the dragged one,
  because they had become the ones without a position. A workflow that's only
  looked at keeps none stored.
- **A drag lives in the store until it ends**, then its rounded position
  goes into the draft, rather than the draft changing on every frame.
- **Adding a node asks for its id**, checked against the id pattern and the
  other ids as it's typed, and puts the node in the middle of the view. An
  http node starts as a `GET` with no URL and a transform with no
  expression; the problems say so until they're filled in.
- **Delete and Backspace delete** what's selected. A node whose id is
  missing or shared can't be connected, since an edge names nodes by id.
- **Editing was checked in Chromium**, through nginx: a drag stays where it
  was dropped, a new edge appears, a cycle is refused, Backspace deletes the
  selected edge only, and a node is added and deleted, with no console
  errors. React Flow's drag doesn't run in jsdom, so these stay browser
  checks until Phase E's Playwright test.

The step's settings (step 3c), decided while building, each open to
overruling:
- **Picking one step opens its settings** in a panel beside the canvas,
  which narrows it; Close or another pick puts them away. Text on screen
  says "step" (plan 11).
- **Changes apply as they're typed**, so the canvas follows; no Apply
  button, the usual canvas-editor default. The id is the exception: it's
  checked as typed and applied when the field is left or on Enter, since
  edges and positions point at it. Its edges and position go with it, the
  selection follows it, and a note lists where expressions still read the
  old id, by plain text match.
- **Numbers diverge from "parsed on blur"**: timeout and attempts count
  once the text is a whole number in range, and until then the stored
  value stays and the field says why. The field keeps its own text, so
  nothing typed is eaten, and one path handles every field.
- **The form is keyed by the step's place in the draft, not its id**
  (the plan said `key={nodeId}`), so renaming doesn't remount it under the
  cursor.
- **An edit that changes nothing leaves the draft alone**, settling
  included. A header row with no name yet, or a half-typed number, isn't an
  edit, so nothing will ever take an untouched draft for a changed one.
- **Header and query rows** are keyed by their field-array id. A row without
  a name isn't written; a repeated name is marked, and the first counts.
- **Picking a step pans the canvas as little as it takes** to keep that step
  in sight once the panel narrows it. **A drag no longer picks**: React Flow
  picks on drag by default, which opened the panel mid-drag.
- **Retry needs attempts**: Idempotent is disabled until attempts is a
  number from 2 to 5.
- Deliberate TODO for plan 10's JSONata editor. Since phase D, one field
  edits a request body, a transform's expression, a connection's condition
  and the output, so one TODO covers all four:
  - `web/src/features/editor/components/mapping-field.tsx:96`
- Deliberate TODO for exact taken lines in a run (Phase C, decided while
  drafting, 2), done on 2026-11-01: the engine records them.

Found in Chromium while checking 3c, and fixed:
- **Every edit blinked all the edges off.** React Flow keeps a node's
  handle positions only when the node object says it was measured, and
  every edit draws new node objects. Typing seven characters into a URL
  made seven frames with no edges. `toFlow` now gives each node its
  measured size, which is fixed. True since 3a for drags and connections,
  which hid it. A rename still blinks the renamed step's own edges for a
  frame: to React Flow, a new id is a new node.
- **Delete or Backspace on a button in the panel deleted the step being
  edited**, and the same on the add-step dialog's buttons (since 3b). React
  Flow takes those keys anywhere but in text fields; both now carry its
  `nokey` class, which a jsdom test pins.
- **Two CSP violations.** Base UI's select added an inline `<style>`
  (`style-src 'self'` refused it); `CSPProvider disableStyleElements` in
  `main.tsx` turns those off, and the rule lives in `index.css`. zod's
  probe for `new Function` was reported although zod catches the refusal;
  `z.config({ jitless: true })` skips it. jsdom has no CSP, so only the
  browser shows these.
- Checked in Chromium through nginx after the fixes: pick, the method
  popup, URL, rename on Enter (focus stays), header rows, retries, close and
  reopen with everything kept, light and dark, with no CSP violations and
  no console errors.

Connections, the response and the workflow's settings (step 3d). The
three choices below were yours (Decided with you); the rest were decided
while building:
- **One side panel shows one thing at a time**: the picked step, connection
  or response card, or the workflow's settings. Opening the settings puts
  away what was picked, and picking something closes them.
- **A connection's condition applies as it's typed**; blank removes it. A
  conditional connection shows a small "if" on the canvas, and what it
  says stays in the panel, so the graph carries no code.
- **The response card is drawn by the canvas, not `toFlow`**, since it
  isn't a node of the definition. It sits after the rightmost step, level
  with the middle, and moves when the steps do. Its `#response` key keeps
  it out of positions, connections and deletion; it can be picked but not
  dragged, and a drag that starts on it pans the canvas. It says which steps
  the output reads, by the same plain text match as the rename warning.
- **The schema fields count once their text is a JSON object**, as numbers
  do: until then the stored schema stays and the field says why. Format
  rewrites the text indented.
- **The toolbar carries `nokey` too**: Backspace on a focused toolbar button
  deleted the picked step, like the panel's buttons before 3c's fix.
- Checked in Chromium through nginx: the card after crm, a connection's
  "if", the output's "Reads user, crm", the settings' Format, Backspace on
  the toolbar, light and dark, with no CSP violations and no console errors.

Request and Response tabs (after 3d). The tabs were your choice; the rest
was decided while building:
- **The Request tab stays mounted while hidden** (`keepMounted`), so text
  that doesn't count yet, such as `30s` in Timeout, survives a switch.
- **An arrow key opens the tab it reaches** (`activateOnFocus`), as the
  WAI-ARIA tabs pattern recommends when panels show at once (sources.md).
  Base UI's default waits for Enter or Space.
- **The open panel shows focus.** It's in the tab order, as the pattern
  asks when a panel doesn't start with a control, and shadcn's copy had
  `outline-none`; `components/ui/tabs.tsx` now draws the ring.
- **Picking a step opens its Request tab**: the tabs are keyed by the
  step's place, like its fields.
- **The panel being left hides at once** (`data-ending-style:hidden`).
  Base UI keeps it on screen while it might animate out, and right after a
  click Chromium showed both panels together; nothing animates them.
- **The id's hint says what the id is in expressions**: "In expressions,
  this step is `nodes.crm`." It said "Other steps read its result as
  nodes.crm.body", which is wrong for an HTTP step, whose response has a
  status and headers too. The add-step dialog said the same and changed
  with it.
- A transform's field now says the steps after it read its value as
  `nodes.<id>.body`.
- Checked in Chromium through nginx: both tabs, the Response text, `30s`
  kept in Timeout across a switch, ArrowRight, Tab to the panel with its
  ring drawn, Backspace and Delete on a tab, one panel in every frame of a
  switch, the transform's line and the dialog's, light and dark, with no
  CSP violations and no console errors.

Save, problems and publish (step 4). The choices dated 2026-10-30 above
were yours; the rest was decided while building:
- **Problems are checked as you type** (answer 6): the draft goes to
  `POST /v1/validate` once it has stood still for 500 ms, through TanStack
  Query keyed by the draft itself, so a draft is never checked twice. The
  last check stands until a newer one comes back, starting with the opened
  revision's problems. The check's result reaches the editor by React
  context, not the store (web.md: server data never goes into Zustand). A
  check that fails says "Couldn't check for problems" beside the revision.
- **A problem stays on what it's about.** Its pointer is placed in the draft
  as it is now: a step is followed by its id, a connection by the steps it
  joins, so deleting an earlier step doesn't move a problem onto its
  neighbour. Once what it's about changes, such as the field's text, it
  goes, and the next check says whether it's still wrong. Found in
  Chromium: a cleared condition kept its mark for as long as editing went
  on elsewhere, since the next check waits for a pause.
- **Where problems show:** the message under its field, after the field's
  own check, which is about text that doesn't count yet; a red border and a
  mark on its step; "problem" in its connection's label; a mark on the
  response card, the Workflow settings button and the Request tab; at the
  top of a step's or connection's panel when no field holds it; and all of
  them in the list, steps first. A mark is an icon with words for screen
  readers ("Request (1 problem)"), since colour alone isn't a signal.
- **A connection whose end names no step** can be removed from the list. The
  canvas can't draw it, so it can't be opened (Decided while building,
  above: a draft saved with problems still draws).
- **The words** live in `web/src/features/editor/problems.ts`, by code. The
  id, timeout and attempts rules are shared with the forms (`ID_RULE`,
  `TIMEOUT_RULE`, `ATTEMPTS_RULE`), so a field and a problem say the same
  thing. A schema error shows the line of the compiler's report that says
  what's wrong; the report opens with the schema's made-up base URL.
- **Save** is a button, and Ctrl-S or Cmd-S wherever the focus is. It's
  disabled while nothing has changed since the last save or the opening,
  compared as JSON. The line under the name says "Unsaved changes",
  "Saving…", "Saved", or "Not saved." with the reason; the save is quiet,
  so there's no toast as well. A save refused for a newer revision can't
  be forced (Save anyway went on 2026-10-30, late night).
- **Publish**, with unsaved changes, saves first. When the last check was of
  this very draft and found problems, it opens the list and sends nothing; a
  `422` from the server opens the list too. It reads "Published" while the
  open revision is the served one, and the line under the name says
  "Revision 4 is served at <URL>", or "Not published. Publishing serves it
  at <URL>".
- **Leaving with unsaved changes asks first:** another page in the app
  through a dialog (React Router's `useBlocker`), and closing or reloading
  the tab through the browser's own (`beforeunload`, listened for only
  while there are unsaved changes).
- **The name and the buttons moved into the editor**, which knows the save
  state. **A refetch that fails no longer replaces the editor** with
  "Couldn't load it.": the page shows that only when it has no workflow at
  all. Latent since Phase A, as the workflow's query refetches when the
  window regains focus. **Load newer revision** opens the editor afresh.
- **`workflowKeys` moved to `web/src/lib/query-keys.ts`**, as web.md says
  code does once a second feature needs it: the editor updates the workflow
  it saves and publishes.
- **Vite's dev server forwards `/serve`**, as nginx does, so the served URL
  the editor shows works under `just dev` too.
- **The store's settings flag became a panel** (`settings` or `problems`),
  and `show()` picks what a problem is in.
- Checked in Chromium through nginx, light and dark, on a new
  `pw-step4-…` workflow: a problem as it's typed, under the URL, on crm, on
  its Request tab and in the list, and the list opening crm; a bad
  condition labelled "if · problem", gone at once when cleared; Ctrl-S; a
  save after another tab saved, then Save anyway; Publish and its served
  URL; leaving asks, and Stay stays; closing the tab asks. No CSP
  violations. The console's only lines are the browser's own "Failed to
  load resource" for each `422` and `412`.

After step 4, what it noticed, fixed at your ask (2026-10-30):
- **`POST /v1/validate` answers `200` with the problems**, an empty list when
  there are none, rather than `204` or `422`: problems are its answer, not
  an error. The browser had logged every check that found one as a failed
  request. A body that isn't a definition at all is still refused with
  `422`. Plan 03's endpoint table says so.
- **Ctrl-S in the Id field saves the id typed there.** The id applies when the
  field is left, on Enter, and now on Ctrl-S or Cmd-S too, checked at once
  rather than through the form, so the save that follows has it. The save
  reads the draft as it is at that moment, not as the header last drew it.
- **An entry in the problems list puts the cursor in its field**, a header or
  parameter by its row, once its panel is drawn.
- **A new step lands clear of the others**: from the middle of the view, it
  moves down a step's height at a time until it covers none.
- **The rename warning sets `nodes.<id>` in the code font.**
- **The Response tab says a header name with a hyphen goes in backticks**,
  as in ``nodes.crm.headers.`content-type` ``. Checked on the engine first:
  with backticks a served transform read `application/json`; without them
  JSONata read `content-type` as a subtraction, and the run failed with "the
  expression gave no value".
- **The checks' throwaway workflows** (`pw-` slugs) weren't deleted: the
  permission check refused the delete, as it can't be undone. The SQL is
  for you to run.

## Samples and previews, as built

Samples and the Preview, the first four steps of D (2026-10-30). The order
and the tab's name were yours (Decided with you); the rest was decided
while building:
- **A sample** is `{status, headers, body}`: the status absent means 200,
  and the body is required, `null` for an empty one. Validation checks the
  status is 100 to 599 (200 to 299 since outputs), the header names, and
  that a body and the sample input are each at most 64 KiB. A sample on a
  transform step is refused: its value comes from its expression.
- **The simulation is the engine's own code.** `engine.Simulate` builds the
  program as far as it compiles (`Compile` is now that build, refusing
  any problem), renders a request with the function a run sends it with,
  and builds the document with the run's builder, so header names come out
  in lower case as a run reads a response's.
- **A step with no sample is named, never guessed at**: what it would get
  back isn't in the document, the step after it still previews with what
  there is, and an expression reading it gives nothing, which says so.
- **A sample outside 2xx failed its step**, as a run would on that status,
  so that was how to see what a failure does to the steps after it.
  Outputs replaced it: a response besides 2xx is an output with a sample
  of its own (Outputs by status, as built).
- **Conditions decide what runs**, as in a run, but only on the connections
  the preview follows. One from a step the preview couldn't run counts as
  taken, since it might be; one whose condition fails counts as taken and
  says why. A step no taken connection reaches is shown as skipped.
- **Only the problems in the way come back**: those in the steps it runs,
  the connections between them, the sample input, and the output when
  that's what it previews. A step on or after a loop isn't run; the loop's
  problems say why.
- **A retried POST's Idempotency-Key shows as `<run id>:crm`**, which a run
  fills in with its own id.
- **The whole preview has a 3 s deadline**, besides each expression's
  guardrails, and a panic comes back as an error. The deadline isn't tested.
- **On screen**, first built as "Reads", "Sends" and "Gets back", then
  made the workbench below at your ask: the input as a tree, the JSONata,
  and "It sends", "It gives" or "It answers", each value as indented
  text. A preview waits for the same half-second pause as the check, and
  keeps showing the last one while the next comes.
- **Preview holds the request body and the sample's fields**, and stays
  mounted while hidden, as Request does; a problem in either marks it.
  Opening such a problem from the list opens Preview with the cursor in the
  field.
- **The two Format buttons in Workflow settings** say which field they
  format, for a screen reader: "Format input schema", "Format sample input".
- **The data workbench** (after your "Preview holds it all"): the input is a
  tree, its first three levels open so a step's body shows its fields;
  every field and item is a button that writes its JSONata path, with
  backticks around a name JSONata can't read bare, as `content-type`,
  checked on the engine. A pick goes where the cursor is, read from the
  field at the moment of the pick, since a field keeps its selection when
  it loses focus; before the field has had the cursor, at the end. Found in
  Chromium: the first version followed the cursor through `onSelect`,
  which missed moves made with the keys, and put the paths in the wrong
  places. A transform step and the response card have the same workbench:
  input, expression, then "It gives" or "It answers". The Request tab's form
  no longer holds the body, so editing the call can't write a stale body
  back over Preview's; a test pins that.
- **Your local Spec example got made-up samples as revision 3**, saved with
  If-Match on revision 2, everything else as it was. Its step `prefsg`, a
  rename since revision 1, is yours and stays. The made-up samples in tests
  are the Go tests' `sampled` definition; the web's preview tests answer
  from fixed previews, as the server's simulation has tests of its own.
- **The workflow package's coverage floor rose from 88% to 95%**, which it's
  at now.
- Checked in Chromium through nginx, light and dark, on the Spec example:
  crm reads the input and user, orders and prefsg from their samples, and
  sends `{"email": "ada@example.com"}`; orders' URL renders `?user=7`; a
  body typed to read three steps previews as `{"email": …, "orders": 2,
  "newsletter": true}` half a second later; the output answers
  `{"crm_id": "c-1"}`. No CSP violations and no console errors.

## Outputs by status, as built

The steps of "Phase D: outputs by status" (2026-10-30). The plan's ten
drafting decisions held. Decided while building:
- **Every HTTP step shows its `2xx` handle labelled**, even with no other
  response, so the place a connection leaves from is always named. A
  transform step keeps one unlabelled handle.
- **A step grows from its fourth handle on**: handles sit evenly down its
  right side, at least 24 px apart (design.md's target spacing), so four
  make it 120 px tall. A step whose handles change tells React Flow, which
  otherwise finds handles only when a step mounts.
- **On screen, each response's fields carry its name**: "2xx body", "404
  headers", "Format 404 body", "Remove the 404 response", since several sit
  on one tab. The "Add a response" field takes 300 to 599 and refuses one
  the step has, before the server would.
- **A connection names its response** for an HTTP step's: "From prefs, on
  2xx, to crm." Its condition's example became
  `nodes.user.body.active = true`, as a status is now a response's to
  pick.
- **A connection's workbench ends "With these samples"**: "Taken, so crm
  runs."; "Not taken. crm runs only if another connection into it is.";
  "A run would skip user, …"; or that it can't tell, when the condition
  fails, the response it leaves from has no sample, or an end names no
  step, with the problem saying why. `POST /v1/preview` takes `edge`; one
  out of range is 422 `unknown_edge`, and `node` with `edge` is 422
  `not_allowed`.
- **The input tree opens the steps connected**, so in the Spec example
  crm's tree opens orders and prefsg and folds user, which crm reads but
  sits two steps back: one click opens it.
- **A connection from a response its step lacks isn't drawn**, as one to a
  missing step isn't; the problems list offers to remove it.
- **Problems are worded for the new codes**: "A status from 300 to 599:
  2xx is every HTTP step's.", "This step already has a response for that
  status.", "A response's sample takes the response's status.", "user has
  no 409 response. Add one in its Preview tab, or draw the connection from
  another.", and a 2xx sample's status "A status from 200 to 299: this is
  the 2xx response." A problem in a response opens Preview at its sample's
  body; one on a connection follows the response it leaves from too.
- **Checked**: Go tests with the race detector; engine coverage 96.4%,
  workflow 95.0%; 11 mutations, each caught (the last after its test was
  made to tell two connections apart by their response alone); Chromium
  through nginx, light and dark, on your Spec example's draft, unsaved:
  user gets a 404 response with a sample and draws `2xx` and `404`
  handles; a new create_user, a POST, connected from the 404 handle, reads
  user's status 404 and sends `{"id": "7", "why": "not found"}`; its
  connection is "Taken", then "Not taken" under a condition that doesn't
  hold; user → orders reads "on 2xx" and "Taken". No CSP violations and no
  console errors.

## A step's blocks, as built

The steps of "Phase D: a step's blocks" (2026-10-30). The plan's six
drafting decisions held. Decided while building:
- **The blocks**: the request block holds the step's id, method and URL;
  the response blocks are a column 72 px wide on its right, one per
  response and `+ Add` last, each at least 24 px tall, so a step is as
  tall as before. A transform step stays one block, a handle on each side.
- **Which part a click opens is the editor store's** `part`: "request", a
  response's block (`2xx`, `404`) or "add". The canvas reads it from the
  block the click lands in (`data-part`, in `onNodeClick`), once the
  click has picked the step, which opens its request. The panel's tabs
  show and set the same `part`.
- **The tab adding a response says "+ Response"**, as the wireframe had it,
  and is named "Add a response" for screen readers. Its field keeps that
  name, and a response added opens its tab.
- **A response's tab** starts with what its sample is for, moved from
  Preview's "Responses"; then the sample; then "Then, on 404", a row per
  connection leaving on it, "crm always" or "crm if …", each opening its
  line and marked when it has problems; then Connect to, and what the
  steps after read. With no connection yet, it says how to make one.
- **Connect to lists the steps by id**, and says "No step to connect to"
  when none is left: each is joined on this response already, or would
  make a loop.
- **The Request tab** holds the URL, headers and query, then the body's
  workbench, then timeout, attempts and idempotent, as in the wireframe.
- **A problem opens the tab it's on**: the problem list opens a step on
  the part the problem is in (`stepPartOf`), where it clicked the Preview
  tab before. "user has no 409 response" now ends "Add one with + Add on
  the step, or draw the connection from another."
- **The tab row wraps** when a step has more responses than fit, rather
  than widening the panel.
- **Fixed on the way**: keeping the picked step in view went by the
  fixed step height, so the foot of a step with three responses or more
  could stay hidden; it goes by the height drawn now.
- **Checked**: 203 editor tests, lint and Prettier; 10 mutations, each
  caught; Chromium through nginx, light and dark, on your Spec example's
  draft, unsaved: `+ Add` on user opens "+ Response", and 404 added opens
  its tab; user's 404 block opens 404; Connect to joins create_user on 404,
  drawn from the 404 point and listed under "Then, on 404"; the request
  block and the left point open Request, the 2xx point 2xx, and clicks on
  points connect nothing; the Then row and the line both open "From user,
  on 404, to create_user."; a drag from user's 404 to crm still connects.
  No CSP violations and no console errors.

Seen, not fixed:
- At phone width the side panel is wider than the screen: the canvas goes,
  and the panel's right edge is cut off. At the canvas's least zoom the
  Spec example doesn't fit either, so user starts off its left edge. Both
  were so before; the editor at narrow widths is plan 11's.
- A new step lands in the middle of the view, so a connection to it can
  run behind another step. Placement is plan 11's too.

## Phase C, as built

The steps of "Phase C: runs" (2026-10-30, late night). The five drafting
decisions held. Decided while building:
- **The test upstream** answers `GET /users/{id}` (a user for 1 to 9, a 404
  for any other), `POST /users` (201), `GET /orders` by `?user_id`,
  `GET /prefs/{id}`, `POST /contacts` (201), `GET /slow?ms=` and
  `GET /status/{code}`. `just upstream` runs it; `just dev` starts it, and
  lets that one server process call it: private networks allowed, and port
  8090 added to 80 and 443.
- **A run's stream is a query of its own** (`useFollowRun`), which ends when
  the run does. TanStack aborts it once nothing shows the run, and it
  neither retries nor refetches on focus, since `followRun` reconnects by
  itself. Each node event updates the run's live map in the cache; the
  `run` event fetches the run again, which then has every step's request
  and response.
- **A step's status** is what the server recorded, once it has; else its
  last event; else "waiting" while the run goes on, and "not run" once it
  ended. In words: "201, 140 ms"; "done, 3 ms" for a transform; "failed:
  503"; "failed: timeout, after 3 attempts"; "retrying, attempt 2";
  "running"; "skipped"; "cancelled". A mark goes with each, and the running
  one spins only where motion is allowed.
- **The run bar sits in the header**, which knows the revision the draft
  builds on: "Run of revision 3, started 10:46:38 PM: succeeded in 14 ms",
  the time in the browser's own format, then ". The draft has changed
  since." once it has. It's a status region,
  so a screen reader hears the run end.
- **Run is beside Save**, and off while a newer revision exists. Its input
  starts as the sample input, and a `400`'s problems show under it, each
  at its pointer.
- **Runs is on the canvas's toolbar too**, so the history opens with no run
  shown. Each run says when it started, its revision, how it went, and
  "run here" or "called at its URL".
- **Keep as sample** keeps the headers as recorded, content-length and date
  included, and the status for 2xx. A body cut at 256 KiB can't be kept.
- **A line's name says whether the run took it**, as dashes alone aren't a
  signal; the response card says how the run went, and its panel what the
  run answered.
- **Checked**: 282 web tests (14 for the stream reader, 16 for statuses,
  5 for the run's screens), the test upstream's own tests, lint, the
  build; 13 mutations, each caught (one after its test was given two data
  lines, so a CRLF read as two line ends shows). Chromium through `just
  dev` with the test upstream, light and dark, on a `pw-runs` workflow: a
  run on user 7 (user 200, orders 200, create_user skipped, its line
  dashed); user's Request and 2xx tabs with what it sent and got, and Keep
  as sample; a run on user 99 (user 404, create_user 201, orders skipped);
  the response card; the runs list; Close run. No console warnings or
  errors. Chromium through nginx, light and dark: the same workflow's run
  fails at user, as the server there may not call loopback, and reads
  "failed: no answer" with the reason; the steps after say "cancelled". No
  CSP violations and no console problems.

Seen, not fixed:
- A call the SSRF guard refuses reads "failed: no answer", where "blocked"
  is truer; the reason beside it says so.
- Keep as sample keeps headers a sample doesn't need, such as date.

## The API's answers, as built

"Phase D: the API's answers", built on 2026-10-31: the definition,
validation, the engine, runs, serving, unhandled, and the editor's card
and switch. The first build took one line into the card for every answer;
it was reworked to a line per answer the same day, before it was
committed. Decided while building:
- **Two answers one run can reach are found from the graph.** A step needs
  the outputs on every path to it; two answers are apart only when they
  need different outputs of one step, as crm's 2xx and its 400 are.
  Conditions on lines aren't weighed, as whether two JSONata conditions can
  both hold isn't known before a run; a run that reaches two answers
  anyway fails. In your "Fixes check", success_200 → 200 beside
  bad_400 → 400 is a problem: prefs answering 400 runs test_400, then
  success_200, while crm, which runs once orders' line is taken, can
  still answer 400. Reducing a step's paths to what they share also
  raises false alarms: with the calls in a row, people → prefs → orders
  → crm, no run reaches both, yet it's flagged (a throwaway test,
  2026-11-01). Strict joins end both (Phase D, next, after Unhandled).
- **A run's answer is checked once its steps have ended**, and each way it
  can miss fails the run as `workflow_error`, served 500 with the run's
  link unless unhandled answers: "no answer: no line into the response
  was taken"; "two answers: 200 from found and 404 from gone were both
  reached"; "not an answer: respond gave no {status, body} object", "…
  gave "headers", besides status and body", "… gave no whole number as its
  status", "… gave the status 418, and it's joined to 200 or 404".
- **A switch's errors name their field**, "case 2: when: …" or "otherwise:
  body: …", so a problem points at it, in a run and in a preview.
- **Unhandled reads the steps that succeeded and `error`,
  `{code, detail, node}`**, with 5 seconds of its own after the run. One
  that fails adds "; unhandled failed too: …" to the run's error, and
  Conduit's problem details answer. The question said `step`; `node` is
  what a run's error already calls it.
- **`/serve` answers with the run's status and body as they are**, as
  `application/json`; an answer with no body has no Content-Type. A
  revision with neither a response nor an output answers 500: "The workflow
  has no response, so it gives no answer."
- **`answered` is on every run**: the run bar says "succeeded in 14 ms,
  answered 404", or "failed in 500 ms: user answered 503; Unhandled
  answered 502"; the card marks the answer given, and dashes the lines
  into the others.
- **The card is mirrored**, as the wireframe was: the answers on the left,
  each block a point, a dot on its edge, so a line dropped anywhere on the
  block joins it; on the right "Response", "From respond, spare" or
  "Nothing answers yet", and "also 4xx · 5xx, your unhandled body". The
  first
  build had the answers on the right, and one point for the card.
- **Conduit's own answers are 400, 401, 404, 500, 502, 503 and 504**, as
  `/serve` takes a token: the card says "also 4xx · 5xx", and the panel
  lists each, with when it's given; 500, 502 and 504 add "unless
  Unhandled answers". The wireframe's "also 400 · 502 · 504" left out four.
- **Joining**: a drag from a step's point to an answer, or Response 404 in
  Connect to. An answer that has its line refuses a second, and Connect to
  offers only answers with none. Disconnect in the panel, or Delete on the
  line, takes it away, and the answer stays. Renaming the step takes its
  lines along; deleting it, or the response a line leaves on, takes them
  away.
- **The output's move**: `respond`, or `respond_2` when that's taken, runs
  after each step the output reads, on every one of their responses, so it
  runs whichever way they answered, as the output did. It goes after the
  rightmost of them that's placed. The header says "The output moved into
  a step, respond, joined to the response" until the first save.
- **A refused line** makes the card say, under it: "200 takes one line,
  from respond. To answer 200 from spare too, merge them into one step.";
  off any answer, "Let go on the answer spare gives: 200 or 400."; with no
  answers yet, "Add an answer with + Add, then join spare to it." It stays
  until the next edit, pick, drag or click on the canvas, and it's a
  status, so a screen reader hears it. A step with nothing to join says,
  under Then: "Each answer on the response takes one line, and has it: to
  answer from here, merge this step with the one that gives the answer."
- **The switch's panel** shows what the step reads once, and a field
  picked from it goes where the cursor was last, or, before any field has
  had it, into the first case's condition. A new case's status is an
  answer the step is joined to that no case gives yet, else Otherwise's. A
  status field takes only a whole number from 200 to 599, and says so
  otherwise. The step's card says what it answers: "400 · 404 · else 200".
- **The note on bodies that send the run** is a text match, as the browser
  doesn't parse JSONata: `$$` or `nodes` whole, or a step's `headers`;
  `$$.input.id` and `nodes.user.body` pass. It's under the expression of a
  step that answers, every switch's bodies, as its cases exist to answer,
  and Unhandled's.
- **Problems** mark the card, show under their part of the panel, and the
  list names them: "Response · 404 · its line", "Response · Unhandled",
  "respond · Case 2 · When".
- **Checked**: `just check` (formatting, lint, race tests and coverage
  floors, 352 web tests, typecheck, the build, generated code), and the Go
  tests again uncached; the workflow package's floor rose to 96. 27 Go
  mutations and 41 web ones, each caught in the end: two Go and three web
  only after a test was added or tightened. Chromium through nginx, light
  and dark: `pw-cases`, a switch joined to 200 and 400, its card ("400 ·
  else 200") and panel ("It answers 400" over the sample); runs with key 1
  and key 2 answering 400 and 200, each marked, the other line dashed; 409
  added, and a line from spare dropped on its block, off the point; a line
  onto 200 refused, with its note; `/serve` answering
  `400 {"error":"bad key"}` and `200 {"key":2}`; `pw-default`, its
  upstream unreachable, served
  `502 {"error":"upstream_failed","step":"user"}`; and your "Fixes check"
  opened, nothing saved. No CSP violations and no console problems. Not
  run: Chromium through `just dev` with the test upstream, as `just up`
  was running and they share Postgres.

Seen, not fixed:
- An answer's schema field repeats its status ("404", then "404 schema"),
  as each field needs a name of its own.
- A moved output's lines fan in from every response of each step it reads,
  which crowds a step with many responses.
- The card cuts its line short during a run: "In this run: succeeded in…".
- Your "Fixes check" was saved, revisions 18 to 24, while the card took
  one line, so its 200 has no line now; joined again, it shows the
  problem above.

## A step's Unhandled, as built

"A step's Unhandled", built on 2026-11-01, after the API's answers were
committed (8cbc5b1). Decided while building:
- **Unhandled is one more output**, counted beside the statuses: -1 in
  the server (`workflow.OnUnhandled`) and the editor (`UNHANDLED`), and
  `unhandled: true` in the definition. Validation, the reach check and
  previews needed no rule of their own: an answer after a step's
  Unhandled and one after its 2xx are apart, as two of its responses are.
- **The failure codes moved into the engine**, with `Classify`, as a
  caught step hands its code on to the steps after it. The runner keeps
  its names for them.
- **A condition on a line from Unhandled that fails fails the run**, and
  its detail says both: "GET …: status 404; then edge to gone: when: …".
  The condition is the cause, so the run's code is `workflow_error`.
- **What a caught step hands on**: `error`, `{code, detail}`, its detail
  the one the run records, with `status`, `headers` and `body` when the
  upstream answered. A 2xx body that isn't JSON reads as status 200 and
  body null.
- **The response's Unhandled reads caught steps too**, as the steps after
  them do.
- **Previews** take a step's 2xx when it leads to the step previewed, else
  a status, else its Unhandled, whose made-up error says "user failed:
  made up, as a preview calls nothing".
- **The strip** is 24 px tall, a handle's room, and every card grows by
  it. Until a line leaves it, it says "Unhandled · fails the run",
  dimmed. A click opens an HTTP step's Unhandled tab, after + Response; a
  transform's panel has the section after its connections, and the click
  brings it into view. Its Connect to is called "Connect Unhandled to",
  so a transform's two aren't one name to a screen reader.
- **The response card's strip** says "Unhandled · your body" or
  "Unhandled · problem details", and its third line is "also 4xx · 5xx"
  again.
- **A run's marks**: a caught step's line says "Unhandled: 500", and its
  strip ", the block its failure took". A run that failed and was
  answered by the response's Unhandled marks the card's strip. Before, it
  marked the answer block with the same status.
- **Joining a transform's Unhandled to an answer** leaves the transform as
  it is: a failure picks no answer, so it doesn't become a switch.
- **A step's part stays Unhandled across edits**: the store had sent any
  part that wasn't one of the step's responses back to Request.
- **Tests pick a later option from the keyboard**, as a click on any but
  the first does nothing in jsdom.
- **The body, built the same day**: it reads the step's own failure, its
  part of the data document as the steps after would read it without a
  body, and its value takes the body's place there, status, headers and
  error staying. A run records it as `gave`, beside what the step got. One
  that fails fails the run, "GET …: status 404; then unhandled: body: …",
  as the workflow's fault. A preview of the step has `unhandled`, what
  the body reads, its failure made up, and what it gives; a step after
  the block reads the body's value. Write your own starts it at
  `{ 'error': nodes.<step>.error.detail }`, and Give what the step got
  instead takes it away. Joined straight to an answer, the note on what
  the upstream sent shows only without a body; with one, the note on a
  body that sends the run does. In a run, the tab says what the block
  took: the failure, what the step got, and what the body gave. A
  transform that failed says no "It gave" of its own.
- **Fixed on the way**: with six tabs, an HTTP step's wrapped onto a
  second row drawn over the URL label, each tab as tall as the list; they
  now take their own height. The response tabs said a status with no
  block fails the run; it goes to Unhandled.
- **Checked**: `just check` (formatting, lint, race tests and coverage
  floors, 368 web tests, typecheck, the build, generated code). 27 Go
  mutations and 28 web ones, each caught but one Go: the reset of caught
  when a panic follows a caught failure, which no test can reach. Three
  web ones were caught only after a test was added. Chromium through
  nginx, light and dark: `pw-unhandled`, whose upstream can't be reached.
  The strips, and the Unhandled tab a click opens; a run going on to
  fallback and answering 503, the line from Unhandled taken and the one
  from 2xx dashed; a line dragged from a strip onto a new 500 answer; and
  `/serve` answering `503 {"error":"upstream_failed"}`. No CSP violations
  and no console problems. Not run: Chromium through `just dev`.
- **Checked, the body**: `just check` again (379 web tests). 12 Go
  mutations and 13 web ones, all caught: one Go and four web only after a
  test was added. Chromium through nginx, light and dark: `pw-body`, its
  six tabs in two rows within the list, the body and what it gives over a
  failure made up, a run answering 503 with the body, the tab saying what
  it took and gave, and `/serve` answering
  `503 {"down":true,"why":"upstream_failed"}`; your Fixes check's crm
  opened, its tabs in two rows, nothing saved. No CSP violations and no
  console problems.

## Strict joins, as built

"Strict joins", built on 2026-11-01, after a step's Unhandled and its body
were committed (80d55d4, 4fb0aec). Decided while building:
- **The engine still waits for every line into a step to end**, then runs
  the step when each step with a line into it took one of them. A step
  could be skipped as soon as one of them took none, but nothing would end
  sooner: the run waits for every step anyway.
- **A route is, for each step a step needs, the outputs that step may
  answer through.** One step's lines into another make one set, and two
  needs of one step narrow to the outputs they share. With none left, the
  step can never run, and says so at the step: "transform can never run:
  it needs prefs to answer 2xx and 400". The steps after it can't run
  either; they aren't named again, and an answer after them is no
  overlap.
- **Two answers overlap only when their routes agree**, so the check is
  exact, conditions aside. A step has one route now, so the false alarm
  its two routes raised before can't happen.
- **Previews follow the rule**: a step with a connection from a step that
  ran but took none of them is skipped. One from a step the preview
  couldn't run, for want of a sample, still counts.
- **The editor keeps the step's id as written** and says the rule after
  the server's words: "… A step runs only when each step with a line into
  it answers through one of them."
- **What it costs, as decided**: your Fixes check's success_200 says it can
  never run. A revision saved with an output moves it into a `respond`
  joined to each step the output reads, so on a branch that skips one of
  them, `respond` is skipped too, and the run gives no answer.
- **Seen, not fixed**: `TestGuardrails` in the transform package fails
  without `-race`. Endless recursion ends with the evaluator's depth
  error, U1001, before the timeout the test expects, D1012; under `-race`,
  as `just check` and CI run it, the timeout comes first. The guardrail
  stops the expression either way.
- **Checked**: `just check` (379 web tests), with the workflow package's
  floor raised to 97. 15 Go mutations, each caught, three only after a
  test was tightened. Chromium through nginx, light and dark: your Fixes
  check opened, nothing saved, success_200 marked, and the problem list
  saying it can never run, and why. No CSP violations and no console
  problems.

## The finish, as built

Built on 2026-11-01 after 5adbc71: the four parts planned above, in one
go, your call. Decided while building:
- **Conditional, worked out**: `workflow.Outcomes` reads validation's route
  of the step, and, for a step the route says nothing of, whether that step
  always runs: a first step does, and so does one whose lines always come.
  A line always comes when it has no condition and leaves a step that
  always runs and answers only through that line's output. A merge needs
  one such line, a transform with required lines each of those. A step the
  route rules out in some way is conditional. Its outputs are the route's,
  else every one it has: an HTTP step's 2xx and the statuses it lists, a
  case's statuses, and Unhandled when a line or an answer leaves that.
- **The tags and notes**: Unhandled comes last, a transform's one value is
  "value". "Mark the line that brings it required", not "its line", as the
  line to mark may be further back. A step that may fail into Unhandled is
  checked with `$exists(nodes.x.error)` rather than its status. Several at
  once: "a and b are conditional", "prefs and user answer more than one
  way, as tagged".
- **The lines a run took**: the engine records them where it decides them,
  `Line{To, On}`; the store's `node_runs.took` (migration 20261101140000,
  which drops `ways`, so older runs lose theirs); the API's `took` on a
  node run and on the event that ends it, each a `Line`, `{to, on,
  unhandled}`. `ways` went, and with it the engine's `came`. A line into a
  step is taken when its step's `took` has it; a line into an answer is
  taken as before, the only use `takenOf` has left. It came by is the
  lines into the transform its steps took.
- **The small fixes**: rename warnings name a case ("check's case found",
  "check's Case 2"), a step's Unhandled body and the response's, and say
  "connection", as the screen does. A preview's problem drops the field and
  the step its pointer names, for an expression, a case, an Unhandled
  body, a condition and a sample alike.
- **Phase E**: `web/e2e/done.spec.ts` holds the Done flow and the
  definition with no layout. `web/playwright.config.ts` starts the test
  upstream (18090), the server (18080, private networks and the upstream's
  port allowed) and `vite preview` (14173), whose proxy
  `CONDUIT_API_ORIGIN` points at the server. `just e2e` makes `conduit_e2e`
  afresh with the compose container's psql, migrates it, builds the app and
  runs Playwright; `just check` runs it in place of its build, `just setup`
  installs Chromium, and CI Chromium's libraries. Vitest skips `e2e/`,
  `tsconfig.e2e.json` checks its types, and Prettier and ESLint skip its
  results.
- **The flow**: the test upstream's prefs answers after `?ms`, as `/slow`
  does, so the run is seen as it goes: prefs running, user and orders 200,
  crm waiting, then each with its time. Met while writing it: an open panel
  narrows the canvas, so the test presses Fit View before clicking a card;
  a card says "200" while a run streams and "200, 12 ms" once it's
  recorded.
- **Found and fixed**: a component test that looked for a line into an
  answer before the canvas had drawn it passed alone and failed beside the
  rest of its file; it waits for the line now (`response.test.tsx`). The
  browser test called the served address once the header named it, which
  it does before publishing too, so a slow publish answered 404; it waits
  for "Revision 3 is served at" now.
- **Divergence**: the Done flow joins crm to the 200 answer, as the editor
  has answers rather than an output.
- **Found after, in your Fixes check**: marking test_400's line into
  merge_200 required, as the new note advises, took test_400 out of
  merge_200's Input and showed the step skipped. Its preview ran once per
  line that may not come, crm's 2xx and 500, each with the required line
  too, and the steps before steered towards both at once: prefs answered
  2xx for crm, so test_400, after prefs' 400, never ran. Now a
  transform's preview runs once per line into it, required ones too, and a
  run comes by the required lines first, the steps they need keeping
  their answers, then by its own line where they let it. A line that
  doesn't come in its run says so: "By crm · 2xx: no run comes this way
  with these samples." A required line's run is marked "(required)". This
  replaces "with fewer than two lines that may not come, one run", from
  the lines as parameters, as built. A line whose step the preview
  couldn't run, for want of a sample, still counts as one that might come,
  as it does for a join. A condition that's false over the samples still
  takes its step out of the Input, as no run reaches it. Checked: 11
  mutations, each caught; Chromium through nginx, light and dark, on a copy
  of your Fixes check with test_400 required: test_400 in merge_200's
  Input, "By test_400 · 2xx (required)" answering 200, and crm's two lines
  saying no run comes that way.
- **Required is a promise and a gate** (your call, 2026-11-01, after the
  fix above): a transform runs only once its required lines came, so its
  expression reads their steps without checking. Marking test_400
  required in your Fixes check shuts crm out of merge_200, as prefs answers
  2xx or 400, never both, and crm vanished from its Input with no word why.
  Now a line a transform's required lines shut out is a problem on that
  line, `never_taken`: "crm's line to merge_200 can never be taken when
  merge_200 runs: it needs prefs to answer 400 and 2xx. To run merge_200
  after whichever line comes, mark none of its lines required; or remove
  this one." The Required box says what it does, "A promise that test_400
  is there whenever merge_200 runs, so its expression can read it without
  checking: merge_200 runs only once this line came", and the Input's note
  offers it "to run this step only when it comes". A promise without the
  gate, the transform running once any line came and saving checking the
  promise, was asked about and picked, then turned down for both. Checked:
  7 mutations, 5 caught, and the 2 conditions they survived were dead, so
  they went.
- **Checked**: `just check` with everything staged: Go tests under `-race`
  with the coverage floors (workflow 97.8%, engine 96.2%, runner 92.2%),
  golangci-lint, web format, lint, typecheck and 416 tests, the browser
  test (2 tests) on a build, and the generated code. 50 mutations, 28 in
  the server (outcomes, steering, `took` from the engine to the API, the
  wording, the test upstream's wait) and 22 in the editor, each caught,
  one only after a test was added: a transform whose required line may
  not come. Chromium through nginx, light and dark: prefs_ok's Input
  tagging prefs "2xx or 400" and fallback "conditional", with both notes;
  renaming fallback naming pick's case light; a run in which t was skipped
  for want of its required line, b's line to it taken. No CSP violations
  and no console problems.

## A transform's lines as its parameters, as built

Built on 2026-11-01 on top of "a step and a transform" (84fc8dd), with the
panel's tabs first, staged before it. Decided while building:
- **One rule for both**: the engine's join and a preview's are one
  function, so a run and a preview agree on when a transform runs: every
  line into it marked required taken and, with none marked, any. Validation
  joins a transform's required lines as it joins an HTTP step's, so
  never-runs and the answers' overlap see them; with none marked, its route
  is the merge's, as before. `required` on a line into an HTTP step is a
  problem (`not_allowed`); its panel shows Required only then, so the mark
  can come off, and the problem list takes the cursor there.
- **A preview comes by the required lines into every transform it runs**,
  not only the one previewed, the steps before each answering as they must
  for it to come: a step after the transform, and a line out of it, would
  otherwise see it skipped. The output's preview still has every HTTP step
  answer 2xx. A line marked required into an HTTP step, or whose end names
  no step, leads nowhere.
- **Ways, as built**: a run by each line that may not come, once there are
  two or more; with fewer, one run, by the required lines. A run by a way
  that skips the transform says so: "By fallback · 2xx, a run would skip
  this step: a connection it needs isn't taken." A problem two runs share
  is listed once. The Unhandled body reads what the runs read, merged, and
  isn't previewed when every run skips the step.
- **Cases by way**: each tab says, under "With these samples", what holds
  in the run by each line: "It answers 200:" and its body, "light holds,
  not this.", or "Nothing: the problems above say why." when no case held
  or one failed, as the merged problems can't tell which run's it was.
- **A way from a case is named by it**, "check · found" rather than
  "check", in the preview and in It came by.
- **The words**: a line's panel says how it joins: needed, as every line
  into an HTTP step and a transform's lone line; required; one of several
  ways beside required lines ("runs once its required lines are taken,
  with this way or without it"); or one of several, none required ("runs
  if any of its ways is taken"). A transform's never-runs problem ends "It
  runs only when every line into it marked required is taken; to run it
  after whichever comes, mark none of them required."
- **Divergence**: your Fixes check's merge_200 (revision 41) now lists four
  notes in its Input: crm's 2xx and 500 and orders' 2xx have no samples,
  and Case 1's body gives no value in the runs by crm, which the picker,
  starting at test_400, never showed. A line into a transform its required
  line skipped shows "not taken" in a run even when its own step answered,
  as for an HTTP step: taken means the step it leads to ran.
- **Checked**: Go tests under `-race`, golangci-lint, web typecheck, lint
  and tests (see the wrap-up for `just check`). 50 mutations, 27 in the
  server (validation, routes, the join, ways, steering, the API) and 23 in
  the editor, each caught, two only after a test was added: a required
  line into an HTTP step leading the preview, and the steps before two
  required lines led only towards the last. Chromium through nginx, light
  and dark: a transform's preview by prefs · 2xx and fallback · 2xx, the
  Input merged, no picker; a transform with cases saying what holds by
  each; Required marked from a line's panel, that line solid, the other
  dashed, the words as above, and the transform then previewed by the
  required line (prefs answering 400); no Required on a line into an HTTP
  step; a run in which the required line wasn't taken skipping t, and one
  in which it was answering 200; your Fixes check opened, nothing saved, no
  problems, merge_200 as above. No CSP violations and no console problems.

## Cases as exits, as built

Part 2 of "a step and a transform", built on 2026-11-01 on top of part 1,
staged. Decided while building:
- **A case answers as an http node does.** The engine gives a switch's
  status and body apart: the run records the status as an http node's
  (`http_status`, `response.status`), its part of the data document is
  `{status, body}`, a body left out null, and the output it answered
  through is its status exactly, 200 among them, not 2xx: `exitOf` for
  the engine, `wayOf(run, cases)` for the editor's run lines. A preview
  of it still gives `{status, body}`.
- **No case holding is `ErrNoCase`**, "no case holds", a failure of the
  node's own; a preview says so at the switch, and each tab says "With
  these samples, no case holds: the step fails, and its Unhandled takes
  that". A switch needs a case (`/switch/cases` required), so a step
  with cases keeps its last one: Remove is off for it.
- **Lines from a transform with cases** name a case's status, required;
  one naming none or a status no case gives is a problem, and the canvas
  doesn't draw it. An answer joined to a case's exit has its status, or
  it's `other_status`. The checks of a switch's statuses against the
  answers it's joined to (`unknown_answer`, `never_given`) went, as
  lines name exits now.
- **Its panel**: Input, once, above the tabs, with the way picker, as a
  field picked goes into the field the cursor was last in, any tab's; a
  tab per case, keyed `case:<k>` so typing a new status keeps it open,
  moved with its case; each says whether its case holds over the samples,
  else which does; then what leaves its exit, "Then, on missing". + Case
  takes a name and a status, the first answer's no case has by default,
  else the first free from 400. A status another case has is refused
  where it's typed: "found exits with 200." A problem in a case opens its
  tab.
- **Its card** keeps the status whole and lets the name give way, as the
  status names the exit.
- **Tabs first** (your note, after 84fc8dd): the tabs come right after the
  step's id, as an HTTP step's do, and each case's tab holds what it
  reads, with the way picker, as its JSONata is written from that; a
  field picked goes into that tab's field the cursor was last in, else its
  condition.
- **Mutations**: one survived, the engine writing a body left out as null:
  json.RawMessage prints nil as null in this Go (1.27), so that line was a
  second check and went, a comment saying why.
- **Checked**: Go tests under `-race`, the linter; web typecheck, lint,
  format and 397 tests. 30 mutations, 15 in the server (validation, the
  answers' check, exits, the entry, no case holding, previews) and 15 in
  the editor (handles, edits moving and taking lines, the run's marks,
  the tabs, + Case, a taken status), each caught but the equivalent one.
  Chromium through nginx, light and dark: a transform with cases (its
  exits, its tabs, what each says over the samples), a run that took
  missing (marked, its line to the 404 answer taken, "It gave 404"), a run
  in which no case held (Unhandled marked, answered 422, "no case holds"),
  renaming a case and adding one with + Case. No CSP violations and no
  console problems.

## A transform merging, as built

Part 1 of "a step and a transform", built on 2026-11-01 after the Merge was
committed (4c8ef26). Decided while building:
- **A transform with a line into it joins as the Merge did**, in the
  engine, its routes and its previews; one with none still runs first. It
  records the lines it came by, `ways`, one or several. An http node keeps
  needing every line, so never-runs is a problem of a step that isn't a
  transform, or of one whose kind is gone; its words end "It runs only
  when every line into it is taken; to run it after whichever comes, join
  them to a transform first".
- **Tests**: the ones that showed a step never running used a transform
  with two lines, and use an http step now. The transform cases joined the
  merge tests, your Fixes check's shape among them: success_200 by crm or
  test_400, and bad_400, by crm's 400, kept apart.
- **The way picker** lists the lines into the transform as the canvas
  names them. A way picked is kept by its ends, so it stays as lines come
  and go; the preview request names it by its place in the draft
  previewed. It drives the expression's preview, or the cases'; the
  Unhandled body's stays the run in which each step answers 2xx.
- **It came by** shows only with more than one line in, and so does the
  connection panel's "a transform, runs if any of its ways is taken".
- **The words**: an answer's refusal, Then and the overlap problem said to
  "merge them into one step"; they say to join both to a transform now,
  the overlap problem "to one transform, which picks the answer".
- **Divergence**: revisions saved with a merge node, your Fixes check's 32
  and 33 and the pw-merge test workflows, name a kind the server no longer
  knows. Your Fixes check is revision 34, its merge_200 a transform.
- **Checked**: Go tests under `-race`, web typecheck, lint and tests
  (see the wrap-up for `just check`). 25 mutations, 17 in the server
  (joins, routes, the engine's join, ways, previews by way, the API) and
  8 in the editor, each caught, three only after a test was added: a way
  told from another out of the same step, a lone line's connection text,
  and a kind the editor doesn't know. Chromium through nginx, light and
  dark: no Merge to add; a transform's lines dashed, a lone one solid; its
  preview by its first way, then by test_400, prefs answering 400 with its
  sample; no picker on a transform with one line; a run in which count
  failed into Unhandled (that line solid, the other dashed, "It came by
  count · Unhandled.", none on report); your Fixes check, no problems, its
  merge_200 reading test_400's sample, {"node": "test4000"}, its picker
  offering test_400 · 2xx, crm · 2xx and crm · 500; a workflow saved with
  a merge, naming its kind as unknown. No CSP violations and no console
  problems.

## Merge, as built

Reworked from the Either on 2026-11-01, after it was committed (4877f7a),
and folded into transform the same day (above); kept as it was built.
Decided while building:
- **A merge is a transform that joins differently.** It compiles its expr
  and runs it as a transform's, over every finished step before it; only
  its join differs: once every edge into it has ended, it runs if any was
  taken. The engine passes it the edges taken, and a run records them as
  `ways`, in the definition's order, on its node's run and on the event
  that ends it (`node_runs.way` renamed `ways`, a list, in migration
  20261101130000, which turns what the Either recorded into lists).
- **Gone with the Either**: `body` on an edge and its checks; the problem
  for two ways one run could both bring, and the run failing when they do;
  each way reading what its line's condition read; a line into it
  previewing a value. A merge joined to several answers picks one as a
  transform does without a switch: its expr gives `{status, body}`.
- **Kept from the Either**: its route, merging its ways' with notRun; a
  merge no line comes into is a problem; its card, a block per way with its
  point and + Add, its ways dashed until a run says; adding a way from the
  panel, now Add a way from, under the list of its ways, each of which
  opens its line.
- **Its panel**: how it went in the run shown, with the ways it came by;
  its ways and Add a way from; its expression, with what it reads and gives
  over the samples, as a transform's; then what follows it, and its
  Unhandled. No tabs: one value, one expression.
- **The words**: "Merge step"; its card's second line says "Merge", or how
  it went in a run; a never-runs problem ends "to run it after whichever
  comes, join them to a Merge step first".
- **Divergence**: revisions saved with an either node, your Fixes check's
  30 and 31 and the pw-either test workflows, now name a kind the server
  doesn't know. Your Fixes check gets a revision with a merge instead.
- **The words, after the browser**: the connection panel said a merge
  "runs once any of its ways is taken", which reads as the first; it, the
  problem for a merge with no line in, the schema and the comments now say
  it runs if any is, once all have ended.
- **Checked**: `just check` with everything staged: Go tests under
  `-race` with the coverage floors (runner 92.2%, engine 96.3%, workflow
  97.2%); web format, lint, typecheck, 396 tests and build. 23 Go mutations in
  validation, routes, the engine, previews, the runner and the API, each
  caught. Chromium through nginx (`just up`, migration applied: the two
  ways the Either recorded became lists), light and dark: a workflow with
  a Merge (its card, its ways dashed and the line on solid, its panel's
  ways, its expression previewed over the samples, Add a way from by
  pointer and keyboard drawing a new way, a way opening its line); a run
  in which a step failed into Unhandled (that way marked and solid, the
  other dashed, "It came by count · Unhandled." and what it gave); your
  Fixes check at revision 32, no problems; a workflow saved with an
  Either, naming its kind as unknown and saying its step can never run.
  No CSP violations and no console problems.

## Either, as built

Built on 2026-11-01, after strict joins were committed (e898238), and
reworked into the Merge above the same day; kept as it was built. Decided
while building:
- **An Either is the engine's third kind.** It joins once every edge into
  it has ended, as any node does, and runs if one was taken. The scheduler
  passes it the edges taken: one, and it evaluates that edge's body over
  what the edge's condition read, the reads of the node it came from and
  that node, kept for each node as it starts; two, and it fails, "two ways
  came: from b and from c". With no body, it gives the body in its
  source's part of the data document, null when that has none, as a
  transform that failed into Unhandled has.
- **A way's body failing fails the Either**, "the way from b: body: …", a
  workflow error its Unhandled block can take, as any node's failure.
- **A run records the way** as the definition writes the edge, `{from, on,
  unhandled}`, in `node_runs.way` (migration 20261101120000) and on the
  event that ends the Either. The canvas marks the block it names, and a
  line into an Either is taken exactly when it's that way, not guessed.
- **Its route merges its ways'**: a node every way needs keeps the outputs
  any allows; a way that rules a node out allows it notRun, a value beside
  its outputs; a way that does neither drops the node. A way whose node
  never runs is left out, and an Either with none never runs. The never-
  runs words say notRun as skipped: "d can never run: it needs t to answer
  500, and to answer 2xx or be skipped".
- **A condition before a way leaves it to the run**: a node is conditioned
  when an edge into it has a condition, or a node before it is.
- **Previews mirror runs**: an Either reads what its way read; previewing
  one, or a step after one, takes the way previews take, 2xx first, the
  first in the definition's order that the preview took; a line into an
  Either gives what the Either would, its body failing named at the edge.
- **Its card** has a block per way on its left, each with its point,
  covering the block (`block-point`, the response card's `answer-point`
  renamed), named `way:<from>:<output>` so its point and its tab stay as
  other ways come and go; then + Add; then its id and "Either", or how it
  went in the run shown; its value leaves from one point on its right.
- **Its panel** is a tab per way, its value with what it reads and gives
  over the samples, from the line's preview; + Way, a list of the
  responses that could join it, so a way is added without dragging (WCAG
  2.5.7); and Unhandled. What follows it is below the tabs. A line's own
  panel says it's a way, and opens its value. A problem with a way's value
  opens that tab from the problem list.
- **Strict joins' leftovers fixed** (outright bugs): the editor still said
  the old rule in four places, the preview's skipped note, a run's
  skipped note, and a connection's description and "Not taken" note; and
  so did the schema's Definition and Preview.skipped descriptions.
- **Divergences**: a revision saved with an output now moves it into a
  `respond` joined to the 2xx of each step it reads, as a step needs every
  line into it; an output that read a step answering another status gives
  no answer there. Only a revision saved between outputs by status and the
  response, one day, has both. A way's label can be cut short on its card,
  "count · Unh…" beside the mark of the way that came; its tab says it in
  full.
- **Seen, not fixed**: `mentions`, which names what still reads a renamed
  step, reads a way's body now, but still not a step's Unhandled body or
  a switch's cases. `TestGuardrails` still fails without `-race` (strict
  joins, above).
- **Checked**: Go tests under `-race` with the coverage floors (runner
  92.1%, engine 96.1%, workflow 97.4%); web format, lint, typecheck, 403
  tests and build. 32 Go mutations in validation, routes, the engine,
  previews, the runner, the API and the every-line rule: 30 caught, six of
  them only after a test was added; 2 named a check no route could reach,
  now deleted. Chromium
  through nginx, light and dark: a workflow with an Either (its card, its
  ways dashed and the line on solid, a way's tab and preview, + Way), a
  run in which a step failed into Unhandled (that way marked and solid, the
  other dashed as not taken, "It came by count · Unhandled"), and your
  Fixes check opened, nothing saved: "success_200 can never run: it needs
  crm to answer 2xx and 500". No CSP violations and no console problems.

## Out of scope

- **Page mode** (05). The editor's model stays the definition, so 05 adds a
  second view of it.
- **What a step hands on, and what comes in with its shape** (raised
  2026-10-28): an optional mapping for what a step gives the steps after it,
  and the panel and cards showing its parents' results as they arrive. For
  page mode (05) or typed contracts (07); not decided. A mapping on a
  connection was raised and declined on 2026-10-30 (Outputs, decided with
  you).
- **Credentials** (06). Until then a secret header is typed into the node
  and stored in the definition, as the API stores it today.
- **Rewriting references** when a node is renamed.
- **Problems for expressions that name a node that isn't upstream**, such
  as `nodes.orderz.body`. Validation reports unknown nodes only on edges
  (`server/internal/workflow/validate.go:251`); in an expression, the name
  passes save and fails at run time as "no value". Catching it needs the
  JSONata syntax tree. Plan 08's seams count "unknown node references" as
  already caught, which is only true for edges. Candidate for 07, with
  typed mappings.
- **Undo and redo.**
- **Hiding React Flow's attribution.** The MIT licence allows it, and
  xyflow asks those who hide it to subscribe to React Flow Pro
  (https://reactflow.dev/learn/troubleshooting/remove-attribution); it
  stays.
- **Deleting workflows.** The API has no delete yet.
- **Dry-run and test cases** (07), **AI authoring** (08).
- **A code editor for expressions**: plan 10 (answer 3), which now comes
  before 08. Each expression field is a plain textarea whose component says
  plan 10 replaces it.

## Open questions

1. **Where does the browser keep the token?**
   - a) sessionStorage: kept until the tab closes. Any script on the page
     can read it, as with localStorage; the CSP (`script-src 'self'`)
     makes that harder.
   - b) localStorage: survives restarts, with the same exposure.
   - c) memory only: sign in again on every reload.
   - d) an HttpOnly cookie: the server swaps the token for a session cookie
     that scripts can't read. OWASP's HTML5 cheat sheet: "Do not store
     session identifiers in local storage as the data is always accessible
     by JavaScript. Cookies can mitigate this risk using the httpOnly flag"
     (https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html).
     It needs a session endpoint and CSRF protection, and plan 03's answer
     5 said no cookies.

   **Recommended: d.** It's what OWASP advises, and the browser code never
   touches the token. The cost is on the server: a sign-in endpoint that
   sets a signed, expiring, `HttpOnly`, `Secure`, `SameSite=Strict` cookie,
   middleware that accepts it besides the bearer token, and an `Origin`
   check on writes. Scripts, agents and served callers keep the bearer
   token. If you'd rather keep 04 small, a is the fallback.
2. **The upstream library: here, or in 07?** The milestone moved it here
   from 03. 07 imports upstreams from OpenAPI documents, which is when a
   library fills up; built here it's a hand-kept list. Done doesn't need
   it either way.

   **Recommended: 07**, with the import. D14 stays proposed until then.
3. **Expression fields: a textarea or a code editor?** A textarea needs no
   dependency, with the server's preview and validation behind it. A code
   editor adds highlighting and, later, completion of `nodes.<id>.body`
   paths, for a bundle cost (in Dependencies).

   **Recommended: a textarea.** With no maintained JSONata mode, a code
   editor would highlight the JSON fields only, for about 96 kB gzip.
4. **Where does a preview's document come from?** Preview answers "what
   would this expression give, with real data?". The expression
   `{ 'email': nodes.user.body.email }` reads the `user` node's response,
   so the server needs that response to evaluate it. The workflow's last
   run stored every node's response, so the data is there:

   ```json
   { "input": { "user_id": "7" },
     "nodes": { "user": { "status": 200, "body": { "id": "7", "email": "ada@example.com" } } } }
   ```

   Evaluated over that, the preview shows `{ "email": "ada@example.com" }`.
   The question is who puts that document together:
   - a) The browser. It already has the last run, to show its results, so
     it builds the document from it, with only the nodes that run before
     the one being edited, and sends it with the expression. The server just
     evaluates. The same endpoint also takes sample data typed by hand, so
     a preview works before anything has run.
   - b) The server. The browser sends the expression, the run's id and the
     node's id; the server loads the run, picks the nodes that ran before
     it, builds the document and evaluates. The "which nodes come before"
     logic lives only on the server, but a preview needs a run first.

   Either way, stored responses have secrets redacted and bodies capped at
   256 KiB, so a preview can differ from a run on exactly those.

   **Recommended: a.** The endpoint stays one call into `transform`, and
   previews work on typed-in data too.
5. **The browser test: in `just check`, or a separate gate?** In `just
   check`, CI and local stay one command (repo.md), but `just setup`
   downloads a browser and every check runs the flow. Separate, it's a
   second CI job and something to remember locally.

   **Recommended: in `just check`**, with only the headless shell (about
   100 MiB here). A gate that's easy to skip gets skipped.
6. **Problems as you type, or on save?** On save only is simplest. As you
   type, the editor posts the draft to `POST /v1/validate` a moment after
   each change, and problems show before saving.

   **Recommended: as you type.** The endpoint exists, a check is one
   compile on the server, and seeing a mistake as you make it is the point
   of an editor.
7. **Toasts: sonner, or shadcn's Toast?** web.md and the milestone say
   sonner. With Base UI as the primitives, shadcn's own docs send its
   Sonner page to its Toast component, which is built on Base UI and adds
   no dependency. sonner would add sonner and next-themes, and has had one
   release in the last twelve months.

   **Recommended: shadcn's Toast**, one fewer library. web.md changes to
   match.
8. **Safari over plain http** (raised in Phase A). WebKit drops the
   session cookie on `http://127.0.0.1` and `http://localhost` alike, so in
   Safari neither `just dev` nor `just up` gets past sign-in. Production
   sits behind a proxy that ends TLS (03, 06), where Safari works.
   - a) Leave it: develop in Chrome or Firefox; Safari works once the app
     is served over https. No change.
   - b) https locally too: a local certificate for Vite and nginx (mkcert,
     or Vite's basic-ssl plugin and a warning to click through). Safari
     works everywhere, for a dependency and a setup step.
   - c) A setting that drops `Secure` for plain http, like Django's
     `SESSION_COOKIE_SECURE`, which defaults to off. Without `Secure` the
     cookie loses its `__Host-` name, and production can be set wrong.

   **Recommended: a.** Two of the three engines work locally, production
   already has TLS, and the cookie stays as strict as designed. b if you
   develop in Safari.

## Answers (2026-10-28)

| # | Question | Answer |
|---|---|---|
| 1 | Where the browser keeps the token | **d, an `HttpOnly` session cookie**: signed, expiring, `Secure`, `SameSite=Strict`, set by a sign-in endpoint; an `Origin` check on writes; the bearer token stays for scripts, agents and served callers. This revisits plan 03's answer 5 ("no cookies"), which was about the event stream; the stream works with the cookie too |
| 2 | The upstream library | **07**, with the OpenAPI import. D14 stays proposed until then |
| 3 | Expression fields | **plain textareas in 04**, with a Format button on the JSON fields (run input, schemas). Your own JSONata support (highlighting, completion, inline errors from the server, formatting in your style) becomes **plan 10**, after 04: a CodeMirror 6 language package in its own repo, published under your npm scope, starting from gnata-sqlite's MIT grammar (its notice kept), which is derived from the same parser the server uses. CodeMirror replaces the textareas when it lands |
| 4 | A preview's document | **a, the browser builds it**: from the last run, or from sample data typed by hand, sent with the expression; the server only evaluates. **Revised the same day**, when samples moved into the steps (phase D): the server simulates the steps before the expression over their samples, since that means evaluating transforms, and JSONata runs only on the server |
| 5 | The browser test | **in `just check`**, with only the headless shell |
| 6 | Problems as you type | **yes**, through `POST /v1/validate` a moment after each change |
| 7 | Toasts | **shadcn's Toast**, on Base UI; no sonner |
| 8 | Safari over plain http | **a, leave it**: develop in Chrome or Firefox; Safari works over https. CLAUDE.md says so |

Reading for answer 1:
- OWASP Session Management Cheat Sheet: cookie attributes, expiry,
  https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- OWASP HTML5 Security Cheat Sheet, Local Storage: why not web storage,
  https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html
- OWASP CSRF Prevention Cheat Sheet: SameSite, and checking `Origin`,
  https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- MDN, Using HTTP cookies, and the `Set-Cookie` reference:
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies,
  https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie
- web.dev, SameSite cookies explained:
  https://web.dev/articles/samesite-cookies-explained
- RFC 6265, the cookie standard, and its successor draft, 6265bis, which
  adds `SameSite`: https://www.rfc-editor.org/rfc/rfc6265,
  https://datatracker.ietf.org/doc/draft-ietf-httpbis-rfc6265bis/
- Go: `http.Cookie` and `crypto/hmac`, for setting and signing it:
  https://pkg.go.dev/net/http#Cookie, https://pkg.go.dev/crypto/hmac

## Decided while drafting, without a question

Listed so each can be overruled:
- **Versions:** the newest in each major that's at least five days old,
  stricter than pnpm's one day, and checked again when added.
- **shadcn on Base UI**, its default since July 2026 (Radix is one flag
  away).
- **dagre for layout**, not elkjs: 16 kB against 436 kB gzip, React Flow's
  own advice, and elkjs's licence change.
- **eventsource-parser** for the stream format, rather than our own parser;
  reconnecting stays ours.
- **zustand 5**, falling back to 4.5 if React Flow 12's copy clashes.
- **shadcn and tw-animate-css as devDependencies**, against what init
  writes; **@shadcn/lint's token rules off for `components/ui`**.
- **React Flow's attribution stays.**
- **An explicit save**, no autosave.
- **A position for an unknown node in `ui` is ignored**, not reported.
- **Renaming a node warns by a text match**; references aren't rewritten.
- **Running saves unsaved changes first.**
- **Out of scope:** undo and redo, deleting workflows, rewriting references,
  problems for expressions that name a missing node.
- **Playwright** with only the headless shell; the Go server starts before
  Vite.
- **No @microsoft/fetch-event-source**: unpublished since 2021.
- **The stream stays on `fetch()`**, though the session cookie would let
  `EventSource` work: `EventSource` hides the status of a failed
  connection, and the stream's `503`s (the cap, a run just starting) need
  telling apart from a `404`. It would save eventsource-parser and the
  reconnect code.
- **The session cookie is stateless** (an expiry and its HMAC), keyed from
  the API token, rather than a sessions table.
- **The JSONata package is plan 10**, a new number after 09 rather than
  renumbering 05–09. It has since moved up to come before 08.
- **The release-age guard made strict**, as a change of its own.
