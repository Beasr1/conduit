# 13. A minimal editor

Accepted 2026-11-01, from wireframes (your call). Built 2026-11-02, with
plan 12's editor parts (as built, at the end).

## Goal

The editor says too much. Each panel carries paragraphs that explain it,
the same ones on every tab: 139 words on a step's Request tab, 190 on each
status tab, 303 on a merging transform, 306 on the response card (counted
on your Fixes check). Someone who knows what a request is reads past all of
it to find the field they want. Graph mode keeps every feature and says
only what a field is. What a newcomer needs to learn moves to a short tour
and to one-line hints, there when asked for. A wireframe, not a design: the
look stays plan 11's.

## Decided with you on 2026-11-01, from wireframes

- **A step's panel has two rows of tabs.** The first row is its blocks:
  Request, a tab per status, Unhandled, and +. Request opens a second row:
  URL, Headers, Query, Body and Retry. Body holds what it reads, its
  JSONata and what it sends. A status tab leads with its status, as that's
  the condition, "When it answers 400", then the sample's body and
  headers, then where the run goes. Request as one scroll of folded
  sections was the other.
- **A transform keeps one result line.** Its Input tree with the tags, the
  case's condition, status and body, then "Gives" and what that is over the
  samples. The breakdown by each way in, and the notes under the tree, go;
  what a tag means moves to a hint. No result at all, and the breakdown
  folded under the result, were the others.
- **A line, and the response card, go bare.** A line: from, block and to;
  Required; its condition; Input folded until opened; whether it's taken
  over the samples. The card: each answer and the step that gives it, Add,
  the error body (plan 12), then Unhandled and Conduit's own answers, one
  line each. A line keeping its Input open was the other.
- **Guidance is a short tour and one-line hints.** Five stops, one sentence
  each, offered once and replayable from the toolbar: the canvas, a step's
  request, its responses as conditions, connecting, the response card. A
  field whose meaning isn't obvious gets ⓘ, one line on hover or focus.
  Hints only, and a help panel holding today's explanations, were the
  others.

## What goes, and what stays

- **Stays:** every field and action; the tags in an Input; problems, in the
  list and on their fields, as you liked them, worded shorter; what a step
  sends and what a transform gives over the samples; a run's results.
- **Goes, or becomes a hint:**
  - what each field is for, under the field;
  - "Steps after this one can read what it gets back", the paths and what
    each holds;
  - how Connect to works, on every status tab;
  - a sample's caveats (made up or redacted, saved in every revision);
  - the Unhandled tab's account of what it takes;
  - the notes under a transform's Input, and its result by each way in;
  - a line's account of joins and conditions;
  - the card's explanation of each of Conduit's own answers.

## Decided while drafting, yours to overrule

1. **The tour is ours, not a library's**: a popover pointed at each stop's
   element, with Back, Next and Skip, and the stop counted. It's a page of
   code, so it doesn't need a dependency. It remembers it was seen in the
   browser's storage, since Conduit has no accounts; a stop whose element
   isn't on screen, a step's blocks on an empty canvas say, is skipped.
2. **A hint is a button**, so a keyboard reaches it, named "About URL", and
   its line shows on hover and on focus, as WCAG 1.4.13 asks of content on
   hover or focus: dismissible with Escape, and staying while the pointer
   is over it.
3. **The step's id keeps its expression beside it**, `nodes.crm`, in the
   code font, rather than a sentence under the field.
4. **Words are labels**: "When it answers 400", "Then", "Connect to",
   "Sends", "Gives". A problem says what's wrong in a few words, with the
   detail the server sends where that's the specific part.

## Steps

- [x] A step's panel: the two rows of tabs; a status tab as wireframed; the
      Unhandled tab with Fail the run (plan 12).
- [x] A transform's panel: the result line; the breakdown and notes gone.
- [x] A line's panel and the response card's, bare, the error body on the
      card (plan 12).
- [x] Hints: the component, and a hint wherever a field lost its sentence.
- [x] The tour: five stops, offered once, Tour in the toolbar.
- [x] Problems worded shorter, plan 12's new ones among them.
- [x] Tests follow the new layout; the browser test too.
- [x] Chromium through nginx, light and dark, at desktop width: each panel
      before and after, with its word count.
- [x] Docs: design.md's Words, web.md, and as built here.

## As built

**A step's panel.** Two rows of tabs, each a tab list named for a screen
reader, Blocks and Request. The Request tab open is the store's
(`requestTab`), URL first, kept as another step is picked, so the problem
list opens the tab a field is on (`requestTabOf`). A status tab leads with
"When it answers 2xx", its group named by the legend through
`aria-labelledby`, as a legend that isn't a fieldset's first child names
nothing; then the sample's body, its status for 2xx, its headers, Then and
Connect to. The id has `nodes.crm` under it in the code font, and its hint
says what that holds.

**Unhandled.** "When it fails", then Fail the run (plan 12). While a line
or an answer leaves the block the box is off, as they take the failures,
but one saved with both through the API can still be unchecked. Failing,
the tab shows nothing more; otherwise Then, Connect Unhandled to, and
Write a body, which becomes the body and Remove the body. What's chosen
has a problem place of its own, `unhandled`, apart from the body's, so the
list says "crm · Unhandled", and the Unhandled tab is marked for either.

**A transform** gives one line: "Gives", or "Gives 200" with cases, what
the first run that comes gives (`givesOf`); a case that doesn't hold says
which does, or "No case holds with these samples." The breakdown by way
and the notes under the Input went; the tags stay, and the Input's hint
says what to check of them.

**A line** shows `prefs 2xx → crm` in the code font, Required, its
condition, its Input folded, and whether it's taken. **The response**: its
answers, Add an answer, the error body ("Problem details." and Write it, or
the body and Use problem details instead), then a line each for Unhandled,
"500, 502 or 504, by cause", and Conduit's own, 400 401 404 503, each
explained in its hint. The hint on Connect to keeps one piece of know-how
the old notes had: with every answer taken, to answer from a step too,
join it and the step that gives the answer to a transform.

**Hints** (`components/hint.tsx`) are a Popover with `openOnHover`, as
Base UI says of an info icon (sources.md), named "About URL". One opens on
hover, a click or Enter, but not on focus alone, which decision 2 said:
Base UI's hover popover doesn't open on focus, and its tooltip, which
does, is off on touch. 1.4.13 holds, checked in Chromium: Escape closes a
hint, and it stays while the pointer moves onto it. jsdom can't hover, so
its test clicks.

**The tour** (`tour.tsx`). The canvas fills the page, so a popover pointed
at it has no room beside it: its stop points at the toolbar on it. Then a
step's request block, from above, as its responses are on its right; its
2xx, twice; the response card, from its left. The parts are found a frame
after it opens, and each stop points at the element itself: Base UI reads
an anchor given as a function once, so in Chromium every stop stayed at
the first one's part, which jsdom couldn't show. The browser test now
checks the response's stop sits left of the card. A wait for the canvas
to measure its steps first was tried and dropped: without it, eight cold
loads in Chromium each found all five stops. Tour in the toolbar opens it
again, `conduit.tour` in local storage remembers it was offered, and
storage that refuses offers it again. Tests start with it seen
(`src/test/tour.ts`).

**Words, counted** in Chromium through nginx at 1440 by 900, over one
workflow, each panel as committed before and as built: every word it
shows, then its prose, leaving out code, samples and what's typed.

| Panel | Before | After |
|---|---|---|
| A step's Request | 145, 129 | URL 18, 15; Headers 18, 17; Retry 19, 18 |
| A request body | 170, 125 | Body 58, 17 |
| 2xx | 211, 198 | 39, 30 |
| 404 | 217, 207 | 36, 30 |
| Unhandled | 239, 229 | 16, 15 |
| A merging transform | 436, 378 | 82, 45 |
| A line | 110, 91 | 14, 7 |
| The response | 306, 295 | 45, 37 |

Neither build logged a console warning or error, light or dark, so
nothing broke the page's CSP.

**Mutation checks**, 45 on the web. Three survived at first. Reopening the
tour flashed the stop it was left on, and an Unhandled problem waited for
the next check rather than going as the choice changed: each got a test.
The third was the wait above, which went.

**Since found**: NN/g's study of tutorials finds they "interrupt users,
don't necessarily improve task performance, and are quickly forgotten"
(sources.md). The tour stayed as decided, offered once, until you chose
the toolbar only on 2026-11-02: it no longer opens on its own, so nothing
is kept in local storage, and tests no longer start with it seen. Its
last stop now says a run gives the first answer reached, top to bottom
(plan 14).
