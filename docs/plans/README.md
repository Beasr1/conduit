# Plans

Numbered plans, one file each. A file is written when its milestone starts,
or earlier if it shapes v1's design (08 does). Until then the milestone
lives as a row in 00-roadmap.md.

| # | Plan | Goal | Status |
|---|---|---|---|
| 00 | 00-roadmap.md | scope, architecture, execution semantics, decisions, milestones | proposed; only D1 open |
| 01 | 01-foundation.md | monorepo skeleton; every gate runs locally and in CI | not started |
| 02 | engine | workflow model, validation, scheduler, upstream caller, JSONata | not started |
| 03 | api | persistence, REST, live run events, serving published workflows | not started |
| 04 | graph-editor | build, save and run workflows in graph mode | not started |
| 05 | page-mode | step-by-step builder over the same definition | not started |
| 06 | hardening | credentials, limits, images, observability | not started |
| 07 | tests-and-catalogue | dry-run; test cases; OpenAPI import; per-workflow caller keys | not started |
| 08 | 08-ai-authoring.md | spec in, draft workflow out; people review and publish | direction; shapes v1 seams |
| 09 | later | Redis cache, cron triggers, durable runs, loops; other step types (database, queue, script, SOAP/XML, gRPC) | parked |
