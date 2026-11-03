import { expect, test } from "vitest";

import {
  answersOf,
  asUpstream,
  fill,
  inputOf,
  pin,
  pinCalled,
  strip,
  upstreamOf,
  versionKey,
} from "@/features/editor/upstreams";
import type { components } from "@/gen/schema";

type Definition = components["schemas"]["Definition"];
type Upstream = components["schemas"]["Upstream"];

const users: Upstream = {
  parameters: [{ name: "user_id" }],
  request: {
    method: "GET",
    url: "https://users.example.com/v1/users/{{ user_id }}",
  },
  outputs: [{ status: 404 }],
  sample: { body: { id: "7" } },
};

const using: Definition = {
  nodes: [
    {
      id: "user",
      kind: "http",
      uses: { upstream: "u-1", version: 2 },
      with: { user_id: "input.user_id" },
      unhandled: { fail: true },
    },
    { id: "greet", kind: "transform", expr: "'hi'" },
  ],
};

// A node that uses an upstream is drawn and edited as any HTTP step, from its
// version, as the server fills it (plan 07); saved, it's stripped again.
test("fill gives a node its version's request, responses and samples, and strip takes them back", () => {
  const versions = { [versionKey({ upstream: "u-1", version: 2 })]: users };
  const filled = fill(using, versions);
  expect(filled.nodes[0]).toEqual({
    ...using.nodes[0],
    request: users.request,
    outputs: users.outputs,
    sample: users.sample,
  });
  expect(filled.nodes[1]).toBe(using.nodes[1]);
  expect(strip(filled)).toEqual(using);
  // A version the editor hasn't got leaves the node as it is, and nothing
  // to strip leaves the definition itself.
  expect(fill(using, {})).toBe(using);
  expect(strip(using)).toBe(using);
});

test("upstreamOf is a node's upstream as it stands, with its parameters", () => {
  const filled = fill(using, { "u-1@2": users });
  expect(
    upstreamOf(filled.nodes[0]!, [{ name: "user_id" }, { name: "page" }]),
  ).toEqual({ ...users, parameters: [{ name: "user_id" }, { name: "page" }] });
});

// Save as upstream: each placeholder of a step's own request becomes a
// parameter named for what it reads, and the step gives it that; a body
// becomes a parameter too.
test("asUpstream makes a step's own request an upstream with parameters", () => {
  const { upstream, with: given } = asUpstream({
    id: "crm",
    kind: "http",
    request: {
      method: "POST",
      url: "https://crm.example.com/v1/users/{{ nodes.user.body.id }}/notes?x={{ input.x }}",
      headers: { "X-Who": "{{nodes.user.body.id}}", "X-Any": "plain" },
      query: { page: "{{ input.page + 1 }}", id: "{{ input.id }}" },
      body: "{ 'email': nodes.user.body.email }",
      timeout_ms: 5000,
    },
    outputs: [{ status: 409 }],
    sample: { body: null },
    unhandled: { fail: true },
  });
  expect(upstream).toEqual({
    parameters: [
      { name: "id" },
      { name: "x" },
      { name: "value" },
      { name: "id_2" },
      { name: "body" },
    ],
    request: {
      method: "POST",
      url: "https://crm.example.com/v1/users/{{ id }}/notes?x={{ x }}",
      headers: { "X-Who": "{{ id }}", "X-Any": "plain" },
      query: { page: "{{ value }}", id: "{{ id_2 }}" },
      body: "body",
      timeout_ms: 5000,
    },
    outputs: [{ status: 409 }],
    sample: { body: null },
  });
  expect(given).toEqual({
    id: "nodes.user.body.id",
    x: "input.x",
    value: "input.page + 1",
    id_2: "input.id",
    body: "{ 'email': nodes.user.body.email }",
  });
});

// A bare name reads nothing of the run, so it's a parameter still to be
// given a value, and a path that ends in the same name is another one.
test("asUpstream makes a bare name a parameter with no value yet", () => {
  const { upstream, with: given } = asUpstream({
    id: "user",
    kind: "http",
    request: {
      method: "GET",
      url: "https://users.example.com/v1/{{ user_id }}/{{ input.user_id }}?all={{ input }}&steps={{ nodes }}",
    },
  });
  expect(upstream.parameters).toEqual([
    { name: "user_id" },
    { name: "user_id_2" },
    { name: "input" },
    { name: "nodes" },
  ]);
  expect(upstream.request.url).toBe(
    "https://users.example.com/v1/{{ user_id }}/{{ user_id_2 }}?all={{ input }}&steps={{ nodes }}",
  );
  expect(given).toEqual({
    user_id_2: "input.user_id",
    input: "input",
    nodes: "nodes",
  });
});

// Taking another version of an upstream fills the step from it, and keeps
// the values of the parameters it still has.
test("pin moves a step to a version, keeping what it gives the parameters still there", () => {
  const v3: Upstream = {
    parameters: [{ name: "user_id" }, { name: "fields" }],
    request: {
      method: "GET",
      url: "https://users.example.com/v3/{{ user_id }}",
    },
    outputs: [{ status: 410 }],
  };
  const node = fill(using, { "u-1@2": users }).nodes[0]!;
  expect(
    pin(
      { ...node, with: { user_id: "input.id", page: "1" } },
      { upstream: "u-1", version: 3 },
      v3,
    ),
  ).toEqual({
    id: "user",
    kind: "http",
    uses: { upstream: "u-1", version: 3 },
    with: { user_id: "input.id" },
    unhandled: { fail: true },
    request: v3.request,
    outputs: v3.outputs,
  });
});

// greeter is a workflow that takes a user_id, required, and fields, and
// answers 404 and 502 besides 200, 404 from two places.
const greeter: Definition = {
  nodes: [],
  input_schema: {
    type: "object",
    properties: { user_id: { type: "string" }, fields: { type: "string" } },
    required: ["user_id"],
  },
  sample_input: { user_id: "1" },
  response: {
    answers: [
      { status: 404, lines: [{ from: "a", on: 404 }] },
      { status: 200, lines: [{ from: "a" }] },
      { status: 502, lines: [{ from: "a", unhandled: true }] },
      { status: 404, lines: [{ from: "b", on: 404 }] },
    ],
  },
};

// A step that uses a workflow gives values to the fields of its input and
// answers through the workflow's answers, as the server has them (plan 07).
test("inputOf is a workflow's input fields, and answersOf its answers besides 2xx", () => {
  expect(inputOf(greeter)).toEqual({
    fields: ["fields", "user_id"],
    required: new Set(["user_id"]),
  });
  // With no input schema, its sample input's fields; with neither, none.
  expect(inputOf({ nodes: [], sample_input: { b: 1, a: 2 } })).toEqual({
    fields: ["a", "b"],
    required: new Set(),
  });
  expect(inputOf({ nodes: [], sample_input: [1] })).toEqual({
    fields: [],
    required: new Set(),
  });
  expect(answersOf(greeter)).toEqual([{ status: 404 }, { status: 502 }]);
  expect(
    answersOf({
      nodes: [],
      response: { answers: [{ status: 200, lines: [{ from: "a" }] }] },
    }),
  ).toBeUndefined();
});

test("fill gives a node that uses a workflow its answers, and pinCalled moves it to another revision", () => {
  const calling: Definition = {
    nodes: [
      {
        id: "greet",
        kind: "http",
        uses: { workflow: "w-1", revision: 1 },
        with: { user_id: "input.id", page: "1" },
      },
    ],
  };
  const key = versionKey({ workflow: "w-1", revision: 1 });
  expect(key).toBe("wf:w-1@1");
  const filled = fill(
    calling,
    {},
    { [key]: { name: "Greeter", published: 1, definition: greeter } },
  );
  expect(filled.nodes[0]).toEqual({
    ...calling.nodes[0],
    outputs: [{ status: 404 }, { status: 502 }],
  });
  expect(strip(filled)).toEqual(calling);
  // A revision the editor hasn't got leaves the node as it is.
  expect(fill(calling, {})).toBe(calling);

  // Moved, it keeps the values of the fields it still takes.
  const r2: Definition = {
    nodes: [],
    input_schema: { properties: { user_id: {} } },
  };
  expect(
    pinCalled(
      filled.nodes[0]!,
      { workflow: "w-1", revision: 2 },
      { name: "Greeter", published: 2, definition: r2 },
    ),
  ).toEqual({
    id: "greet",
    kind: "http",
    uses: { workflow: "w-1", revision: 2 },
    with: { user_id: "input.id" },
  });
});
