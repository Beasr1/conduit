# 04 — Graph editor

Status: accepted 2026-10-28, with all seven questions answered (Answers, at
the end); D10, D11 and D13 accepted with it, and D14 waits for 07. Phase A
is committed (69bb36e), and Phase B is in progress. Building Phase A
raised question 8, since answered.

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
  data. The open revision isn't refetched under the editor: revisions are
  immutable, so its query never goes stale.
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
  means another tab, or later an agent, saved first; the editor offers to
  load the newer revision.
- **Problems** come back with every save, each with a JSON Pointer. The
  editor maps a pointer to its node and field (`/nodes/2/request/url` is
  node 2's URL field), marks the node on the canvas, and shows the detail
  under the field. Question 6 asks whether to check as you type too.
  - The mapping is a pure function, tested on every pointer shape the
    validator produces.
  - A save's errors go to the fields, not to a toast as well. The save
    tells the global error toast to stay quiet (TanStack Query's `meta`),
    so one failure doesn't show twice.
- Publishing a revision with problems is refused by the server; the button
  says why.

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
- [ ] Nodes, edges, forms, the workflow's settings (input schema, output).
      So far the canvas draws the draft; nodes can be dragged, connected
      (a cycle refused as you drop it), deleted and added; and a picked
      step's settings open beside the canvas (http and transform). An
      edge's `when` and the workflow's settings are next. Plan 11's brief
      applies: text on screen says "step"; a step's name and the look wait
      for 11, and building from the keyboard for page mode (05).
- [ ] Save with `If-Match`, problems on fields, publish.

**Phase C: runs**
- [ ] `lib/events.ts` and its tests.
- [ ] Run with an input, live statuses, node inspection, the run history.

**Phase D: previews**
- [ ] Samples: an optional `sample` on http steps (`status`, `headers`,
      `body`) and a sample input on the definition, in
      `schema/workflow.yaml`. Real runs ignore them, as they ignore `ui`;
      each is capped in size.
- [ ] `POST /v1/preview` simulates: each http step's sample stands in for
      its response, the transforms before the step are evaluated over
      them, then the expression. The last run's real responses are the
      other source. Tests for each kind and the guardrails.
- [ ] Preview beside each expression field. An expression that reads
      nothing in the samples, or reads the wrong type, is marked under its
      field, using a JSON Schema the server infers from the samples.
- [ ] The step panel shows what comes in, from the samples. A finished
      step's response can be kept as its sample (after phase C).

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

**Phase E: the browser test**
- [ ] Playwright, the test upstream, and the Done flow.
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

## Phase B, as built (so far)

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
- **A step reads every earlier step by name** (2026-10-28), as the engine
  already does (`server/internal/engine/run.go:262`). Reading only what
  points into it would make the arrows carry the data, at the cost of long
  extra arrows; Step Functions moved the other way in 2024 (sources.md).

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
- Deliberate TODOs for plan 10's JSONata editor:
  `web/src/features/editor/components/http-step-form.tsx:122` and
  `web/src/features/editor/components/transform-step-form.tsx:33`.

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

## Out of scope

- **Page mode** (05). The editor's model stays the definition, so 05 adds a
  second view of it.
- **What a step hands on, and what comes in with its shape** (raised
  2026-10-28): an optional mapping for what a step gives the steps after it,
  and the panel and cards showing its parents' results as they arrive. For
  page mode (05) or typed contracts (07); not decided.
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
