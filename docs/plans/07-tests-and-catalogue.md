# 07 — Tests and catalogue (direction)

Status: the test suite is a direction, not scheduled: it comes after plan
04's runs (phase C), and it's written now because it shapes v1, as 08 is.
The rest of 07, the upstream catalogue, OpenAPI import and caller keys, is
planned when 07 starts. Talked through with you on 2026-10-30. ✓ means
checked first-hand on the source.

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
