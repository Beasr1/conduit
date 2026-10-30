# 04 — Graph editor

Status: accepted 2026-10-28, with all seven questions answered (Answers, at
the end); D10, D11 and D13 accepted with it, and D14 waits for 07. Phase A
is committed (69bb36e), and so is Phase B, its last step in eabb7b6. Phase D
now comes before C: its samples, previews, outputs by status and a step's
blocks are committed (f9e7484, e98e50a, 2026-10-30), and its API's answers
are planned for after C. Phase C, runs, is built, not yet committed
(2026-10-30). Building Phase A raised question 8, since answered.

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
| The flow | Done, above | Playwright against `just dev`'s pieces: Postgres, the server, the built web app, and a small test upstream. The server runs with `CONDUIT_ALLOW_PRIVATE_NETWORKS=true`, so it can reach the test upstream on loopback |

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

**Phase B: the editor** (in progress)
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
- [ ] After C: preview beside each expression field; an expression that
      reads nothing in the samples, or the wrong type, marked under its
      field (the inferred schema below); a run's real response kept as a
      step's sample; fetching a sample from a GET.

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
      web.md, and Phase D, as built.

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

**Phase C: runs** (after D; detailed 2026-10-30, late night, from wireframes; built, not yet committed)
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
   lines: a TODO, at `web/src/features/editor/runs.ts:96`.
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

**Phase D: the API's answers** (2026-10-30, your call; after C)

The response card is the overview of everything the workflow's API can
answer, and each answer is one status with one shape. Today the API
answers 200 with one output, whose shape changes with the way the run
went: through user's 2xx it answers `200 {"id", "email"}`, through its
404 `200 {}`, an unclear contract (your point). Its errors are written
only in the API's schema.
- [ ] An answer is a status, joined to by one step's line. That step makes
      its body, a transform's value or an HTTP step's response body, and
      its exact shape is edited there. A run that takes the line gives the
      answer. Each answer keeps a schema, the shape a caller is promised.
- [ ] One line per answer. Branches that should give the same answer meet
      in a merger step first, a transform that reads whichever ran, so the
      answer has one shape. Drawing a second line into an answer offers to
      put a merger in front of it.
- [ ] Today's output moves into a step: the card holds no JSONata. A
      workflow's `output` becomes a transform step joined to 200, and its
      output schema becomes 200's; saved workflows are converted the same
      way.
- [ ] Validation: an answer's status is listed once, it takes one line,
      and a line into the card names an answer the workflow has.
- [ ] The canvas: the card's answers are blocks on its left, where lines
      arrive: 200 first, then each one added, then `+ Add`. Below them,
      "also 400 · 502 · 504", the answers Conduit gives on its own.
- [ ] The panel, the overview: each answer, the step that makes its body
      (a click opens it), that body previewed over the samples of every
      way into it, so a shape that changes with the branch shows, and its
      schema; then Conduit's own answers, each saying when it's given and
      the body a caller gets.
- [ ] A served run answers with its answer's status and body.
- [ ] Failing tests first; Chromium through nginx.

Decided with you on 2026-10-30 (late night), from wireframes:
- **The card shows every answer: yours, and Conduit's own.** Listing only
  what it answers today was one other option, but every success would stay
  200, so a user that isn't found couldn't answer 404. Only your answers,
  with Conduit's in the docs, was the last.
- **One status, one shape**, so a caller reads the card as an API's
  reference: what each status means, and what comes with it.
- **Lines into the card pick the answer.** A condition per answer was the
  other way: the same contract, but the canvas wouldn't show which branch
  gives which answer.
- **The card is an overview; the step joined to an answer makes its
  body.** The first draft gave each answer a JSONata body on the card; you
  put the exact response at the step instead.
- **Today's output moves into a step**, so every answer is made the same
  way. Keeping it on the card for a plain 200 was the other option: no
  extra step, but two ways to make a 200.
- **One line per answer, with a merger for several branches.** Several
  lines into one answer with a warning was the other option.
- **Built after runs.**

Decided while drafting, yours to overrule:
1. **The card's order decides between answers**: when a run takes lines
   into several, the first on the card wins. n8n answers with the first
   Respond to Webhook node to run and ignores a later one (sources.md), but
   steps here run in parallel, so which comes first isn't fixed; the card's
   order is.
2. **The answer is given when the run ends**, its steps all finished, as a
   served run answers now. n8n and Logic Apps can answer midway, and go on
   running.
3. **An answer's schema stays on the card**: it's the contract a caller is
   promised, while the body is the step's.
4. **The editor tells; the person configuring merges** (your question,
   2026-10-30). Most answers have one line in and need no merger. For a
   merger's lines, the editor says from the graph whether they can come
   together in one run: never, when they rest on different responses of
   one step before them (user's 2xx, and create_user reached only through
   its 404); maybe, through parallel branches or a condition it can't
   judge. It offers a start to the merger's JSONata, whichever ran or both
   side by side, and the answer's preview shows every way in. Merging by
   itself, such as a deep merge of objects, would pick the shape for you:
   the unclear contract this avoids.

Open: what the API answers when a run takes no line into the card (Logic
Apps answers 502, "even if the workflow finishes successfully"; 200 with
null is the other way); headers per answer; whether an answer may take a
status Conduit gives on its own (400, 502, 504); whether a step's failure
can lead to an answer (the "failed" output left open with outputs); the
names in the definition, settled when it's built.

**Phase E: the browser test**
- [ ] Playwright, against the test upstream (built in C), and the Done flow.
- [ ] web.md corrected; CLAUDE.md, repo.md and the roadmap updated.

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
  - `web/src/features/editor/components/mapping-field.tsx:110`
- Deliberate TODO for exact taken lines in a run (Phase C, decided while
  drafting, 2):
  - `web/src/features/editor/runs.ts:96`

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

## Phase D, as built (so far)

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
