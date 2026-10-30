# Plans

Numbered plans, one file each. A file is written when its milestone starts,
or earlier if it shapes v1's design (08 does). Until then the milestone
lives as a row in 00-roadmap.md.

| # | Plan | Goal | Status |
|---|---|---|---|
| 00 | 00-roadmap.md | scope, architecture, execution semantics, decisions, milestones | proposed; D1, D14, D17 open |
| 01 | 01-foundation.md | monorepo skeleton; every gate runs locally and in CI | done |
| 02 | 02-engine.md | workflow model, validation, scheduler, upstream caller, JSONata | done |
| 03 | 03-api.md | persistence, REST, live run events, serving published workflows | done 2026-10-27 |
| 04 | 04-graph-editor.md | build, save and run workflows in graph mode | accepted 2026-10-28; phases A and B committed; D's samples, previews, outputs by status and a step's blocks committed; C, runs, built (2026-10-30) |
| 05 | page-mode | the advanced view: steps in order, a card each with its data in and out; keyboard-first | not started |
| 06 | hardening | credentials, limits, images, observability | not started |
| 07 | 07-tests-and-catalogue.md | dry-run; test cases: unit tests of a step and API tests, mocked or live, gating Publish; the upstream library, filled by OpenAPI import; per-workflow caller keys | tests: direction (2026-10-30), shapes v1 seams, after 04's runs; the rest not started |
| 08 | 08-ai-authoring.md | spec in, draft workflow out; people review and publish | direction; shapes v1 seams; comes last of all |
| 09 | later | Redis cache, cron triggers, durable runs, loops; other step types (database, queue, script, SOAP/XML, gRPC) | parked |
| 10 | jsonata-editing | a JSONata language package for CodeMirror 6, then the editor uses it; comes after 04 and before 08 | not started |
| 11 | 11-visual-design.md | the look: calm, precise and simple, with the emphasis on the canvas and the data | brief taken 2026-10-28; starts when 04 is done, before 05 and 10 |
