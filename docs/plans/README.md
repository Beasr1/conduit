# Plans

Numbered plans, one file each. A file is written when its milestone starts,
or earlier if it shapes v1's design (08 does). Until then the milestone
lives as a row in 00-roadmap.md.

| # | Plan | Goal | Status |
|---|---|---|---|
| 00 | 00-roadmap.md | scope, architecture, execution semantics, decisions, milestones | proposed; D1, D17 open |
| 01 | 01-foundation.md | monorepo skeleton; every gate runs locally and in CI | done |
| 02 | 02-engine.md | workflow model, validation, scheduler, upstream caller, JSONata | done |
| 03 | 03-api.md | persistence, REST, live run events, serving published workflows | done 2026-10-27 |
| 04 | 04-graph-editor.md | build, save and run workflows in graph mode | accepted 2026-10-28; phases A, B and C committed, with D's samples, previews, outputs by status and a step's blocks; D's answers (a line per answer, cases and Unhandled), a step's Unhandled and strict joins and an Either committed, the Either reworked into Merge, then folded into transform, which merges its lines, and a transform's cases made its exits; then its lines its parameters, required or not, previewed by each way; then conditional steps told in an Input, the lines a run took, and E, the browser test, in `just check`: **done** (2026-11-01) |
| 05 | page-mode | the advanced view: steps in order, a card each with its data in and out; keyboard-first | not started; first, the editor at phone width, put off until then (2026-11-03): an open step panel makes the page 42px wider than a 390px screen |
| 06 | 06-hardening.md | credentials, limits, images, observability; loops first: a hop count in W3C trace context, refused at 8 with 508, and a quarter of the server per workflow | loops accepted and built 2026-11-02; constants, its credentials widened, accepted and built 2026-11-04: named values every expression reads as `$const.name`, sealed at rest, secret ones masked in what runs keep and answer; the rest not started |
| 07 | 07-tests-and-catalogue.md | dry-run; test cases: unit tests of a step and API tests, mocked or live, gating Publish; the upstream library, filled by OpenAPI import; per-workflow caller keys | upstreams built by 2026-11-03: the library, steps that use it, the editor, every new step using one, published workflows as steps, and deleting an upstream no saved revision pins; and F, a step showing only what it owns and opening its upstream in a new tab (2026-11-04); caller keys, one per caller of a workflow, rotated with an expiry or revoked, built 2026-11-05; tests: direction (2026-10-30), shapes v1 seams, after 04's runs; the rest not started |
| 08 | 08-ai-authoring.md | spec in, draft workflow out; people review and publish | direction; shapes v1 seams; comes last of all |
| 09 | later | Redis cache, cron triggers, durable runs, loops; other step types (database, queue, script, SOAP/XML, gRPC) | parked |
| 10 | jsonata-editing | a JSONata language package for CodeMirror 6, then the editor uses it; comes after 04 and before 08 | not started |
| 11 | 11-visual-design.md | the look: calm, precise and simple, with the emphasis on the canvas and the data | brief taken 2026-10-28; starts when 04 is done, before 05 and 10 |
| 12 | 12-strengthening.md | no loose ends: every way a run goes reaches an answer, every step's failures go where someone chose, one shape for errors | accepted 2026-11-01; built with 13's editor, the browser test deciding each step's failures before Publish: **done** (2026-11-02) |
| 13 | 13-minimal-editor.md | the editor says only what a field is: two rows of tabs on a step, bare lines and card, a short tour and one-line hints | accepted 2026-11-01; built with 12's editor parts, its panels from 110–436 words down to 14–82, the tour checked in Chromium: **done** (2026-11-02) |
| 14 | 14-the-response-picks.md | one exit, with nothing to add: an answer takes lines from any number of steps, and a run gives the first, top to bottom, that one reached | accepted and built 2026-11-02 |
| 15 | 15-archive.md | nothing deleted: a workflow, an upstream or a constant nothing live uses is archived, read-only, and restored | accepted 2026-11-06, **built** 2026-11-07 |

## Queue (your order, 2026-11-05)

Picked, each planned in its own plan when it starts:

1. Caller keys, with rotation: built 2026-11-05 (07).
2. Archive instead of delete, for everything: workflows, upstreams and
   constants are archived, never deleted, for audit: built 2026-11-07 (15).
3. A changes list on each workflow, newest first, kept for audit: a
   constant it reads changed, a key's old value expiring, a newer version
   of an upstream it uses (your item 4, in place of moving every workflow
   at once: a workflow says what's newer, and Used by takes you there).
   What's still to come, or waits on you, is active; what has happened
   leaves the active list, once done or dealt with, and stays in the
   workflow's history, never deleted (your note, 2026-11-05).
4. Fields marked to be masked in run records, so a person's details aren't
   kept in plain text: a mask type per field, all of it, or most of it
   with the start kept for debugging, `784**********`.
5. Basic tests that config engineers and QA can add (07's tests, the
   simplest kind first).
6. The JSONata editor (10).

Later, by your call: OpenAPI import with an API's documentation (07);
samples, from documentation, specs, AI authoring or calling the API, as
one enhancement; visual design (11); the editor at phone width and page
mode (05); AI authoring (08). And from 06: rotating the constants key,
which only the server holds, so it's switched at once, re-encrypting every
value; a distroless image; traces on runs. And from 07's caller keys: a
checksum in each key, so a secret scanner can turn away a look-alike
without asking the server, and extending a rotated key's expiry once it's
set. And from 15: destroying an archived secret's value for good, keeping
its record.
