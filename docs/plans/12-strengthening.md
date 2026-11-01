# 12. Strengthening: no loose ends

Accepted 2026-11-01, as drafted (your call, from wireframes). Built
2026-11-02, with plan 13's editor (as built, at the end).

## Goal

Every way a run can go ends in an answer the workflow chose, and every error
it answers has one shape. Today three things slip through:
- a block can be the end of the road. When prefs answers 404 and nothing is
  joined to its 404, a run that gets 404 gives no answer, and only the
  response's Unhandled saves it, at run time;
- a step's failure goes to the response's Unhandled when its Unhandled
  block isn't joined, whether or not anyone decided that;
- an error block joined straight to an answer sends the caller whatever the
  upstream sent, so a workflow's 404 and its 502 can have different shapes.

Webhooks and fire-and-forget, a workflow that answers before it's done or
not at all, come later, as a choice of their own.

## Decided with you on 2026-11-01, from wireframes

- **No loose ends: where no answer follows.** A block is marked when every
  run that takes it gives no answer. A step whose result nobody needs, an
  audit call say, isn't marked while the run still answers. Saving works;
  Publish waits until each is fixed. "Every point leads somewhere" was the
  other option, and so was listing them on the card instead of the blocks.
- **Every failure mapped: joined, or failing on purpose.** A step's
  Unhandled is joined to a step or an answer, or set to fail the run, and
  then the response's Unhandled answers. Undecided is a problem. "Always
  joined" and "drawn, not required" were the others.
- **One error body, on the card.** Written once, on the response card;
  unwritten, it's problem details (RFC 9457). It answers an error block
  joined straight to an answer, a step's Unhandled joined straight to one,
  and the response's Unhandled. A transform you wrote keeps its own body.
  Problem details with nothing to write, and the error body for every error
  answer, transforms included, were the others.
- **The upstream library stays plan 07's**, after this.
- **Bodies matching the card's schemas: not now.** A schema stays checked
  when saved and unenforced on runs.

## Decided with you on 2026-11-02, on your Fixes check

- **One exit, failures included**: no "Fail the run" exits in between.
  First built as a step of its own, joined to every answer, with a
  collecting transform before it; then, the same day, the response picks
  instead (plan 14): every step's failures join one answer, listed first,
  and a run gives the first answer reached, top to bottom. Either way a
  failure doesn't stop the branches that don't need the failed step: they
  run to the end before the answer is picked.

## How it works

**Publish waits; runs don't.** These checks stop Publish, not runs. A run
compiles its revision and refuses one with problems
(`runner.prepare`), so the same checks there would stop every published
workflow that breaks them from answering, the day this ships. They live
apart from validation (`workflow.Validate` stays what a run needs) and are
listed with the problems a save, a check and Publish report. You can still
run a draft that has them, to see what it does.

**A block no answer follows** (`no_answer`): the outputs of a step that may
run, each checked: an http step's 2xx and each status it lists, a
transform's value or each case, and its Unhandled when that's joined. Each
gets the route a run takes to it, what earlier steps must have answered
for it, and each answer gets the same for its own line. When the block's
route clashes with every answer's, no run that takes it can answer: "a run
that gets 404 here gives no answer, as crm needs prefs' 2xx". The route
analysis is validation's (`needs`, `clash`), so a condition on a line,
which depends on data, counts as maybe, and only a block that can't answer
in any run is marked.

**A step's failures** (`unhandled_undecided`): a step whose Unhandled is
neither joined, by a line or an answer, nor set to fail the run. "Fail the
run" is `unhandled: {fail: true}` on the step, and runs do as today: the
response's Unhandled answers, by cause.

**One error body** (`response.errors`): the response's Unhandled body
becomes the workflow's error body, used three ways. A run that gives no
answer, as now. An answer whose line leaves an http step's error block, a
status of 400 or more it lists: the body, over the run, with `error`
`{code, detail, node, status, headers, body}`, what the upstream sent among
them. And an answer joined to a step's Unhandled with no body of its own.
Unwritten, each is Conduit's problem details, as a run that gives no
answer gets today, `application/problem+json`, with the run as `instance`.

## Decided while drafting, yours to overrule

1. **The checks stop Publish only**, for the reason above. Problems that
   stop runs as well was the alternative, and it would stop serving
   published workflows that break the new rules.
2. **A workflow with no answers at all is one problem, on the card**
   (`no_answers`), not one on every block.
3. **`response.unhandled` is renamed `response.errors`**, as it's now the
   body of every error, not only the Unhandled's. A migration rewrites the
   saved definitions, as old revisions must still decode. The card keeps an
   Unhandled strip, for when it answers; Error body is the new field.
4. **A body you wrote answers as written**: a transform's, and a step's own
   Unhandled body. Only a body passed straight through takes the error
   body.
5. **"Fail the run" and a line from Unhandled can't both be set**: choosing
   one in the editor clears the other, and both set through the API is a
   problem, `unhandled_both`.
6. **The error block's `code` is `upstream_failed`**, the code a failure
   gets when an upstream answers an error status: "prefs answered 404".

## Steps

- [x] Server: `workflow.ReadyToPublish(d)`, the three checks, beside
      `Validate`, with failing tests first: a dangling 404; the same 404
      while another branch still answers; an http step after a branch;
      a required line; a case; an Unhandled joined onward; no answers.
- [x] Schema: `unhandled.fail` on a node; `response.errors`, replacing
      `response.unhandled`; the problem codes. `just gen`.
- [x] A migration rewriting saved definitions' `response.unhandled` to
      `response.errors`.
- [x] Engine: an answer from an error block, or from an Unhandled with no
      body of its own, answers the error body, else problem details.
- [x] Runner and API: a save and a check list the new problems; Publish
      refuses them (422); a served error answer without an error body goes
      out as problem details.
- [x] Editor: the words for each problem, on its block; Fail the run on a
      step's Unhandled tab and strip; Error body on the response card's
      panel, where Unhandled's body was.
- [x] The browser test: its spec example decides each step's Unhandled
      before it publishes.
- [x] Mutation checks; Chromium through nginx, light and dark.
- [x] Docs: plan 04's semantics where they changed, web.md, sources.md if a
      source backs a choice, CLAUDE.md.

## As built

**The checks** (`server/internal/workflow/publish.go`). `ReadyToPublish`
runs beside `Validate`, and `problemsOf` in httpapi lists what both find
for a save, a check and Publish; `engine.Compile` runs `Validate` alone,
so a revision published before this still answers. It reuses validation's
routes (`needs`, `with`, `apart`) and skips a step that never runs, which
has a problem of its own (`never_runs`).
- `no_answer` is reported where a road ends, at a block with no line
  onward, so one dangling branch is one problem rather than one per block
  along it. A block an answer is joined to answers through it. An answer
  joined to a step that never runs answers no run.
- Where it points: a status a step lists, `/nodes/i/outputs/k`; a case,
  `/nodes/i/switch/cases/k`; a transform's value, `/nodes/i/expr`; an http
  step's 2xx, which has no place of its own, the step, `/nodes/i`. The
  editor puts that one on the 2xx block (`placeOfProblem`).
- `unhandled_undecided` points at `/nodes/i/unhandled`, and
  `unhandled_both` at `/nodes/i/unhandled/fail`. An Unhandled block is
  among a step's outputs only once a line or an answer leaves it, so the
  loose-end check never meets an undecided one.
- `no_answers`, a workflow with no response, points at
  `/response/answers`. A revision saved with an output has none of these.
- `unhandled.body` is optional now, as `fail` can stand alone; a body
  that's only whitespace is still `required`.

**The migration** (`20261101160000_response_errors.sql`) moves
`response.unhandled` to `response.errors` in every saved revision's
definition, and back on Down. Tried on a copy first; none of the 42 local
revisions used the old field.

**Error answers.** The engine names the step whose error an answer passes
on (`Result.ErrorFrom`): an answer joined to an http step's block of 400
or more, or to an Unhandled with no body of its own. Under 400, a block
answers with what the step got, as 2xx does. `engine.ErrorOf` makes the
error the body reads, `{code, detail, node}`, with the upstream's
`status`, `headers` and `body` when it answered; `Program.ErrorBody`, which
was `Unhandled`, evaluates the body. The runner's `passOn` answers with
the body, or, with none or with one that fails, sets `Outcome.Problem`:
`upstream_failed`, "user answered 404", or the code and detail of the
failure the Unhandled took, with "; the error body failed too: …" when it
did. The API sends that as problem details at the answer's status, with
the run as `instance`.

**Tests.** The publish checks: twelve loose-end cases, failures, a cycle.
The engine: `ErrorFrom` for each way, the error `ErrorOf` makes, with an
answer and without, and a 399 that passes its body beside a 400 that
passes its error. The runner: five error answers, and an
error body failing both when a run fails and when an answer passes an
error on. The API: an error block answering problem details, and Publish
waiting for what a run doesn't.

**Mutation checks**, 38 on the server. Three survived at first, and each
got a test: an answer from a step that never runs, the 400 boundary, and
an error body failing on an error passed on. Two more were checks nothing
could observe, an answer joined to the block and a skip of Unhandled
blocks, both covered by the answers' check, so they went. One can't be
told apart: without `ErrorBody`'s nil check, evaluating a nil body panics,
and its recover answers `ok` false, as the check does. It stays, as the
reason to read.

**The editor and the browser** are plan 13's, as built: Fail the run,
Error body, the problems' words. The browser test decides each step's
Unhandled before it publishes.
