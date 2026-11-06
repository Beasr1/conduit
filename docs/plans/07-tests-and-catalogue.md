# 07 — Tests and catalogue (direction)

Status: the test suite is a direction, not scheduled: it comes after plan
04's runs (phase C), and it's written now because it shapes v1, as 08 is.
Upstreams, the catalogue, are accepted below (2026-11-02) and being built;
OpenAPI import and caller keys are planned when they start. Talked through
with you on 2026-10-30. ✓ means checked first-hand on the source.

## Goal

The people who own a workflow's API can show a version works before it's
published:
- API developers write unit tests of a step: given what it reads, check
  what it sends, what a transform gives, or whether a connection is taken.
- QA writes API tests of the whole workflow: a request goes in, the APIs
  it calls answer from mocks or for real, and the response that comes out
  is checked.

Publish refuses a version whose tests fail. Everyone can see which version
is published, and a new one is tested at a private URL while the old one
keeps serving.

## Where I'd push back

- **Live tests call the real APIs.** There are no environments (your
  call), so a live test of v4 calls the same APIs v3 does, and a POST in it
  creates a real record. A test therefore says, step by step, whether a
  step is mocked, answering with a response it picks, or live. Step
  Functions' test cases mix the two: in its "HybridPath" one state answers
  from a mock, and then the next "performs an actual service call to the
  resource specified in production" ✓. A step that writes (POST, PUT,
  PATCH, DELETE) stays mocked unless the test says otherwise.
- **Tests over mocks show the logic, not the APIs.** They check mappings,
  conditions and which branch runs. Whether an API still answers like its
  samples is for live tests, and for the catalogue's typed contracts.
- **A mock that can reach production is a hazard.** Logic Apps sets mock
  outputs on the live action itself, and "No indications exist at the logic
  app level that mock outputs are enabled" ✓. Here mocks live only in tests
  and samples, which runs ignore.
- **The private URL is a door.** It takes the same sign-in as the API,
  never a secret in the URL, and its runs are recorded as test runs, told
  apart from callers' traffic.

## How it would work

1. **Tests live in the definition**, beside samples, so every revision
   carries its own, and Publish checks a revision against the tests written
   for it. A test QA adds is saved as a new revision, unpublished, the way
   a commit carries its tests.
2. **A unit test** names a step, a connection or the response card, gives
   the input, and says what each step before it answers: 2xx by default, or
   a response it lists, with that response's sample or a body of the test's
   own. It checks what the step sends, what a transform gives, or whether
   the connection is taken. It's the preview with checks, so it calls
   nothing.
3. **An API test** sends the workflow a request, as its callers do. Each
   step it runs is mocked, answering as above, or live. It checks the
   response (status, headers, body) and what the run did: which steps ran,
   and what each sent and got.
4. **Checks are rows**: a path, a matcher (equals, contains, exists, below)
   and a value, the way QA's tools read, so QA needn't learn JSONata.
   Postman writes `pm.expect(responseJson.name).to.eql("Jane")` and REST
   Assured `body("lotto.lottoId", equalTo(5))` ✓. Any row can be a JSONata
   expression instead. A row becomes JSONata, so every check is evaluated
   one way, through `internal/transform` with its guardrails, which is what
   08 asks of 07: "assertions (JSONata booleans over the output and node
   results)".
5. **A version under test answers at a private URL**, such as
   `/test/{slug}/{revision}`, which only signed-in users can call, while the
   published one keeps `/serve/{slug}`. QA can call it from their own tools
   too.
6. **Results come through the API**, as everything does: run one test or
   all, and get each check's result with what was found. The editor shows
   them, and a CI job can run a suite through the API and fail its build,
   as MUnit, "fully integrated with Maven and Surefire for integration with
   your continuous deployment environment" ✓, and Postman's CLI do.
7. **Publish runs the revision's tests first and refuses if one fails**, as
   it refuses a workflow with problems now, and the failing test opens. A
   workflow with no tests publishes as today.
8. **Which version is live stays in sight.** The workflow list and the
   editor already say which revision is published (`published_revision`);
   a version under test will say so too, with its private URL.

## Decided with you on 2026-10-30

- **After runs**: tests come once plan 04's phase C is built. This
  direction is written first, as 08 was.
- **Three kinds**: unit tests of a step, by API developers; API tests over
  mocks; and live API tests, by QA, who add their own checks.
- **No environments.** Versions are what's tested: v3 serves, and v4 is
  tested at a private URL only we can call.
- **Checks are rows, with JSONata for the rest.** JSONata alone, or an
  expected response to match, were the others.
- **Tests live in the workflow, versioned with it.** A suite beside the
  workflow was the other: QA would edit without making revisions, but a
  test could disagree with the version being published.
- **Publish refuses a version with a failing test.** A warning that lets
  you publish anyway, or tests kept out of Publish, were the others.

## Seams v1 keeps

| Seam | Cost in v1 | Unlocks |
|---|---|---|
| The preview has each step answer with a chosen response, from its sample (`engine.Simulate`, `via`) | built (04, phase D) | unit and mocked API tests are the preview with checks |
| The engine makes its upstream calls in one place | keep it so | a run where some steps answer from mocks: live tests that mock writes |
| Running a revision is separate from which revision is published | keep it so | a private URL for a version under test |
| A run records its revision and its source (editor, served) | built (03) | test runs told apart from callers' |
| Publish refuses through one check of the revision, problems today | keep it so | tests join the gate |
| JSONata is evaluated only through `internal/transform` | already a rule | checks under the same guardrails |
| The definition grows by optional fields, as `sample` and `outputs` did | the habit | `tests` added with no migration of saved revisions |

## Moved here from 04 (2026-11-01, your call)

Left over when the graph editor was finished, and closer to what 07 does
with schemas and samples than to the editor:
- **An expression that reads what its samples lack**, or the wrong type,
  marked under its field: the schema inferred from a sample (04,
  samples) says a path isn't there, and an OpenAPI schema from the
  library can say more.
- **Fetching a sample from a GET**: one call to the step's URL, through
  the SSRF guard, kept as its sample, as a run's response can be.

## Upstreams (accepted 2026-11-02)

Your call on 2026-11-02, asked what "move api to upstream/atomic" meant:
"both steps use saved upstreams making our workflow even cleaner. we
define the handling of that api in there only. but we can add our workflow
created published api to workflow as upstream/step". The roadmap already
calls an upstream "a single API endpoint". Accepted the same day as
drafted, each choice below as recommended: pinned versions with newer ones
offered, steps with their own request kept, a workflow used as a step run
inside the server. On 2026-11-03 you dropped steps with a request of their
own for new work (4 below). Built by 2026-11-03, in the phases under
Steps.

### How it would work

1. **An upstream is one API endpoint, saved once with how it's handled**:
   its method and URL, headers, query and body, each of which can name the
   upstream's own parameters, `{{ user_id }}`; its timeout and retries; the
   responses it handles, by status; and its samples. That's what an HTTP
   step holds today, lifted out, plus a list of parameters.
2. **A step uses an upstream, and keeps only what's the workflow's**: which
   upstream, at which version; an expression for each parameter,
   `user_id: input.user_id`; a line from each response; and what its
   failures do, its Unhandled. The step's blocks are the upstream's
   responses.
3. **Every save of an upstream is a version of its own, never edited**, as a
   workflow's revisions are. A step names the version it uses. When a newer
   one exists, the step offers it, "v3, v4 is out", and taking it is an
   edit like any other: a new revision of the workflow, checked, and
   published when you publish. So a published workflow never changes under
   its callers, and an upstream fixed for one workflow doesn't break
   another.
4. **A published workflow is an upstream too.** Its parameters are its
   input schema's, its responses its answers, and a step pins one of its
   published revisions. It runs inside the server, as a run of its own,
   recorded, in its caller's trace one hop further (plan 06), rather than
   through its `/serve` address, so a definition holds no token to call it.
5. **Workflows using workflows can't form a cycle.** A step can only pin a
   revision that's already published, and revisions never change, so every
   one a step reaches is older than the step's own: a chain of them ends.
   Kestra refuses the same thing outright: "A flow cannot call itself
   directly or indirectly; any cycle makes the flow invalid" ✓. Here it
   can't be built. A loop through an HTTP step or another API is still
   plan 06's to stop.
6. **The library**: a page that lists upstreams, makes one, saves a version,
   and shows which workflows use which version. A step's "Save as
   upstream" moves its request and handling into a new upstream and makes
   the step use it. OpenAPI import fills the library later, as 07 always
   meant.

### What others do

| Tool | A step points at | Which version runs | An edit to the shared thing |
|---|---|---|---|
| Step Functions, a state machine calling another | its ARN | a version (pinned), an alias (movable), or the latest | follows what's named, fixed when the run starts ✓ |
| Zapier, an app's versions | a version | the one the Zap uses; a new one is promoted for new Zaps | nothing, until the Zap is migrated, within one major version ✓ |
| Terraform modules | a source and a version constraint | the newest the constraint allows, kept in a lock file | nothing, until `terraform init -upgrade` ✓ |
| Windmill, a flow step calling a script | a path, and maybe a hash | the hash, if given | the hash: nothing ✓ |
| Kestra subflows | a flow, and maybe a `revision` | "By default, the last" revision ✓ | the next call runs it |
| Power Automate custom connectors | an operation | the one there is | reaches every flow, so a breaking change must be a new operation ✓ |

Terraform's reason, the same as ours: "explicitly constraining the
acceptable version numbers to avoid unexpected or unwanted changes" ✓.
Semantic Versioning's rule for what's released: "the contents of that
version MUST NOT be modified" ✓.

### Decided while drafting, accepted

1. **Pinned, with newer versions offered**, as Step Functions' versions,
   Zapier and Terraform do. Following the latest would let an upstream's
   edit reach every published workflow with no Publish in between, past
   plan 12's checks. A copy in each step, D14 as proposed, is what you
   ruled out: the handling lives in one place.
2. **The handling is the upstream's alone**, as you said: a step can't
   override its timeout, retries or responses. Its Unhandled stays the
   step's, as where failures go is the workflow's choice.
3. **A workflow used as a step runs in the server**, not through `/serve`:
   no token in a definition, and the caps and hop count of plan 06 apply as
   they do to any run.
4. **Upstreams only, from 2026-11-03**, your call, asking whether the
   whole step could move to the upstream, as every status, 2xx too, is the
   upstream's: drafted as keeping both. Publish refuses an HTTP step with a
   request of its own (`own_request`), and Add HTTP step makes an upstream
   from a call in its own dialog. A revision saved or published before
   still runs, never rewritten, and Save as upstream moves its steps into
   the library. What can't move is what each workflow decides: a step's
   id, the values it gives the parameters, where each response and its
   failures lead, and its Unhandled's body, which reads the run. Every tool
   checked keeps a generic HTTP step beside its catalog (sources.md,
   contested).
5. **Secrets in an upstream's headers stay as values**, as in steps today,
   until 06's credentials hold them by reference.

### Steps

Each phase ends with `just check` green, staged for you to commit.

**A. The library.**
- [x] D14 settled in the roadmap.
- [x] Schema: an upstream's version, in `workflow.yaml`: its parameters,
      by name, and a request, responses and samples as an HTTP step has,
      the templates reading the parameters; `just gen`.
- [x] Its checks, tests first: names, and what an HTTP step's own get;
      and that every expression in its request reads only its
      parameters (`unknown_parameter`), as gnata's `ReferencedPaths` says.
- [x] Store: upstreams and their versions, every save a version; the
      migration.
- [x] API: list, make, read, save a version, read a version. A version
      with problems isn't saved (422, `invalid_upstream`), as steps pin it.

**B. Steps that use upstreams.**
- [x] A node `uses` an upstream at a version, `with` a JSONata expression
      for each parameter.
- [x] Before a definition is checked, previewed or run, each such node is
      filled from its version (`workflow.Resolve`, the versions from the
      store in one query), so every check a step gets applies; a version
      that isn't there (`unknown_upstream`), or a parameter unbound
      (`required`) or unknown (`unknown_parameter`), is a problem on the
      node, and so is a request, responses or samples of its own.
- [x] The engine evaluates the bindings over the run, then renders the
      version's request over them, never over the run; previews the same.

Mutation checks for A and B: 40 on the server, 37 caught at first. The
empty-path guard was dead, as gnata reports a read of the whole input as
incomplete, so it went; a malformed If-Match got a test of its words. Left:
skipping the query when no node uses an upstream, which saves a round trip
and changes nothing else.

**C. The editor.** Asked on 2026-11-02, your answers: an upstream is
edited both in place, from a step that uses it, and on its library page;
the library is a page beside Workflows, listing each upstream's versions
and which workflows use which; and Add HTTP step offers the library, a
step without one having its own request, as now.
- [x] The library page: list, make, edit (a new version).
- [x] A step from an upstream; its parameters' expressions; a newer
      version offered on it.
- [x] "Save as upstream": each placeholder of a step's own request becomes
      a parameter bound to what it read.
- [x] The browser test.

As built: the editor fills a step that uses an upstream from its version
as the page opens, and strips it again before the check, a save or a
preview, so it's drawn, previewed and run as any HTTP step while the
server is sent only `uses` and `with`. Its request and responses are
locked, and Edit upstream opens them: the preview takes the upstream as
it stands, keyed by the step's id (`upstreams`), Save upstream makes the
next version, which the step then pins, and the workflow's header waits
until the upstream is saved or discarded. A preview says the values the
parameters take (`parameters`), which the step's body reads, under that
name. Add HTTP step offers the library, and Save as upstream makes each
placeholder a parameter named for the last field it reads. The library
page lists upstreams, makes one from a name and a call, each `{{ name }}`
in its URL a parameter, and edits one in a step's tabs, each parameter
with a sample the preview gives it; Used by says which workflows' latest
revisions use which version, and whether that revision is served.

Walked through in Chromium through nginx, light and dark, with no console
errors, it showed four faults the jsdom tests had passed, each now with a
test: the disabled fieldset disabled the Request row's tabs too, as HTML
disables every control in one ✓; typing a parameter's value closed its
tab, as the store didn't know the part; a locked step's card offered
+ Add; and its body showed the run's input rather than the parameters its
request reads. Reading the code after found a fifth: Keep as the sample,
on a run's answer, wrote a locked step's sample, which saving dropped; it
now says to edit the upstream. The browser test
(`web/e2e/upstreams.spec.ts`) makes an upstream, adds a 404 on its page,
uses it from a step, runs it to 200 and 404, publishes and calls it, edits
it in place, saves another step's request as one, and reads Used by. It
found the Done flow's Save also matching Save as upstream, as Playwright
matches a name as a substring unless told exact ✓.

Mutation checks for C: 37 in the web code, 32 caught at first, and 13 on
the server, 9 caught. Each survivor got a test, and all are caught now:
no Save as upstream on a step that uses one; its 2xx sample locked; the
check sent the draft stripped; a 412 on Save upstream, and an empty name
in Save as upstream, each said; the library's served flag over the API; a
published workflow whose latest revision isn't the one served; an edit
previewed for its own step only; and one sent for a step with a request
of its own ignored.

**C2. Upstreams only** (your call, 2026-11-03).
- [x] Publish refuses an HTTP step with a request of its own
      (`own_request`, at its request); a save, a preview and a run don't,
      so a revision saved or published before still runs.
- [x] Add HTTP step makes a step that uses an upstream: one from the
      library, or New upstream, made from a name and a call whose URL reads
      the run, each placeholder a parameter the step gives what it read.
- [x] The problem shows by Save as upstream, its fix, and the problem list
      takes the cursor there.

As built: the server's tests make upstreams from their fixtures' own
requests, through the API, before they publish, so every serve test runs
the new path; the loop tests publish through the store, as a revision
published before was. A bare `{{ user_id }}` reads nothing of the run, so
New upstream and Save as upstream make it a parameter still to be given a
value. The tour's second stop is a step's call now, and the problem list
names a parameter's problem as one, where it said "Query parameter".
Checked in Chromium through nginx, light and dark, with no console errors,
and in the browser tests: the Done flow builds its four steps with New
upstream, crm's body a parameter added by editing its upstream in place,
and a workflow made through the API with a request of its own is moved to
the library from its problem and published. Mutation checks: 3 on the
server and 17 in the web code, all caught, with tests written first for
the gaps expected (a step with neither a request nor an upstream, the
method kept, what's missing, a 409 and a 422 under their fields).

**C3. Samples where an upstream is made** (your call, 2026-11-03: "let
sample input and output be the part of it too").
- [x] New upstream, in the library and in Add HTTP step, takes a sample
      input, one JSON object for the parameters the URL reads, its keys
      checked against them, as a workflow's sample input is one object;
      and a sample of each response the API can give, as its documentation
      says, its 2xx first, then each status 300 to 599 a step can follow.
- [x] The upstream's page shows its parameters as names, and their samples
      as that one object, applied as it's typed once it fits.

As built: the samples fields are one component, `components/upstream-samples.tsx`,
as two features use them; what's checked is said when the upstream is
made, and cleared by the next change. Stored as before, a sample on each
parameter, so the API didn't change. Recommended first was a sample per
parameter; you leaned to one object, and the better reason is yours: a
workflow's sample input is one, and a workflow is an upstream too.
Mutation checks: 10, all caught once three tests were added (Add HTTP
step's refused sample, a first status of 300, the page keeping its sample
while the text doesn't fit).

**C4. A save that changes nothing makes nothing** (your report,
2026-11-03: "I can just keep saving it and version will start
increasing").
- [x] Save upstream, in a step's panel, waits for a change, as Save
      version on the upstream's page and the workflow's Save do.
- [x] The API makes no version from a save equal to the version it builds
      on, and no revision from a draft equal to its revision: it answers
      that one, as it was. Lambda "doesn't publish a version if the
      function's configuration and code haven't changed" ✓, Step
      Functions' publish "doesn't create a duplicate state machine
      version" ✓, and a Deployment's "new revision is created if and only
      if" its Pod template changes ✓. Agents (plan 08) save through the
      same API, so the button alone wouldn't do.

As built: Postgres compares the two as jsonb, by value, so key order and
spacing don't count, inside the save's transaction; If-Match is checked
first, so a stale base is refused all the same. Mutation checks: 5, all
caught.

**D. Workflows as steps.** Asked on 2026-11-03, your answers: every
published workflow can be used, as n8n's sub-workflows can unless "This
workflow can be called by" says otherwise ✓; a step's parameters are the
input the workflow defines, its input schema's fields, or its sample
input's when it has none, or one, input, when it has neither, as n8n's
inputs are "individual input names and data types that the calling
workflow needs to provide" ✓; previews run the revision a step pins; and
nothing is defined twice: previews take the workflow's own sample input
for a value the step hasn't given, and its answers from its own preview,
while each value starts empty and Publish asks for the required ones.
Drafted too, yours to change: an http step's `uses` names a workflow and
revision, drawn and wired as any step that uses an upstream, its blocks
the workflow's answers; it runs as a recorded run of its own, linked to
its caller, a hop further in its trace and within the workflow's share,
waiting as long as the caller's run has left, as Logic Apps' parent "continues
to wait for a response until all the steps are completed" ✓; it pins only
a published revision, a newer one offered; a workflow can't use itself,
as Kestra refuses ✓; and its line offers Open workflow, not Edit upstream.
- [x] A node uses a revision of another workflow, its input bound; it runs
      as a run of its own, in the caller's trace, and its answer is the
      step's response.
- [x] The editor: Add HTTP step offers the published workflows, but not
      the one being edited, and pins the revision served; the step's line
      names the workflow and revision, offers the one served when it's
      newer, and opens the workflow; its Input tab, in place of Request,
      gives the workflow's input fields values; its blocks are the
      workflow's answers.
- [x] Tests, mutation checks and docs at the end of each phase.

As built: `uses` names an upstream and version or a workflow and revision,
never both. Resolve gives the node the revision's answers besides 2xx as
its responses (`AnswersOf`), and checks its values against the revision's
input fields (`InputOf`): its input schema's, its sample input's, or none
with neither, where the draft said one, input. A workflow that defines no
input reads none, so a step gives it none. The store's `Deps` fetches
versions and revisions in rounds, each revision's own pins in the next,
none asked twice, so it ends even on a draft that uses itself. A workflow
can't reach itself through others at any revision (`uses_itself`), checked
by Publish and by every run: a draft is saved with its problems, so it
can pin a revision not saved yet, and pinning alone doesn't rule a cycle
out. At run time the engine calls the runner through `engine.Caller`. The
runner records a run with trigger `workflow` and its parent's run and
node, a hop further in the caller's trace, within the workflow's share,
on the editor's engine, ending with the caller's run. Its answer is the
step's response; one the step doesn't list fails it. An answer that
passes an error on with no error body gives the step `{code, detail,
node}`. A run that answers nothing fails the step: a timeout, a
cancellation or our bug as they were, the rest `upstream_failed`. A
preview of the step is the revision's own, over the values given and its
sample input for the rest: its 2xx, or, for a line from another of the
step's responses, that answer, aimed at the answer's first line as a
connection's preview aims. It goes as deep as a run: the seventh workflow
down, as a run eight hops in is refused. A mutation check found it went
one deeper. In the editor, `versionKey` is `wf:` and the id for a
workflow, and the store keeps `called`, each revision with its
workflow's name. Checked in Chromium through nginx, light and dark,
desktop and phone, with no console errors. At phone width an open step
panel makes the page 42px wider than the screen, an upstream step's too,
which predates this phase; you put it off until just before page mode
(05). In the browser test, a workflow made through
the API is picked, given its input, reopened, run to a 200 and a 404, and
served. Mutation checks: 24 on the server and 21 in the web code, all
caught once four tests were added (the preview as deep as a run, what a
call's run gives the step, the offered list read while it's open, what
each kind of answer previews as) and two preview bugs were fixed: it went
one workflow deeper than a run does, and an answer from a transform that
picks among answers was previewed at the status aimed at, with the body
of the one picked. It's previewed as picked now, and when the samples
pick another answer than the line aims at, the preview says so. The tests
the coverage floor asked for found the second; the engine is back at its
96%.

**E. Deleting an upstream** (your call, 2026-11-03: "we dont delete
upstream if used by workflow"; asked then, any saved revision counts).
- [x] `DELETE /v1/upstreams/{id}` deletes an upstream and every version
      of it while no saved revision of a workflow, published or not, pins
      one; otherwise it's refused, 409 `upstream_in_use`, naming the
      workflows and their revisions. Step Functions refuses to delete "a
      state machine version currently referenced by one or more aliases"
      ✓, and Zapier a version until "0 users remain", paused Zaps among
      them ✓.
- [x] The upstream's page has Delete, which asks again, then goes back to
      the library, or says which revisions pin it.

As built: any saved revision counts, as every revision saved before still
runs (C2), so an upstream a revision ever pinned stays. The check and the
delete share one transaction, which locks the revisions table against
saves (SHARE), so no revision pins it in between; a test holds a save
open and sees the delete wait for it, then refuse. Its versions go with it
(ON DELETE CASCADE). Mutation checks: 11, 10 caught. The one that survived
drops the library list's refresh after a delete, which nothing can see:
the list fetches again whenever it opens, as after New upstream. The same
day, as you agreed, the editor and the library stopped reaching into each
other's code: the queries both use moved to `lib/`, and the upstream's
page, built from the editor's step parts, into the editor.

**F. A step shows what it owns** (your call, 2026-11-04: "now whole
workflow step ui can be simplified right. if its just upstream"; asked
then, an upstream is no longer edited from a step, which reverses C's
answer of 2026-11-02). Accepted as drafted the same day, a new tab your
pick over this one.

Every new HTTP step uses an upstream (C2), yet its panel still shows what
is the upstream's: its request in five locked tabs, each response's sample
locked, and Edit upstream, Save upstream and Discard to change it from the
step. What a step keeps is 2 above: which upstream at which version, a
value for each parameter, a line from each response, and its Unhandled.
Its panel shows those and opens the upstream for the rest, as a step that
uses a workflow opens the workflow (D). Figma's instances work so with a
library's components: "It's not possible to push overrides to components
in another file, including published libraries"; you "use the Go to main
component action to open the library file" ✓. n8n's Execute Sub-workflow
node picks a workflow and gives it inputs, and its docs describe no way to
edit the workflow from the node ✓.

- [x] The step's line: the upstream's name and version, its call in small
      type, `GET https://users.example.com/v1/users/{{ user_id }}`, Use vN
      when a newer version is out, and Open upstream. Edit upstream, Save
      upstream and Discard go, and so does adding or removing a parameter
      from the step.
- [x] One row of tabs: Parameters, 2xx and each response, Unhandled. The
      Request tab and its row go, as the parameters already preview the
      request they make. The card's request block opens Parameters, as a
      workflow step's opens Input, and what a run sent moves there.
- [x] A response's tab: the sample the step gets, as JSON rather than a
      locked form, and where its lines go.
- [x] The card names the upstream and version under the step's id, as a
      workflow step's names its workflow and revision: plan 11's brief has
      a plain name first and what it calls in small type.
- [x] A problem in the upstream's own fields, which only a version saved
      before a newer check could have, shows on the line, by Open
      upstream.
- [x] The workflow's header stops waiting on an upstream open in place.
- [x] Tests first. The browser tests edit an upstream on its page: the
      Done flow gives crm's upstream its body there, and the library test
      saves version 3 there.
- [x] Mutation checks, CLAUDE.md and this plan, and a walk in Chromium
      through nginx, light and dark, desktop and phone, the PNGs sent.

Unchanged: the upstream's page keeps its editor, built from the same step
parts, and the preview's `upstreams` field, which the page previews
through; a step with a request of its own keeps its form, and Save as
upstream moves it; nothing on the server changes. What goes with editing
in place: keeping a run's answer as the upstream's sample, which a run's
tab offered while the upstream was open. A sample is changed on the
upstream's page, and fetching one there is already planned (Moved here
from 04).

Decided with it:
- **Open upstream opens a new tab**, and so does Open workflow, which the
  link says, as WCAG's G201 asks, since a new tab "can be disorienting"
  ✓. The draft stays where it was. In the same tab, the leave dialog
  offers only Stay or Leave, so a draft would be saved before each trip,
  a revision each time. Back on the workflow's tab, the step offers the
  new version: when a window has focus again and its data is stale,
  TanStack Query "automatically requests fresh data for you in the
  background" ✓.
- The 42px overflow at phone width stays put off (05); the walk says
  whether an upstream step still has it.

As built: a step that uses an upstream or a workflow opens on its
Parameters or Input, as its request block does, and so does a response
part it can't add; what a run sent is at their top. The line's call is in
the code font and wraps rather than widening the panel. The link says
", opens in a new tab" in its name, beside its icon, as the card says
", the response it got". The card takes the upstream's name from the
version the editor fetched as it opened, so it's there at once. A
response's tab reads its sample, body, status and headers, or says to add
one on the upstream's page. A problem in what a step uses shows on the
line (`ofUsed`), and the problem list takes the cursor there: the line can
take focus now, which also fixed the cursor going nowhere for a problem
in `uses`, before. Use vN said nothing when the version didn't come; it
says so now. The upstream's page is the one place an upstream changes, so
its 412 got the test the step's had. Gone with editing in place: Edit
upstream, Save upstream and Discard, the locked Request and its disabled
`fieldset`, + Response on a step that uses one, the header's "Save or
discard the upstream first", and `isLocked`. Headless Chromium keeps
every page visible and fires no `visibilitychange` when another tab
closes, checked first-hand, so the browser tests fire it coming back
(`backFrom`). Mutation checks: 25 in the web code, 21 caught at first;
three tests for the four that survived (a step opened on a response it
can't add, a problem with no field shown once, the line's words cleared
once Use vN works) catch them all.

### Open questions

- Taking a newer version in every workflow at once, as Zapier migrates:
  each would become a new revision, published or not?

## Caller keys (accepted 2026-11-05)

Your call, 2026-11-05: caller keys next, "also add rotate api feature";
asked then, a rotated key's old value works until an expiry you choose,
now or later; several named keys per workflow, one per caller; and
`/serve` takes only keys, never the API token. Accepted as drafted. The roadmap's 07 row has asked for "per-workflow caller
keys" since 2026-10-19.

### Goal

Each published workflow is called with keys of its own, one per caller,
each named, rotated and revoked on its own, and each run says which key
called it. The API token, which can edit, publish and archive every
workflow, never has to leave its holder's hands.

### What's wrong today

`/serve` takes the one API token (`server/internal/httpapi/auth.go:57`).
Every caller of any workflow holds a key to all of Conduit, a leaked one
means changing it for everyone at once, and no run says who called it.

### What others do

Stripe's keys are the model here. Many per account, each for one use:
"Create as many RAKs as you want and assign them to different parts of
your application" ✓. Shown once: "Save the key value. You can't retrieve it
later." ✓ Rotated with a grace period: "both the old and new keys work for
up to 7 days" ✓, or cut off at once: "If you choose **Now**, the old key is
deleted" ✓.

### How it would work

1. **A workflow has caller keys, each named for its caller**, `CRM sync`,
   `Mobile app`. A key is shown once, when it's made. The server keeps only
   its SHA-256 hash and its first characters, `cnd_7f3a…`, to tell it
   apart. A slow hash is for what can be guessed: OWASP's reason for one is
   that it "makes brute‑force attacks significantly more difficult" ✓, and a
   key of 256 random bits leaves nothing to guess. The `cnd_` prefix marks
   it as Conduit's wherever it's pasted.
2. **`/serve/{slug}` takes a key of that workflow** as its bearer token. A
   key of another workflow, a revoked one and one past its expiry are all
   401, alike, so the answer doesn't say which keys exist.
3. **Rotating gives the caller a new key**, shown once, and the old one
   keeps working until the expiry chosen then: now, an hour, a day or 7
   days.
4. **Revoking stops a key at once.** Revoked and expired keys stay listed,
   for audit, and are never deleted.
5. **A run records the key that called it**, by name, and the run view and
   the Runs list say so. A key's last use is its latest run.
6. **Archiving a workflow revokes its keys** (next, in the archive work).
7. **In the editor, a Keys panel** beside Runs: each key's name, its first
   characters, when it was made, last used, and its expiry or revocation;
   New key, Rotate, Revoke.
8. **Through the API**, as everything is: list and make a workflow's keys,
   rotate one with its expiry, revoke one.

### Decided with you

- Several named keys per workflow, one per caller, over one per workflow:
  revoking one caller's key leaves the rest working, and a run names its
  caller.
- `/serve` takes only a workflow's keys: the API token, which can do
  anything, is never handed to a caller. Scripts and tests make a key.

### Steps

**A. The store and the API.** A table of keys, their hashes and expiries,
and each run's key; `/serve` checking a key against its workflow;
list, make, rotate, revoke in `openapi.yaml`. Tests first: a key serves its
workflow and no other; a rotated key's old value works until its expiry
and not after; a revoked key is refused at once.

**B. The editor.** The Keys panel; a new key shown once with Copy; Rotate
with its expiry; Revoke asked again; which key called, on a run.

**C. The rest.** A browser test, mutation checks, docs, a walk in Chromium
through nginx, light and dark, desktop and phone.

### Done means

- A workflow is served with its own key, and another workflow's key is
  refused.
- A rotated key's old value works until its expiry, then is refused; a
  revoked key is refused at once.
- Every served run says which key called it.
- `just check` is green.

### Built (2026-11-05)

All three phases. `/serve/{slug}` takes only a key of that workflow;
`caller_keys` keeps each key's SHA-256 and its first 8 characters, an
expiry once it's rotated and the time it was revoked; and `runs.caller_key`
names the key, one of the run's own workflow's (a foreign key on the key
and the workflow together), on served runs only. The API lists, makes,
rotates and revokes keys under `/v1/workflows/{id}/keys`; a run says
`key {id, name, prefix}`. The editor's Keys panel, beside Runs, lists the
keys that work and, under Stopped, those that don't; New key and Rotate
show a key once, with Copy; Revoke asks again. The Runs list and the run
bar say "called by CRM sync (cnd_7f3a…)".

Decided while building, on your behalf; each can change:
- A key is `cnd_` and 43 letters and digits, 256 random bits as one
  number in base 62. Your call after the lesson, 2026-11-05, over
  base64url, whose `-` is in about half of all keys and stops a
  double-click selecting the key (sources.md). Keys made before keep
  working, as only their hash is checked.
- A refused bearer token is told `error="invalid_token"`, on `/serve`
  and the API, and a request without one isn't, as RFC 6750 asks (your
  call, the same day). Every refused token still gets the same answer.
- A slug with no workflow is the same 401 as a wrong key, so the answer
  doesn't say which workflows exist either. A key of a workflow not yet
  published gets 404, as its holder knows the workflow is there.
- A key's name is 1 to 200 characters, as a workflow's is, and the
  workflow's active keys each have their own. A rotated key and its new
  one share it, told apart by their first characters.
- The server says what state a key is in: active, expiring (rotated, and
  working until its expiry), expired or revoked.
- Only an active key rotates. The old key of a rotation is cut off sooner
  by revoking it; revoking a key revoked already, or past its expiry,
  changes nothing.
- A key's last use is its latest run's start, so a call refused before a
  run starts, for its input or a busy server, isn't one.
- Rotate has no expiry picked to begin with: the button waits for one,
  as stopping a caller now and leaving a leaked key a week both cost.
- Who revoked a key isn't kept yet: v1 has one actor, the token's holder.
  The archive work can keep who did it, for everything at once.

Found on the way:
- The constants' `POST` and `PUT` bodies were never in the shape check's
  table, so their unknown fields were dropped without a word since plan
  06. They're in, and a test now fails for any `POST` or `PUT` route left
  out.
- The Rotate dialog first sat in its key's row. Asked again after a
  rotation, the list changed that row, and the dialog went with it, and
  the new key, before it could be copied. The panel holds the dialog now,
  and a mutation that puts it back in the row is caught.

Checks: 37 mutations of the server's keys (store, migration, runner, API)
and 28 of the editor's, each caught; 8 browser tests, the keys one among
them.

## Open questions (decide when 07 starts)

- At Publish, live tests: run again, require the revision's last live
  result to be green, or leave them out of the gate?
- What a live test may call by default: reads only (GET, HEAD), or
  whatever the test says?
- Whether any saved revision can be under test, or only the newest.
- Where results are kept: the latest per test, or a history; and whether
  CI gets a JUnit XML report.
- Who may add tests, and who may publish, once there's more than one user
  (08's separate permissions).

## Sources

- Step Functions Local, test cases, mocked responses and HybridPath ✓:
  https://docs.aws.amazon.com/step-functions/latest/dg/sfn-local-test-sm-exec.html
- Logic Apps, mock outputs (static results) ✓:
  https://learn.microsoft.com/en-us/azure/logic-apps/testing-framework/test-logic-apps-mock-data-static-results
- MUnit ✓: https://docs.mulesoft.com/munit/latest/
- Postman test scripts ✓:
  https://learning.postman.com/docs/tests-and-scripts/write-scripts/test-scripts/
- Postman test examples ✓:
  https://learning.postman.com/docs/tests-and-scripts/write-scripts/test-examples/
- REST Assured usage ✓: https://github.com/rest-assured/rest-assured/wiki/Usage
- Upstreams (2026-11-02):
  - Step Functions, starting a version or alias ✓:
    https://docs.aws.amazon.com/step-functions/latest/apireference/API_StartExecution.html
  - Zapier, versions and migrating ✓:
    https://docs.zapier.com/platform/manage/versions,
    https://docs.zapier.com/platform/manage/migrate
  - Terraform, module versions ✓:
    https://developer.hashicorp.com/terraform/language/modules/syntax
  - Windmill, a step's script hash ✓:
    https://jsr.io/@windmill/windmill@1.776.0/doc/~/PathScript
  - Kestra, subflows, their revision and cycles ✓:
    https://kestra.io/docs/workflow-components/subflows,
    https://kestra.io/plugins/core/flow/io.kestra.plugin.core.flow.subflow
  - Power Automate, custom connectors' versions ✓:
    https://learn.microsoft.com/en-us/connectors/custom-connectors/operational-versioning
  - Semantic Versioning ✓: https://semver.org/
- A save that changes nothing (2026-11-03):
  - Lambda, PublishVersion ✓:
    https://docs.aws.amazon.com/lambda/latest/api/API_PublishVersion.html
  - Step Functions, PublishStateMachineVersion ✓:
    https://docs.aws.amazon.com/step-functions/latest/apireference/API_PublishStateMachineVersion.html
  - Kubernetes, Deployments' revisions ✓:
    https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
- Deleting what's pinned (2026-11-03):
  - Step Functions, DeleteStateMachineVersion ✓:
    https://docs.aws.amazon.com/step-functions/latest/apireference/API_DeleteStateMachineVersion.html
  - Zapier, deprecate or delete a version ✓:
    https://docs.zapier.com/platform/manage/deprecate
- Workflows as steps (2026-11-03):
  - n8n sub-workflows, their inputs and who may call them ✓:
    https://docs.n8n.io/flow-logic/subworkflows/
  - Logic Apps, nested workflows and the Response action ✓:
    https://learn.microsoft.com/en-us/azure/logic-apps/logic-apps-http-endpoint
- A step shows what it owns (2026-11-04):
  - Figma, editing main components ✓:
    https://help.figma.com/hc/en-us/articles/360038665934
  - n8n, the Execute Sub-workflow node ✓:
    https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflow/
  - WCAG technique G201, warning before a new window ✓:
    https://www.w3.org/WAI/WCAG22/Techniques/general/G201
  - TanStack Query, refetching on window focus ✓:
    https://tanstack.com/query/latest/docs/framework/react/guides/window-focus-refetching
- Caller keys (2026-11-05):
  - Stripe, API keys, rotating them ✓: https://docs.stripe.com/keys
  - OWASP Password Storage Cheat Sheet ✓:
    https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
