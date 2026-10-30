import { expect, test } from "vitest";

import {
  removeEdges,
  removeNodes,
  renameNode,
  updateEdge,
  updateNode,
} from "@/features/editor/edits";
import {
  follow,
  type Place,
  placeOf,
  problemsIn,
  say,
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
  ["/output", { on: "response", field: "output" }],
  ["/output_schema", { on: "response", field: "output_schema" }],
  ["/input_schema", { on: "settings", field: "input_schema" }],
  ["/ui/positions/user/x", { on: "workflow" }],
])("%j points at %j", (pointer, place) => {
  expect(placeOf(pointer)).toEqual(place);
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
  ],
};

test.each([
  ["/nodes/0/expr", "required", "Add an expression."],
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
