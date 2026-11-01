import { expect, test } from "vitest";

import {
  addAnswer,
  joinAnswer,
  removeAnswer,
  removeEdges,
  removeNodes,
  renameNode,
  setStepUnhandled,
  setUnhandled,
  updateCase,
  updateEdge,
  updateNode,
} from "@/features/editor/edits";
import {
  follow,
  type Place,
  placeOf,
  problemsIn,
  say,
  stepPartOf,
} from "@/features/editor/problems";
import type { components } from "@/gen/schema";
import { specExample } from "@/test/fixtures";

type Definition = components["schemas"]["Definition"];

// Every pointer shape the server's checks produce (validate.go, compile.go
// and the request shape check), and the place each one names.
test.each<[string, Place]>([
  ["", { on: "workflow" }],
  ["/nodes", { on: "workflow" }],
  ["/nodes/3", { on: "step", index: 3 }],
  ["/nodes/0/id", { on: "step", index: 0, field: "id" }],
  ["/nodes/2/kind", { on: "step", index: 2, field: "kind" }],
  ["/nodes/1/expr", { on: "step", index: 1, field: "expr" }],
  ["/nodes/0/request", { on: "step", index: 0, field: "request" }],
  ["/nodes/0/request/method", { on: "step", index: 0, field: "method" }],
  ["/nodes/0/request/url", { on: "step", index: 0, field: "url" }],
  ["/nodes/0/request/body", { on: "step", index: 0, field: "body" }],
  ["/nodes/0/request/timeout_ms", { on: "step", index: 0, field: "timeout" }],
  [
    "/nodes/0/request/retry/attempts",
    { on: "step", index: 0, field: "attempts" },
  ],
  [
    "/nodes/0/request/retry/idempotent",
    { on: "step", index: 0, field: "idempotent" },
  ],
  [
    "/nodes/0/request/headers/X Bad",
    { on: "step", index: 0, field: "headers", name: "X Bad" },
  ],
  [
    "/nodes/0/request/headers/a~1b~0c",
    { on: "step", index: 0, field: "headers", name: "a/b~c" },
  ],
  [
    "/nodes/0/request/query/q",
    { on: "step", index: 0, field: "query", name: "q" },
  ],
  ["/nodes/0/request/nope", { on: "step", index: 0, field: "request" }],
  ["/nodes/0/nope", { on: "step", index: 0 }],
  ["/nodes/01/id", { on: "workflow" }],
  ["/edges/3", { on: "connection", index: 3 }],
  ["/edges/2/to", { on: "connection", index: 2 }],
  ["/edges/0/when", { on: "connection", index: 0, field: "when" }],
  ["/edges/1/unhandled", { on: "connection", index: 1, field: "on" }],
  ["/output", { on: "response", field: "output" }],
  ["/output_schema", { on: "response", field: "output_schema" }],
  ["/response/answers", { on: "response", field: "answers" }],
  ["/response/answers/2/from", { on: "response", field: "from", answer: 2 }],
  ["/response/answers/0/on", { on: "response", field: "on", answer: 0 }],
  ["/response/answers/1/unhandled", { on: "response", field: "on", answer: 1 }],
  ["/response/unhandled/body", { on: "response", field: "unhandled" }],
  [
    "/nodes/1/unhandled/body",
    { on: "step", index: 1, field: "unhandled_body" },
  ],
  ["/response/from", { on: "workflow" }],
  ["/nodes/1/switch", { on: "step", index: 1, field: "switch" }],
  [
    "/nodes/1/switch/cases/2/when",
    { on: "step", index: 1, field: "case_when", case: 2 },
  ],
  [
    "/nodes/1/switch/cases/0/status",
    { on: "step", index: 1, field: "case_status", case: 0 },
  ],
  [
    "/nodes/1/switch/cases/0/body",
    { on: "step", index: 1, field: "case_body", case: 0 },
  ],
  ["/nodes/1/switch/cases", { on: "step", index: 1, field: "switch" }],
  [
    "/response/answers/1/status",
    { on: "response", field: "status", answer: 1 },
  ],
  [
    "/response/answers/0/schema",
    { on: "response", field: "schema", answer: 0 },
  ],
  ["/response/answers/01/status", { on: "response", field: "answers" }],
  ["/response", { on: "workflow" }],
  ["/input_schema", { on: "settings", field: "input_schema" }],
  ["/sample_input", { on: "settings", field: "sample_input" }],
  ["/nodes/0/sample", { on: "step", index: 0, field: "sample" }],
  ["/nodes/0/sample/body", { on: "step", index: 0, field: "sample" }],
  ["/nodes/0/sample/headers/X Bad", { on: "step", index: 0, field: "sample" }],
  ["/nodes/0/outputs", { on: "step", index: 0, field: "outputs" }],
  [
    "/nodes/0/outputs/1/status",
    { on: "step", index: 0, field: "outputs", output: 1 },
  ],
  [
    "/nodes/0/outputs/1/sample/body",
    { on: "step", index: 0, field: "sample", output: 1 },
  ],
  ["/edges/0/on", { on: "connection", index: 0, field: "on" }],
  ["/edges/0/unhandled", { on: "connection", index: 0, field: "on" }],
  ["/edges/0/when", { on: "connection", index: 0, field: "when" }],
  ["/edges/0/required", { on: "connection", index: 0, field: "required" }],
  ["/edges/0/to", { on: "connection", index: 0 }],
  ["/ui/positions/user/x", { on: "workflow" }],
])("%j points at %j", (pointer, place) => {
  expect(placeOf(pointer)).toEqual(place);
});

// The part of a step's panel each place is on: user answers 2xx, 409 or 404.
test.each<[string, string]>([
  ["/nodes/0/request/url", "request"],
  ["/nodes/0/request/body", "request"],
  ["/nodes/0/id", "request"],
  ["/nodes/0/sample/body", "2xx"],
  ["/nodes/0/outputs/1/sample/body", "404"],
  ["/nodes/0/outputs/0/status", "409"],
  ["/nodes/0/outputs/5/status", "add"],
  ["/nodes/0/outputs", "add"],
  ["/nodes/0/unhandled/body", "unhandled"],
  ["/edges/0/when", "request"],
])("%j is on the step's %j", (pointer, part) => {
  const draft: Definition = {
    nodes: [
      {
        id: "user",
        kind: "http",
        request: { method: "GET", url: "https://users.example.com" },
        outputs: [{ status: 409 }, { status: 404 }],
      },
    ],
  };
  expect(stepPartOf(placeOf(pointer), draft)).toBe(part);
});

test("a step's problem follows it when an earlier step goes", () => {
  const after = removeNodes(specExample, [0]);
  const crmURL: Place = { on: "step", index: 3, field: "url" };
  expect(follow(crmURL, specExample, after)).toEqual({ ...crmURL, index: 2 });
  // The step it was on is gone.
  expect(
    follow({ on: "step", index: 0, field: "url" }, specExample, after),
  ).toBeUndefined();
});

test("a renamed step loses its problems until the next check", () => {
  const after = renameNode(specExample, 3, "contacts");
  expect(
    follow({ on: "step", index: 3, field: "url" }, specExample, after),
  ).toBeUndefined();
});

test("a connection's problem follows the steps it joins", () => {
  const after = removeEdges(specExample, [0]);
  // user → prefs was edge 1, and is edge 0 now.
  expect(
    follow({ on: "connection", index: 1, field: "when" }, specExample, after),
  ).toEqual({ on: "connection", index: 0, field: "when" });
  expect(
    follow({ on: "connection", index: 0 }, specExample, after),
  ).toBeUndefined();
});

// Two steps can be joined once per output, so a connection is followed by
// the output it leaves from too.
test("a connection's problem follows the output it leaves from", () => {
  const twice: Definition = {
    ...specExample,
    nodes: specExample.nodes.map((n) =>
      n.id === "user" ? { ...n, outputs: [{ status: 404 }] } : n,
    ),
    // user → orders from 2xx and from 404, with the same condition.
    edges: [
      ...(specExample.edges ?? []).map((e, i) =>
        i === 0 ? { ...e, when: "x =" } : e,
      ),
      { from: "user", to: "orders", on: 404, when: "x =" },
    ],
  };
  const after = removeEdges(twice, [0]);
  expect(
    follow({ on: "connection", index: 4, field: "when" }, twice, after),
  ).toEqual({ on: "connection", index: 3, field: "when" });
  // The one from 2xx is gone, and its problem doesn't move to the other.
  expect(
    follow({ on: "connection", index: 0, field: "when" }, twice, after),
  ).toBeUndefined();
});

test("an output's problem goes once that output changes", () => {
  const user = specExample.nodes.findIndex((n) => n.id === "user");
  const listed = updateNode(specExample, user, (n) => ({
    ...n,
    outputs: [{ status: 404 }, { status: 404 }],
  }));
  const second: Place = {
    on: "step",
    index: user,
    field: "outputs",
    output: 1,
  };
  const changed = updateNode(listed, user, (n) => ({
    ...n,
    outputs: [{ status: 404 }, { status: 409 }],
  }));
  expect(follow(second, listed, changed)).toBeUndefined();
  const sampled = updateNode(listed, user, (n) => ({
    ...n,
    outputs: [{ status: 404, sample: { body: null } }, { status: 404 }],
  }));
  expect(follow(second, listed, sampled)).toEqual(second);
});

// A problem is about what was there when the server looked. Once that
// changes, the next check says whether it's still wrong.
test("a problem goes once what it's about changes", () => {
  const crmURL: Place = { on: "step", index: 3, field: "url" };
  const typed = updateNode(specExample, 3, (n) => ({
    ...n,
    request: { method: "POST", url: "https://crm.example.com/v2" },
  }));
  expect(follow(crmURL, specExample, typed)).toBeUndefined();
  // Another field of the same step changing leaves it be.
  const header = updateNode(specExample, 3, (n) => ({
    ...n,
    request: { method: "POST", url: n.request?.url ?? "", headers: { A: "1" } },
  }));
  expect(follow(crmURL, specExample, header)).toEqual(crmURL);

  const when: Place = { on: "connection", index: 0, field: "when" };
  const conditional = updateEdge(specExample, 0, (e) => ({
    ...e,
    when: "x =",
  }));
  const cleared = updateEdge(conditional, 0, (e) => ({
    ...e,
    when: undefined,
  }));
  expect(follow(when, conditional, cleared)).toBeUndefined();

  const output: Place = { on: "response", field: "output" };
  const before = { ...specExample, output: "$sum(" };
  expect(
    follow(output, before, { ...before, output: "$sum(1)" }),
  ).toBeUndefined();
});

test("an answer's problem goes once that answer changes, and its line's once the line moves", () => {
  const answered: Definition = {
    ...specExample,
    response: { answers: [{ status: 200, from: "zz" }, { status: 99 }] },
  };
  const status: Place = { on: "response", field: "status", answer: 1 };
  expect(follow(status, answered, addAnswer(answered, 404))).toEqual(status);
  expect(follow(status, answered, removeAnswer(answered, 1))).toBeUndefined();
  const from: Place = { on: "response", field: "from", answer: 0 };
  expect(follow(from, answered, addAnswer(answered, 404))).toEqual(from);
  expect(
    follow(from, answered, joinAnswer(answered, 0, "crm")),
  ).toBeUndefined();
  // One about the answers as a whole goes once any of them changes.
  const answers: Place = { on: "response", field: "answers" };
  expect(follow(answers, answered, setUnhandled(answered, "1"))).toEqual(
    answers,
  );
  expect(follow(answers, answered, addAnswer(answered, 404))).toBeUndefined();
  // One in a step's Unhandled body, once its body changes.
  const body: Place = { on: "step", index: 0, field: "unhandled_body" };
  const caught = setStepUnhandled(answered, 0, "");
  expect(follow(body, caught, addAnswer(caught, 404))).toEqual(body);
  expect(
    follow(body, caught, setStepUnhandled(caught, 0, "1")),
  ).toBeUndefined();
  // And one in a case, once that case changes.
  const cased: Definition = {
    ...specExample,
    nodes: [
      {
        id: "a",
        kind: "transform",
        switch: {
          cases: [
            { when: "", status: 400 },
            { when: "true", status: 200 },
          ],
        },
      },
    ],
  };
  const when: Place = { on: "step", index: 0, field: "case_when", case: 0 };
  expect(
    follow(
      when,
      cased,
      updateCase(cased, 0, 1, (c) => ({ ...c, body: "1" })),
    ),
  ).toEqual(when);
  expect(
    follow(
      when,
      cased,
      updateCase(cased, 0, 0, (c) => ({ ...c, when: "true" })),
    ),
  ).toBeUndefined();
});

test("the response, the settings and the workflow stay where they are", () => {
  const after = removeNodes(specExample, [0]);
  for (const place of [
    { on: "response", field: "output" },
    { on: "settings", field: "input_schema" },
    { on: "workflow" },
  ] satisfies Place[])
    expect(follow(place, specExample, after)).toEqual(place);
});

// A definition with one of every problem the editor words itself.
const broken: Definition = {
  nodes: [
    { id: "a", kind: "transform", expr: "" },
    { id: "a", kind: "http", request: { method: "GET", url: "" } },
    // A kind the type doesn't allow, as a draft saved through the API can
    // hold.
    { id: "Bad", kind: "weird" as "http" },
  ],
  edges: [
    { from: "a", to: "zz" },
    { from: "a", to: "a" },
    { from: "a", to: "Bad", on: 409 },
  ],
  response: {
    answers: [
      { status: 99, from: "zz", on: 409 },
      { status: 99, from: "a", on: 409 },
      { status: 98, from: "a", unhandled: true },
    ],
  },
};

test.each([
  [
    "/response/answers/0/from",
    "required",
    "Join a step to this answer: drag from the step's point to the answer's.",
  ],
  ["/response/answers/0/from", "unknown_node", "No step has the id “zz”."],
  [
    "/response/answers/0/on",
    "unknown_output",
    "zz has no 409 response. Join this answer from another of its points.",
  ],
  [
    "/response/answers/0/on",
    "not_allowed",
    "A transform step has one point, so its line into an answer names no response.",
  ],
  [
    "/response/answers/1/from",
    "not_allowed",
    "An HTTP step's response is what it got, so each of its responses gives one answer. To pick among several, join a transform step that does.",
  ],
  [
    "/response/answers/2/from",
    "not_allowed",
    "A step's Unhandled has no status to pick an answer with, so it gives one. To pick among several, join a transform step that does.",
  ],
  [
    "/response/answers/2/unhandled",
    "not_allowed",
    "A line leaves from one block: one of the step's responses, or its Unhandled.",
  ],
  [
    "/edges/2/unhandled",
    "not_allowed",
    "A line leaves from one block: one of the step's responses, or its Unhandled.",
  ],
  [
    "/response/answers/1/from",
    "other_status",
    "a's case exits with 409, so its line joins the 409 answer: draw it there instead.",
  ],
  ["/response/answers", "required", "Add an answer: a status the API gives."],
  [
    "/response/unhandled/body",
    "required",
    "Write its body, or use Conduit's problem details instead.",
  ],
  ["/nodes/0/switch/cases/0/when", "required", "Add a condition."],
  ["/nodes/0/switch/cases/0/status", "required", "Give it a status."],
  [
    "/nodes/0/switch/cases",
    "required",
    "Add a case: a step with cases needs one.",
  ],
  [
    "/nodes/0/switch/cases/0/status",
    "invalid_status",
    "A status from 200 to 599.",
  ],
  [
    "/nodes/0/switch",
    "not_allowed",
    "A transform step has an expression or cases, not both.",
  ],
  [
    "/nodes/1/switch",
    "not_allowed",
    "An HTTP step sends a request, and has no cases.",
  ],
  ["/response/answers/0/status", "required", "Give the answer a status."],
  ["/response/answers/0/status", "invalid_status", "A status from 200 to 599."],
  [
    "/response/answers/1/status",
    "duplicate_answer",
    "Another answer already has this status.",
  ],
  [
    "/output",
    "not_allowed",
    "A workflow with a response has no output: the steps joined to its answers give them.",
  ],
  ["/nodes/0/expr", "required", "Add an expression."],
  [
    "/nodes/0/unhandled/body",
    "required",
    "Write its body, or give what the step got instead.",
  ],
  ["/nodes/1/request/url", "required", "Add a URL."],
  ["/nodes/1/id", "duplicate_id", "Another step already has this id."],
  [
    "/nodes/2/id",
    "invalid_id",
    "A lowercase letter, then up to 63 lowercase letters, digits and underscores.",
  ],
  [
    "/nodes/2/kind",
    "invalid_kind",
    "The editor doesn't know steps of the kind “weird”.",
  ],
  ["/edges/0/to", "unknown_node", "No step has the id “zz”."],
  ["/edges/1", "self_edge", "A step can't connect to itself."],
  [
    "/nodes/1/sample/status",
    "invalid_status",
    "A status from 200 to 299: this is the 2xx response.",
  ],
  ["/nodes/1/sample/body", "required", "Add the sample's body; null for none."],
  [
    "/nodes/1/outputs/0/status",
    "invalid_status",
    "A status from 300 to 599: 2xx is every HTTP step's.",
  ],
  ["/nodes/1/outputs/0/status", "required", "Give the response a status."],
  [
    "/nodes/1/outputs/1/status",
    "duplicate_output",
    "This step already has a response for that status.",
  ],
  [
    "/nodes/1/outputs/0/sample/status",
    "not_allowed",
    "A response's sample takes the response's status.",
  ],
  [
    "/nodes/0/outputs",
    "not_allowed",
    "A transform step gives one value, so it has no other responses.",
  ],
  [
    "/edges/2/on",
    "not_allowed",
    "A transform step has no responses for a connection to leave from.",
  ],
  [
    "/edges/2/required",
    "not_allowed",
    "An HTTP step needs every connection into it, so none is marked required: that's for a transform step's.",
  ],
  [
    "/edges/2/on",
    "unknown_output",
    "a has no 409 response. Add one with + Add on the step, or draw the connection from another.",
  ],
  [
    "/nodes/0/sample",
    "not_allowed",
    "A transform step's value comes from its expression, so it has no sample.",
  ],
  [
    "/edges/0",
    "cycle",
    "This connection closes a loop, so a step would wait for itself.",
  ],
  [
    "/nodes/1/request/headers/X Bad",
    "invalid_header_name",
    "“X Bad” can't be a header name: use letters, digits and hyphens.",
  ],
  [
    "/nodes",
    "too_many_nodes",
    "A workflow has at most 200 steps; this one has 3.",
  ],
])("%s, %s: says %j", (pointer, code, said) => {
  expect(say({ pointer, code, detail: "the server's words" }, broken)).toBe(
    said,
  );
});

test("the server's detail stands where it says what went wrong", () => {
  expect(
    say(
      {
        pointer: "/nodes/1/request/url",
        code: "invalid_url",
        detail: "the url must be absolute, http or https, with a host",
      },
      broken,
    ),
  ).toBe("The url must be absolute, http or https, with a host.");
  expect(
    say(
      {
        pointer: "/output",
        code: "invalid_expression",
        detail:
          'JSONata error S0203 at token "EOF": expected a token before end of expression',
      },
      broken,
    ),
  ).toBe(
    'JSONata error S0203 at token "EOF": expected a token before end of expression.',
  );
  expect(
    say({ pointer: "", code: "a_new_code", detail: "something new" }, broken),
  ).toBe("Something new.");
  // A step that can never run keeps its id as it is, and says why.
  expect(
    say(
      {
        pointer: "/nodes/1",
        code: "never_runs",
        detail: "a can never run: it needs b to answer 2xx and 404",
      },
      broken,
    ),
  ).toBe(
    "a can never run: it needs b to answer 2xx and 404. It runs only when every line into it is taken; to run it after whichever comes, join them to a transform first.",
  );
  // A transform never runs only as its required lines can't all come.
  expect(
    say(
      {
        pointer: "/nodes/0",
        code: "never_runs",
        detail: "a can never run: it needs b to answer 2xx and 404",
      },
      broken,
    ),
  ).toBe(
    "a can never run: it needs b to answer 2xx and 404. It runs only when every line into it marked required is taken; to run it after whichever comes, mark none of them required.",
  );
});

// A transform's cases are its exits, each named by its status.
test("a case's problems say what a status as an exit asks of it", () => {
  const of: Definition = {
    nodes: [
      {
        id: "check",
        kind: "transform",
        switch: {
          cases: [
            { when: "true", status: 404 },
            { when: "true", status: 404 },
          ],
        },
      },
      { id: "next", kind: "transform", expr: "1" },
    ],
    edges: [
      { from: "check", to: "next" },
      { from: "check", to: "next", on: 418 },
    ],
    response: { answers: [{ status: 418, from: "check", on: 418 }] },
  };
  const says = (pointer: string, code: string) =>
    say({ pointer, code, detail: "the server's words" }, of);
  expect(says("/nodes/0/switch/cases/1/status", "duplicate_output")).toBe(
    "Another case of this step exits with this status: give this one its own, or join their conditions with or.",
  );
  expect(says("/edges/0/on", "required")).toBe(
    "A line from a step with cases leaves one of them: draw it from a case's point.",
  );
  expect(says("/edges/1/on", "unknown_output")).toBe(
    "check has no case exiting with 418. Add one with + Case on the step, or draw the connection from another.",
  );
  expect(says("/response/answers/0/on", "unknown_output")).toBe(
    "check has no case exiting with 418. Join this answer from another of its points.",
  );
});

// A transform is the kind besides HTTP, its problems as its own.
test.each([
  ["/nodes/0/kind", "required", "Give the step a kind: HTTP or transform."],
  [
    "/nodes/0/request",
    "not_allowed",
    "A transform step has an expression, and sends no request.",
  ],
  [
    "/nodes/0/sample",
    "not_allowed",
    "A transform step's value comes from its expression, so it has no sample.",
  ],
  [
    "/nodes/0/outputs",
    "not_allowed",
    "A transform step gives one value, so it has no other responses.",
  ],
])("a transform's %s, %s: says %j", (pointer, code, said) => {
  const of: Definition = { nodes: [{ id: "t", kind: "transform", expr: "1" }] };
  expect(say({ pointer, code, detail: "the server's words" }, of)).toBe(said);
});

// The schema compiler's report starts with the schema's made-up base URL; the
// line that says what's wrong is further down.
test("a schema problem says what's wrong, not which rule failed", () => {
  const detail = [
    `"https://conduit.invalid/schema.json#" is not valid against metaschema: jsonschema validation failed with 'https://json-schema.org/draft/2020-12/schema#'`,
    "- at '': 'allOf' failed",
    "  - at '/type': 'anyOf' failed",
    "    - at '/type': value must be one of 'array', 'boolean', 'integer', 'null', 'number', 'object', 'string'",
    "    - at '/type': got string, want array",
  ].join("\n");
  expect(
    say({ pointer: "/input_schema", code: "invalid_schema", detail }, broken),
  ).toBe(
    "Not a valid JSON Schema: at /type, value must be one of 'array', 'boolean', 'integer', 'null', 'number', 'object', 'string'.",
  );
  // A report in a shape it doesn't know is shown as it is.
  expect(
    say(
      { pointer: "/input_schema", code: "invalid_schema", detail: "odd" },
      broken,
    ),
  ).toBe("Odd.");
});

test("problems are placed in the draft as it is now, steps first", () => {
  const check = {
    of: specExample,
    problems: [
      { pointer: "/output", code: "invalid_expression", detail: "bad" },
      { pointer: "/nodes/3/request/url", code: "required", detail: "no url" },
      { pointer: "/nodes/0/request/url", code: "required", detail: "no url" },
    ],
  };
  const draft = removeNodes(specExample, [0]);
  const found = problemsIn(check, draft);
  expect(found).toEqual([
    {
      place: { on: "step", index: 2, field: "url" },
      code: "required",
      message: "Add a URL.",
    },
    {
      place: { on: "response", field: "output" },
      code: "invalid_expression",
      message: "Bad.",
    },
  ]);
  // The same check and draft give the same list, so a selector can keep it.
  expect(problemsIn(check, draft)).toBe(found);
});
