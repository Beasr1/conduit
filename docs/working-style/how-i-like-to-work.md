# How I like to work

The canonical version. CLAUDE.md points here; read it before starting any
piece of work. Every rule comes from a real correction; sources.md has the
outside sources that back or challenge each one.

## Push back

- Question my decisions at every level: what I say in chat, these docs, my
  habits. Nothing is exempt, this file included.
- When best practice disagrees, say so before acting: what you'd do
  instead, why, and the source. Then I decide.
- Once I've decided, follow it and record it where it belongs: the plan's
  decision table, or this file.

## Never

- **Never commit or push. I commit.** Make the change; when I ask, stage it
  and suggest the message.
- **Never claim what you didn't check.** If tests weren't run, say "not run".
  Run the check instead of reasoning from plausibility.
- **Never guess at an ambiguous spec.** Ask.

## Git

- Trunk is `main`. Short-lived branches `<type>/<slug>` (e.g.
  `feat/dag-executor`), rebased onto main, not merged.
- Commit message: one line, conventional commits, lowercase,
  `type(scope): what, and why as a clause`. Aim for 72 chars, 80 max.
  No body. No `Co-Authored-By` trailer.
  - `fix(engine): cancel siblings on first failure so a dead run stops calling upstreams`
- Types: `feat fix refactor perf test docs chore ci build`. Scope is the
  package or area touched: `engine transform upstream store httpapi config
  web editor schema db ci docs`.
- One logical change per commit. A structural change and the migration of
  its consumers are two commits.
- Stage by file name. Never `git add -A`, `-u` or `.`.
- Before a commit: check the branch, check `git diff --staged` holds only
  what was meant.
- `git stash apply`, never `pop`. The stash stays as a safety net.

## Before writing code

- Explore, plan, then code. Anything bigger than a small fix gets a plan in
  docs/plans/ first and a nod from me. If the diff fits in one sentence,
  skip the plan.
- When a change can be checked, write the failing test first, then make it
  pass.
- Read the neighbouring code before introducing a pattern. Match its
  naming, comment density and error-handling shape.
- Existing conventions beat tutorial or spec conventions.
- Reuse what exists. A new helper lives next to its siblings, not in a new
  `utils` package.
- When the scaffolding for something exists, complete it — work like
  autocomplete. Don't redesign what's set up. Fix outright bugs and say so.

## Keep it simple

- No abstractions on speculation. Inline twice is fine; refactor on the
  third copy.
- If an edit has to touch 3+ copy-pasted sites, stop and ask: extract first,
  or patch in place? If I say leave it, leave it.
- No belt-and-suspenders code paths. If the natural flow already covers a
  case, don't add a second check.
- No new dependency without a one-sentence reason. The standard library is
  the default.
- Expect "are they even required?" and have the evidence ready. Deleting
  things is a good outcome.
- Out of scope but noticed? Prefer a TODO (listed in the plan) over a
  drive-by change.
- Don't change behaviour inside a refactor. Renames are fine; swapping the
  logic behind a check is its own change, with tests.
- Use the real thing over a mock when it can run locally: Postgres, Redis,
  an `httptest` server.
- No global mutable state in library packages. State is owned in `main`
  and passed in.

## Comments

- Comment the *why*, and only when the code can't show it. One line for a
  subtle branch, two or three for a non-obvious function.
- No vanity comments, no comments arguing that the change is right, no
  file-path headers, no comments restating the code.
- Longer rationale belongs in docs or in config/CI comments, not code.

## Verification

- Done means `just check` is green for everything touched, and the summary
  says exactly what ran.
- Pipes hide failures: `cmd | head` reports head's exit status, not cmd's.
- Read the implementation before deleting "duplicate" code. Doc comments
  drift; function bodies don't.
- Before explaining why a number moved (coverage, latency, size), dump the
  raw data and let it say what moved.
- A reproduction rules out flakiness, not a deterministic tooling bug.
- A behaviour change needs its test fixtures updated. If that can't happen
  now, flag it.

## Asking

- AskUserQuestion with 2–4 concrete, mutually exclusive options, the
  trade-off in each, the recommended one first.
- Never an abstract "what should I do?".
- If a decision has a conventional default, take it and mention it.

## Communication

- Short, direct, structured. Tables to compare, bullets for decisions,
  prose for reasoning. No preamble.
- Cite the source: `file:line`, a doc, a URL.
- Flag divergences up front — from the spec, the plan, or an earlier
  decision — not in a footnote.
- File references as plain text, `server/internal/engine/run.go:42`, not
  markdown links. I often read on my phone.
- When touching tooling (just, the Go toolchain, Vite, Docker), explain the
  mechanism in 1–3 sentences, even if it seems obvious.
- "Dumb it down" means plain words and a concrete analogy.

## Docs

- docs/plans/ holds numbered plans (`NN-slug.md`) indexed in
  docs/plans/README.md. A plan has a goal, checkbox steps, what "done"
  means, and open questions.
- When work lands, update its plan in place: decisions (with why), what was
  deferred, divergences from the spec.
- Every deliberate TODO comment is listed in its plan with `file:line`, so
  one grep finds them all.
- Learnings go to my learning repo (path in CLAUDE.local.md), following
  that repo's own CLAUDE.md. Write them as we go, not at the end, so they
  survive context compaction. General lessons only: nothing specific to
  this repo, no work names.

## Wrap-up summary

At the end of a piece of work:

1. Files touched, one line each, and the suggested commit message(s).
2. What was deferred, and why.
3. What's still pending from the plan.
4. Divergences from the spec or plan, with the reason.
5. Build and test status — what ran, what didn't.
6. The next natural step and its main trade-off. Don't decide it for me.
