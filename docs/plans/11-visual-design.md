# 11 — Visual design

Status: brief taken 2026-10-28. The pass itself starts once 04 is done,
before 05 and 10, so page mode and the expression editor are built in the
new look. Written before its milestone starts because the brief already
decides what the editor shows and says.

## Goal

Conduit looks designed rather than assembled: calm, precise and simple,
with the emphasis on the canvas and the data. How a design pass runs is in
docs/working-style/design.md; this plan is Conduit's own.

**Done** when every screen meets design.md's floor in both colour modes, at
desktop and phone widths, and you've signed off the screenshots.

## The brief (2026-10-28)

Eight questions, asked the way design.md says, and three that followed.
Where an answer wasn't one of the options, it's given in your words.

| Question | Answer |
|---|---|
| Who uses it | your assumption: the graph is for non-technical people, and a step's detailed view (its request, its mappings) for technical ones |
| How it should feel | calm and precise |
| Looks to sit next to | Linear, Figma, Tines, n8n / Make |
| Never | the dark hacker look: black, neon green or red, everything in monospace. Cute touches are welcome, but not everywhere |
| What people remember | simple and nothing loud, with the emphasis on the canvas and the data. A run coming alive across the graph is good, but every time it would grate: it belongs to a preview or a simulation |
| What a step shows | a plain name first, with what it calls in small type under it |
| What it's called | "step" |
| How tightly it's packed | a roomy graph and a compact detail panel |
| Colour mode | not asked: both, following the system (web.md) |
| The graph | the top level, with every feature, request settings included, but visually simple |
| The advanced view | page mode (05) becomes it: steps in order, a card each, showing what comes in, what's mapped into the request, the response to expect, how it's mapped and what goes on. Keyboard-first, and technical words are fine there |
| The step's name | added here, not in 04 |

## What follows

Decided by the answers:
- Text on screen says "step"; code, the API and expressions keep "node"
  (design.md, Words).
- A step gets an optional name, shown first on the canvas. The id stays,
  since expressions use it. It's a new field in the definition, which the
  engine ignores, added in this plan; until then the canvas shows ids.
- The canvas stays pointer-first: edges are drawn by dragging or by
  clicking two handles. Page mode is the keyboard way to build. WCAG
  accepts that only if page mode provides "all of the same information and
  functionality" as the graph, so every workflow has to fit in it (the
  roadmap's 05 row).
- A normal run shows each step's status plainly, a colour and a word,
  without a flourish. The playback (steps lighting up as the run reaches
  them, branches visibly running side by side) belongs to previews and dry
  runs (07).

My reading, for the style tiles to confirm or overturn:
- Two layers. The graph speaks plainly: names, an icon for each kind of
  step, no code. The detail panel is technical and compact: the request,
  the mappings, code in the code font.
- From the four looks: quiet chrome like Linear's and Figma's around a
  friendlier canvas like Tines's and n8n's, with colour that means
  something (the kind of step, its status) rather than decorating.
- Cute touches in two places at most, chosen from the style tiles.
  Candidates: the empty workflow list, and the first run that succeeds.

## Steps

- [ ] Style tiles: two or three directions as rendered pages (colours,
      type, a step on the canvas, the detail panel, the workflow list),
      light and dark, as PNGs. You pick.
- [ ] Tokens in `web/src/index.css`: colours, a type scale, radii,
      spacing, focus. Fonts are bundled, since the CSP only allows fonts
      from our own origin (`font-src 'self'`).
- [ ] The canvas: steps, edges, handles of at least 24 px, selection,
      problems, run status.
- [ ] The detail panel, the workflow list, sign-in, errors and empty
      states.
- [ ] Screenshots of every screen, light and dark, desktop and phone;
      `just check` green.
- [ ] design.md gains the rules this pass settles: the tokens, the type
      scale, where colour goes.

## Open questions

1. **Where do the cute touches go?** Decided from the style tiles.
