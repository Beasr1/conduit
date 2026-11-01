# 14. The response picks

Accepted 2026-11-02, as drafted (your call). Built the same day (as
built, at the end).

## Goal

One exit, with nothing to add for it. Today an answer takes one line, and a
run that can reach two answers is refused (`overlap`), so a workflow that
wants one exit needs a step of its own to pick: `respond` in your Fixes
check, joined to every answer, with a collecting transform before it. Every
such workflow would carry that pair, always joined to the card. In your
words, "respond and response. both are not required": the response picks.

## Decided with you on 2026-11-02, on your Fixes check

- **One thing ends a run and picks its answer: the response.** No respond
  step. Keeping respond as a step you add, and every workflow starting with
  one, were the others; each was chosen and then dropped the same day.
- **One exit, failures included**, as plan 12's note of the same day
  records: no "Fail the run" exits in between.

## How it works

- **An answer takes lines from any number of steps**: a status, its lines,
  the schema promised. A line leaves a block, as now: a response, a case,
  a transform's value, or an Unhandled.
- **A run answers with the first answer, top to bottom on the card, that one
  of its lines reached**, with that answer's first line reached, in the
  order its lines are listed. A Step Functions Choice state reads its rules
  the same way: it "examines each of the Choice Rules in the order listed"
  and takes "the first Choice Rule" that matches (sources.md).
- **So two answers one run can reach are no longer a problem**: the order
  decides. An error answer put first wins whenever a failure reached it.
- **Failures go straight to an answer.** Every step's Unhandled can join the
  500 answer, with no collecting step. The error body answers it (plan 12),
  `error` being the failure of the first of its lines reached.
- **What stays**: a block joined to two answers is still a problem, as the
  second could never be given, but for a transform with an expr, which
  picks by the status it gives; Publish's checks (plan 12), every way
  reaching an answer and every failure decided; and "Fail the run", for a
  workflow that should stop at its first failure.

Your Fixes check then reads: every step's Unhandled into 500, first;
`bad_400` into 400; `merge_200` into 200, last. `unhandled` and `respond`
go.

## Decided while drafting, yours to overrule

1. **The order is the priority, and the card shows it**: answers are
   numbered, and moved with Move up and Move down in the response's panel,
   as cases are. A new answer goes last.
2. **Within an answer, the first line listed wins.** Lines are listed in the
   order they were joined.
3. **The run still waits for every step before it answers**, as now.
   Answering as soon as the top answer is reached, and stopping the rest,
   can come later.
4. **The definition**: an answer's `from`, `on` and `unhandled` become a
   list, `lines`. A migration moves each answer's one line into its list,
   and back on Down, keeping the first.
5. **A line into an answer takes no condition.** A condition goes on a
   step before it, as now.
6. **The alternative**: each answer with a JSONata condition and body, the
   first that holds answering. More power, but every answer needs JSONata,
   and which answer a run gives would turn on data Publish can't check.

## Steps

- [x] Schema: `Answer.lines`; `just gen`; the migration.
- [x] Validation, tests first: lines' ends; a block joined to two answers;
      `overlap` goes; plan 12's loose ends over lines.
- [x] Engine: the first answer, top to bottom, with a line reached; its
      first line reached gives the body, or the error passed on.
- [x] Editor: several lines into an answer's point; Connect to offers every
      answer; the panel lists each answer's lines; numbered answers, Move
      up and down; the problems' words.
- [x] The browser test; mutation checks; Chromium through nginx, light and
      dark.
- [x] Your Fixes check as revision 46, without `unhandled` and `respond`.
- [x] Docs: plan 04's answers, plan 12's note, web.md, sources.md,
      CLAUDE.md.

## As built

**The definition** (`schema/workflow.yaml`): an answer has `lines`, each an
`AnswerLine`, its `from` and `on` or `unhandled` as an edge's. The
migration (`20261102100000_answer_lines.sql`) moves each saved answer's one
line into its list, in order. It was tried first on a copy of the 49
revisions here, 32 of them with answers: Down gave each back as it was.
Revision 45 of your Fixes check, published meanwhile, answers through
`respond` as before.

**Validation** (`answers.go`) checks each line where it is,
`/response/answers/k/lines/j/from`, and an answer with none needs one
(`required` at its `lines`). `overlap` went: two answers one run can reach
are fine, as the first answers. One block into two answers is `dead_line`,
at the later, as it's never given; into one twice, `duplicate_line`. A
transform with an expr still picks among the answers it's joined to, and a
case still joins its own status's answer; an Unhandled line from a switch
is checked as an Unhandled. Publish's checks (plan 12) read lines.

**Runs** (`engine/run.go`) give the first answer, top to bottom, with a
line reached, and that answer's first line reached gives the body, or the
error it passes on. A transform that picks reaches only the answer it
picked, so an answer above it can still win; picking one it isn't joined to
fails the run, as before. A run that reached two answers and failed is gone
with `overlap`.

**The editor**: an answer's point takes lines from any number of steps,
each once. Joining a block to another answer moves its line, but a
transform with an expression gets cases, as before. Connect to offers every
answer the block doesn't give yet. The card dims an answer no line reaches
and names every step its answers come from; the only line it refuses is one
let go off an answer's point. The response's panel numbers its answers,
moves them with Move up and down, and lists each answer's lines, each
opening its step on its block, with Disconnect. A problem in a line is
placed on it: "Response · 200 · crm's line". The numbers are the panel's;
on the card, top to bottom says the order, where decision 1 said the card
too.

**Your Fixes check**, revision 46: every step's Unhandled into 500, first;
`bad_400` into 400; `merge_200`'s case into 200, last. No problems, and
nothing published.

**Tests**: validation (lines' ends, dead and duplicate lines, two answers
one run reaches, lines from several nodes); runs (the order both ways,
failures first from the first line reached, a pick passing over the
answers it didn't pick); Publish (failures into one answer above the
rest); the editor's edits, the canvas's lines, problems' places and words,
the response's panel (numbered, moved, a line disconnected), and Connect
to. The browser test is unchanged and passes.

**Mutation checks**: 14 on the server and 14 on the web, every one
caught. Chromium through nginx, light and dark: revision 46 draws as
planned, and logged nothing.
