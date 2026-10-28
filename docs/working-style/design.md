# Design style

For how `web/` looks, reads and moves. How we work is in
how-i-like-to-work.md and how the code is written in web.md. What Conduit
itself should look like, and for whom, is the brief in plan 11.

## When

- Function first. A screen gets its design pass once it works end to end;
  until then shadcn's defaults will do. Polishing a screen that may still
  change shape is wasted.
- Working isn't the same as designed. The design pass is a milestone with a
  plan like any other: the brief, the options shown, what I picked and why,
  and what was turned down.
- Words are the exception: get them right from the start (Words, below).
  They cost nothing.

## Ask before drawing

Before any pixels, ask me what a designer asks a client. Use
AskUserQuestion, with the trade-off in each option and your pick first:
- who uses the screen, and what they came to do;
- how it should feel, in a word or two;
- products whose look I'd happily sit next to, and anything I never want
  to see;
- what someone should remember about it;
- what each thing shows, and what it's called;
- how tightly it's packed.

My answers are the brief, and they go in the plan. When an answer isn't one
of the options, say how you read it before building on it. The brief beats
any checklist, this file included.

## Show, don't describe

- Directions come as rendered pages, not adjectives: two or three, each
  with its colours, type, a step on the canvas, a form and a list, in light
  and dark. Send me PNGs, and the command to open the page myself. I pick.
- Each choice in a direction has a reason from Conduit's world: its users,
  requests and responses, graphs that fan out, runs that pass or fail.
  "It looks modern" isn't one.

## Distinct, not contrarian

- A stock look is fine while building and not when shipping: the component
  kit's defaults, the default font, one radius and one soft shadow on
  everything, a gradient as decoration.
- A list of looks to avoid is a template too. Follow one to the letter and
  you end up looking like everyone else who did. Use such lists as review
  questions, never as rules.
- Each screen puts its emphasis in one place, and the rest stays quiet.
  Before calling a screen done, take one thing away.
- Delight goes in a few chosen places, never everywhere.

## Keep it simple

- Few of everything: a handful of type sizes, colours, radii and spacings,
  each with one job and used the same way everywhere. A new token needs a
  job no existing one does.
- Show what the task needs; the rest appears when asked for. Picking a step
  opens its settings.
- Structure means something. A border, a number, a label or a colour is
  there because it tells the user something.
- Colour says what a thing is or what state it's in. A status colour means
  the same on every screen.
- Motion answers something: an action, or a state that changed. Motion that
  plays every time wears thin, so the big moments go where people asked for
  them.

## Words

- Name things the way users would. Text on screen says "step" and
  "connection"; code, the API and expressions say "node" and "edge"
  (`nodes.crm.body`), and wherever an expression is written, the screen
  explains that once.
- "Upstream" means only the API a step calls. Direction in the graph is
  before and after: a step runs after another, and reads earlier steps.
  Docs and code comments say it the same way.
- A button says what it does ("Save", "Publish", "Run"), and what follows
  uses the same word ("Saved", "Published").
- An error says what happened and how to fix it. It doesn't apologise.
- An empty screen says what to do first.
- Sentence case everywhere.
- Code looks like code: URLs, expressions and JSON are set in the code font,
  and nothing else is.

## The floor

Not taste, so not up for debate screen by screen. Check it on every pass.
WCAG 2.2, level AA unless noted (sources.md):
- Contrast of 4.5:1 for text, and 3:1 for large text and for what you need
  to see of a control or a diagram, in both colour modes (1.4.3, 1.4.11).
- Colour is never the only signal: a failed step also says so in words or
  with an icon (1.4.1).
- Keyboard focus is always visible, and never hidden under something
  sticky (2.4.7, 2.4.11).
- Everything works from the keyboard (2.1.1, level A), or another view of
  the same thing does everything this one does and can be reached from it:
  a conforming alternate version, in WCAG's terms. Drawing edges on the
  canvas needs a pointer, so page mode is the keyboard way to build.
- Anything done by dragging can also be done by clicking (2.5.7). On the
  canvas, an edge is made by clicking one handle and then the other: React
  Flow's `connectOnClick`, on by default.
- Targets are at least 24 by 24 px, or spaced so that a 24 px circle around
  each touches no other target (2.5.8). That includes connection handles,
  which React Flow draws 6 px wide.
- Motion nobody asked for stops under `prefers-reduced-motion`. That's
  2.3.3, level AAA; we hold it anyway.
- Sign-in, the workflow list and the run screens work 320 px wide without
  scrolling sideways (1.4.10). The canvas is exempt, since a diagram needs
  both dimensions.
- Long names, ids and URLs are cut short with the full text still
  reachable, and never push a layout wider.

## Checking

- Look before saying it's done: Chromium screenshots of every changed screen
  through the stack (`just up`), light and dark, at desktop and phone
  widths. Send me the PNGs.
- Look at the unhappy states too: empty, loading, failed, a long name, a
  graph of fifty steps.
- `just check` covers the code, not the look. "It looks right" means you
  looked at a screenshot of it in this session.
