# 17. Masked fields in run records

Accepted 2026-11-18, with your six answers of that day in it. The queue's
item 4.

## Goal

A marked field is never kept in plain text. Wherever its value shows up in
what a run keeps, it's kept as stars:

- the run's input;
- each step's request and response;
- the run's answer.

A mark hides the whole value, or keeps its start, its end or both for
debugging, such as `***********5671`. The caller still gets the real value.

## What's wrong today

- A run keeps every part of itself in full, up to 256 KiB each: its input,
  every step's request and response, and its answer. It keeps them for
  good, since nothing is deleted (plan 15). An Emirates ID, a phone number
  or a name in any of them sits in the database in plain text, for anyone
  who opens the run to read.
- Only secret constants are masked (plan 06), and only by value. A
  person's details aren't constants.

## What others do

- **Apigee** masks "specific data in trace and debug sessions" ✓.
  - It names fields by path: "Using JSONPath, you identify JSON properties
    to be filtered from request or response message payloads" ✓.
  - It shows stars: "When data is masked, it is replaced with asterisks in
    the trace output" ✓.
  - Traffic is untouched: "Data masking does not affect the data that gets
    sent to targets or client applications" ✓. That's your answer 4.
  - It masks a field only where the path names it, not its copies
    elsewhere.
- **Datadog's Sensitive Data Scanner** has three ways to hide a match ✓:
  - Redact: "Replace the entire matched data with a single token";
  - Partially redact: "Replace a specific portion of all matching values";
  - Hash.
  - Its blog says "Partial redaction will redact the first n or last n
    characters" ✓.
- **PCI DSS v4.0, requirement 3.4.1** allows "no more than the BIN and last
  four digits of the PAN are displayed on computer screens, reports, etc."
  ✓. So card rules keep both ends.
- **OWASP's Logging Cheat Sheet** lists "Sensitive personal data and some
  forms of personally identifiable information (PII) e.g. health,
  government identifiers, vulnerable people" ✓ among what "should usually
  not be recorded directly in the logs", but "should be removed, masked,
  sanitized, hashed, or encrypted" ✓.

## Decided with you (2026-11-18)

- **Marked on the upstream and the input.** You mark:
  - an upstream's parameters;
  - the fields of an upstream's responses;
  - a workflow's input fields.

  Every workflow that uses an upstream is then masked without anyone
  doing anything. The other options were each workflow's own steps, or
  one list of names for the whole server.
- **Every copy.** A marked field's value is masked wherever it shows up in
  the run, as secret constants are. The other option was only where the
  field is marked.
- **All, the start, the end, or both ends**, chosen for each field. A mark
  hides the whole value, or keeps N characters at its start, at its end, or
  at both, with the middle hidden.
  - Your note had all, or the start. The end tells records apart; the
    start often doesn't, since every Emirates ID starts with 784, so an ID
    takes the end.
  - Both ends is your idea, asked about after this plan was drafted. It's
    the shape card rules use (PCI above).
  - The other options were all, start or end only, or one fixed mask that
    hides the middle half. A fixed mask keeps the useless 784 of an ID and
    leaves a name easy to guess, `Fatim*********oori`.
- **The caller gets the real value.** Only what's kept is masked: a run's
  records, and what logs and live events say. A mobile app showing
  customers their own details still works.
- **An upstream's newest marks apply to the runs of every version**, from
  the next run.
  - Why: a step pins a version so that its call and its answers never
    change under it. A mark changes neither; it only changes what Conduit
    keeps. Mark an ID in v5, and the next run of every workflow on v1–v4
    masks it. Nobody has to move twenty workflows to stop keeping it in
    plain text.
  - The cost: removing a mark applies at once too. So a version that
    changes the marks says so on the changes list of each workflow that
    pins the upstream (plan 16).
  - The other option was marks pinned with the version, so each workflow
    is masked once it moves up and publishes.

## How it works

1. **Marking.**
   - An upstream's **parameter** can have a mask: all, start, end or both,
     with how many characters are kept at each end. Whatever value a step
     gives that parameter is masked.
   - An upstream's **masked fields** each name a field of its responses, at
     any status, the way an expression reads it:
     - `customer.emirates_id`;
     - `contacts.phone`, which is each contact's phone, as JSONata maps
       over an array;
     - a name with odd characters goes in backticks: `` `first-name` ``.

     A marked field that holds an object or an array has every value
     inside it masked.
   - A workflow's **masked input fields** are named the same way, over the
     run's input. They sit in Workflow settings, beside the input schema.
2. **What a mask looks like.** One star stands for each character hidden,
   so a record keeps its shape:

   | Value | Mask | Kept as |
   |---|---|---|
   | an Emirates ID | all | `***************` |
   | an Emirates ID | end 4 | `***********5671` |
   | a card number | start 6 | `411111**********` |
   | a card number | both, 4 and 4 | `4111********1111` |
   | a name | all | `******************` |

   - At least half of a value is always hidden, rounded up. A mask that
     would show more shows less:
     - start 3 on a value of 4 characters keeps 2;
     - with both ends, the start gives way first, since the end is what
       tells records apart. Start 6 and end 4 on a 16-digit card keeps
       4 and 4.

     That's stricter than PCI, which allows the BIN and the last four, 10
     of 16. It's also the 50% you asked about.
   - A mask counts characters, not bytes, so an Arabic name gets one star
     per letter.
   - A masked number is kept as a string.
3. **Every copy, from values.** A mark says where to find a value, not
   where to mask it. The run collects each marked value as it meets it:
   - its input, as the run starts;
   - what a step gives a marked parameter, as the step runs;
   - a marked field, as a response comes back.

   From then on, every exact copy of a collected value is kept masked:
   - in the run's input;
   - in each step's request (URL, headers and body);
   - in each step's response and what it gave;
   - in each step's error;
   - in the kept answer.

   This is the net secret constants already use (plan 06), with its rules:
   - a copy in a URL is found when it's escaped, too;
   - a value under 8 characters is masked only where it is the whole value;
   - a copy an expression changed, cut or reformatted isn't found.
4. **A value found late is still masked.** The run keeps its input as it
   starts, before a step gives an ID to a parameter that its upstream
   marks. So at the run's end, what was kept before a value was found is
   masked again, rewriting only what that changes. An ID that came in the
   input unmarked and went to a marked parameter ends up masked in the
   input too.
5. **A workflow used as a step** masks its own run by its own marks. It
   then hands what it masked back to its caller's run, which masks it too.
6. **The editor.**
   - On the upstream page, each parameter's row gets a mask. A Masked
     fields list goes below the parameters; it offers fields from the
     samples, each with its mask.
   - Workflow settings gets Masked input fields, which offers fields from
     the sample input.
   - A run's records show what was kept, masked. Nothing else changes.
7. **Through the API**, it's all in documents that are already saved:
   `mask` on a Parameter, `masked` on an Upstream, `masked_input` on a
   Definition. There are no new endpoints.

## Decided while drafting, yours to overrule

- **A workflow's own input marks come with its revision.** A served run
  uses the published revision's marks, so a new mark takes a publish. Only
  one workflow has to publish, and its author is the one marking.
- **Masking starts with the next run.** Runs already kept stay as they
  were. Masking them, working from their own records, is for later (it
  goes on the README's list).
- **Two things can't be marked**:
  - response headers;
  - a step with a request of its own, from before plan 07, which Publish
    refuses anyway. Save it as an upstream first.
- **Previews mask nothing.** They read samples, which are made up or
  redacted already.
- **Secret constants stay as they are**: shown as their stand-in,
  `[secret crm_token]`, and masked in the answer too.
- **An equal value is masked too.** A short marked value such as `F` hides
  every whole value `F` in the run, whether related or not. Masking more
  than was marked beats keeping what was.

## Steps

- [x] **A. The engine and the runner**, tests first:
  - the schema:
    - a mask on a parameter;
    - masked fields on an upstream, and masked input fields on a
      definition;
    - checked on save: a field's name parses, and 1–8 characters are kept;
    - then `just gen`;
  - the masks: all, start, end and both, the half rule with the start
    giving way first, counting characters, and numbers;
  - the run's collected values growing as it meets marked values: in its
    input, in a parameter, in a response, using the newest version's marks;
  - masking again at the run's end, with the caller's answer left real;
  - a workflow used as a step handing back what it masked;
  - a version that changes the marks saying so on the changes list.
- [x] **B. The editor**:
  - the upstream page's parameter masks and Masked fields;
  - Masked input fields in Workflow settings;
  - all of it read-only when archived.
- [ ] **C. The rest**:
  - the browser test: an input field and a parameter marked, then a run
    whose records are masked and whose answer is real;
  - mutation checks;
  - docs: this plan, the README, CLAUDE.md, go.md, web.md and sources.md;
  - the learning repo's chapter on masking what's kept;
  - a walk in Chromium through nginx, light and dark, desktop and phone,
    with PNGs.

## Done means

- A marked value isn't in plain text anywhere a run keeps it, except where
  an expression changed it.
- The caller gets its answer as before.
- An upstream's mark reaches every workflow that uses it, from its next
  run.
- `just check` is green.

## Built (2026-11-18)

As planned, but for these, each found while building it:

- **Marked values are found in decoded JSON**, not by matching bytes as
  secrets are. A number is found too, and so is text an upstream escaped,
  as an API that escapes all but ASCII writes an Arabic name, `\u0641…`.
  jsonb keeps no key order, so a record is written afresh once the run
  has met a marked value; until then it's left as it was.
- **An object's keys aren't masked**: a value used as a key stays.
  Written afresh, two keys could become one.
- **The end of a run masks again only what needs it.** Each record counts
  how many marked values it was masked by. As the run ends, those kept
  before its last value, and its input, are read back, masked again and
  rewritten in one transaction, before the run's end is recorded. So a
  run that has ended keeps its records as they'll stay.
- **The engine knows nothing of masks.** The request a step sends now
  carries what it gave the parameters (`Params`) for the runner to read;
  previews don't show it. A run of a workflow a step uses hands its values
  back through the context of the step's call, which the engine passes on
  untouched.
- **Live events aren't masked again.** A failure's words are masked by
  what the run has met when it fails. Events aren't kept.
- **A run that uses upstreams asks for their newest versions**: one query
  more as it's prepared.
- **Defaults**: a masked field hides all of its value until changed; a
  parameter is Not masked until chosen; an end keeps 4 characters until
  changed.
- **Tests**: `choose`, which picks an option in a select, moved to
  `web/src/test/choose.ts`, as a third test needed it. The Done flow's
  browser test clicks the Add in Parameters, as the upstream's page has
  two Add buttons now, each in its own region.

Limits, known:

- A copy an expression changed, cut, reformatted or encoded otherwise,
  isn't found, as for secrets.
- A value under 8 characters is masked wherever it's a whole value,
  related or not, and not inside longer text.
- Runs kept before a field was marked stay as they were (the README's
  list).
- At phone width the side panel is clipped at the right edge (plan 05).

Checks: 51 mutations, all caught. 33 are the server's; one, a version
saying its masks changed, was first written so that it didn't compile,
and caught once it did. 18 are the web's; four survived a first run, each
closed with a test:
- a version that masks opened as unsaved;
- a field marked, and nothing else, wasn't a change to save;
- a masked input field's problem went as another field changed;
- a masked field's mask offered Not masked.

A runner test also gained a step before the one that meets the ID, so a
step's record kept before a value was met is masked again at the end, as
the input is.

Walked 2026-11-18 in Chromium through nginx (`just up`), light and dark,
desktop and phone: an upstream's page with a parameter and two fields
marked, Workflow settings with two input fields marked, and a run's step,
which gave `***********5671`. The run's record, read back through the
API, kept the input's ID and name as stars, and the copy of the ID inside
a note too. No console errors, and the upstream's page doesn't scroll
sideways at 390 px. The walk found one thing: a row of a name and its
mask didn't wrap, so on a phone a parameter's name shrank to a letter,
and in the side panel a field's Remove sat alone on a line. Rows now go
by the room they have, a container query: with room, one row, the mask
the same width whatever it shows, so the columns line up; without, the
mask under the name, Remove at its end.

## Open questions

None that block it. Newest marks at once, or pinned with the version, was
asked and answered on 2026-11-18: at once.

## Sources

Read 2026-11-18 ✓.

- Apigee, masking and hiding data:
  https://docs.cloud.google.com/apigee/docs/api-platform/security/data-masking
- Datadog, Sensitive Data Scanner: https://docs.datadoghq.com/security/sensitive_data_scanner/
- Datadog, Sensitive Data Scanner for financial services:
  https://www.datadoghq.com/blog/sds-dlp-for-financial-service-companies/
- PCI SSC, PAN masking with 8-digit BINs:
  https://pcisecuritystandards.org/faq/articles/Frequently_Asked_Question/how-can-an-entity-meet-pci-dss-requirements-for-pan-masking-and-truncation-if-it-has-migrated-to-8-digit-bins
- OWASP, Logging Cheat Sheet:
  https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
