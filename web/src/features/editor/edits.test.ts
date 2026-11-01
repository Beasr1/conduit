import { expect, test } from "vitest";

import {
  addAnswer,
  addCase,
  addNode,
  addOutput,
  canConnect,
  canJoin,
  connect,
  joinAnswer,
  joinedTo,
  leaveAnswer,
  mentions,
  move,
  moveCase,
  NODE_ID,
  outputToStep,
  reads,
  refusal,
  removeAnswer,
  removeCase,
  removeEdges,
  removeNodes,
  removeOutput,
  renameNode,
  setAnswerSchema,
  setField,
  setStepUnhandled,
  setUnhandled,
  setCaseStatus,
  toCases,
  updateCase,
  updateEdge,
  updateNode,
} from "@/features/editor/edits";
import { UNHANDLED } from "@/features/editor/flow";
import type { components } from "@/gen/schema";
import { specExample as spec } from "@/test/fixtures";

type Definition = components["schemas"]["Definition"];

test.each([
  ["user", "crm", true],
  ["orders", "prefs", true],
  ["crm", "user", false], // would close a cycle through orders
  ["prefs", "user", false],
  ["user", "user", false], // a node can't be its own parent
  ["user", "orders", false], // already joined
])("connecting %s to %s allowed: %s", (from, to, allowed) => {
  expect(canConnect(spec, from, to)).toBe(allowed);
});

test("connect adds the edge and leaves the draft it was given alone", () => {
  const before = structuredClone(spec);
  const after = connect(spec, "user", "crm");
  expect(after.edges).toContainEqual({ from: "user", to: "crm" });
  expect(spec).toEqual(before);
});

// user answers 2xx or 404, and orders follows the 2xx.
const branched: Definition = {
  ...spec,
  nodes: spec.nodes.map((n) =>
    n.id === "user" ? { ...n, outputs: [{ status: 404 }, { status: 409 }] } : n,
  ),
};

test("two steps are joined once per output", () => {
  expect(canConnect(branched, "user", "orders", 404)).toBe(true);
  const joined = connect(branched, "user", "orders", 404);
  expect(joined.edges).toContainEqual({ from: "user", to: "orders", on: 404 });
  expect(canConnect(joined, "user", "orders", 404)).toBe(false);
  expect(canConnect(joined, "user", "orders")).toBe(false);
});

test("a step's Unhandled is joined as an output of its own", () => {
  // To a step: beside the same step on 2xx, and only once.
  expect(canConnect(branched, "user", "orders", UNHANDLED)).toBe(true);
  const joined = connect(branched, "user", "orders", UNHANDLED);
  expect(joined.edges).toContainEqual({
    from: "user",
    to: "orders",
    unhandled: true,
  });
  expect(canConnect(joined, "user", "orders", UNHANDLED)).toBe(false);
  // To an answer: a transform's picks nothing, so it stays an expression.
  const respond = answering.nodes.length - 1;
  const both = joinAnswer(
    joinAnswer(addAnswer(answering, 500), 0, "respond"),
    2,
    "respond",
    UNHANDLED,
  );
  expect(both.response?.answers?.[2]).toEqual({
    status: 500,
    from: "respond",
    unhandled: true,
  });
  expect(both.nodes[respond]).toEqual(answering.nodes[respond]);
  // Nor does a second answer on it, which validation refuses.
  const twice = joinAnswer(addAnswer(both, 503), 3, "respond", UNHANDLED);
  expect(twice.nodes[respond]).toEqual(answering.nodes[respond]);
  expect(joinedTo(both, "respond")).toEqual([0]);
  expect(joinedTo(both, "respond", UNHANDLED)).toEqual([2]);
  // Leaving it takes the line away.
  expect(leaveAnswer(both, 2).response?.answers?.[2]).toStrictEqual({
    status: 500,
  });
});

test("an output is added at the end, and removed with its connections", () => {
  const user = branched.nodes.findIndex((n) => n.id === "user");
  const added = addOutput(branched, user, 500);
  expect(added.nodes[user]?.outputs?.map((o) => o.status)).toEqual([
    404, 409, 500,
  ]);
  const removed = removeOutput(
    connect(connect(added, "user", "crm", 404), "user", "crm", 409),
    user,
    404,
  );
  expect(removed.nodes[user]?.outputs?.map((o) => o.status)).toEqual([
    409, 500,
  ]);
  expect(removed.edges?.filter((e) => e.from === "user")).toEqual([
    { from: "user", to: "orders" },
    { from: "user", to: "prefs" },
    { from: "user", to: "crm", on: 409 },
  ]);
});

// answering has a 200 and a 404 answer, and no line into either yet.
const answering: Definition = {
  ...branched,
  nodes: [
    ...branched.nodes,
    { id: "respond", kind: "transform", expr: "nodes.crm.body" },
  ],
  response: { answers: [{ status: 200 }, { status: 404 }] },
};

test("each answer takes one line, from one of a step's outputs", () => {
  expect(canJoin(answering, 0)).toBe(true);
  const joined = joinAnswer(answering, 1, "user", 404);
  expect(joined.response?.answers?.[1]).toEqual({
    status: 404,
    from: "user",
    on: 404,
  });
  expect(canJoin(joined, 1)).toBe(false);
  expect(joinedTo(joined, "user", 404)).toEqual([1]);
  expect(joinedTo(joined, "user")).toEqual([]);
  // A line from a step that's gone can be drawn again.
  expect(
    canJoin(
      { ...answering, response: { answers: [{ status: 200, from: "gone" }] } },
      0,
    ),
  ).toBe(true);
  expect(canJoin(answering, 7)).toBe(false);
});

test("a line drawn into an answer that has one is refused, saying from where", () => {
  const joined = joinAnswer(answering, 1, "crm");
  expect(refusal(joined, "orders", 1)).toEqual({ status: 404, from: "crm" });
  // Not the step it's from already, nor an answer free to join.
  expect(refusal(joined, "crm", 1)).toBeUndefined();
  expect(refusal(joined, "orders", 0)).toBeUndefined();
});

test("a transform joined to a second answer picks between them with cases, each answer on its own case's exit", () => {
  const respond = answering.nodes.length - 1;
  const first = joinAnswer(answering, 0, "respond");
  expect(first.nodes[respond]).toEqual(answering.nodes[respond]);
  const second = joinAnswer(first, 1, "respond");
  expect(second.nodes[respond]).toEqual({
    id: "respond",
    kind: "transform",
    switch: {
      cases: [
        { when: "", status: 200, body: "nodes.crm.body" },
        { when: "", status: 404 },
      ],
    },
  });
  expect(second.response?.answers).toEqual([
    { status: 200, from: "respond", on: 200 },
    { status: 404, from: "respond", on: 404 },
  ]);
  // One with cases is joined from an exit, and its cases stay as they are.
  const third = joinAnswer(addAnswer(second, 409), 2, "respond", 404);
  expect(third.nodes[respond]).toEqual(second.nodes[respond]);
  expect(third.response?.answers?.[2]).toEqual({
    status: 409,
    from: "respond",
    on: 404,
  });
});

test("leaving an answer takes its line; the answer stays", () => {
  const joined = joinAnswer(
    setAnswerSchema(answering, 0, { type: "object" }),
    0,
    "crm",
  );
  expect(leaveAnswer(joined, 0).response?.answers?.[0]).toStrictEqual({
    status: 200,
    schema: { type: "object" },
  });
  // Nothing to leave changes nothing.
  expect(leaveAnswer(answering, 0)).toBe(answering);
  expect(leaveAnswer(answering, 9)).toBe(answering);
});

test("answers are added at the end, their schemas set, and removed by place", () => {
  const three = addAnswer(answering, 409);
  expect(three.response?.answers?.map((a) => a.status)).toEqual([
    200, 404, 409,
  ]);
  const typed = setAnswerSchema(three, 1, { type: "object" });
  expect(typed.response?.answers?.[1]).toEqual({
    status: 404,
    schema: { type: "object" },
  });
  expect(setAnswerSchema(typed, 1, { type: "object" })).toBe(typed);
  expect(
    setAnswerSchema(typed, 1, undefined).response?.answers?.[1],
  ).toStrictEqual({ status: 404 });
  expect(removeAnswer(typed, 0).response?.answers).toEqual([
    { status: 404, schema: { type: "object" } },
    { status: 409 },
  ]);
  // A response left with neither an answer nor unhandled goes.
  expect(removeAnswer(addAnswer(spec, 200), 0)).not.toHaveProperty("response");
  expect(
    removeAnswer(setUnhandled(addAnswer(spec, 200), "1"), 0).response,
  ).toEqual({ answers: [], unhandled: { body: "1" } });
});

test("a step's Unhandled body is set, changed and taken away", () => {
  const set = setStepUnhandled(spec, 3, "{ 'down': true }");
  expect(set.nodes[3]?.unhandled).toEqual({ body: "{ 'down': true }" });
  expect(spec.nodes[3]).not.toHaveProperty("unhandled");
  expect(setStepUnhandled(set, 3, "{ 'down': true }")).toBe(set);
  expect(setStepUnhandled(set, 3, undefined).nodes[3]).toEqual(spec.nodes[3]);
  expect(setStepUnhandled(spec, 3, undefined)).toBe(spec);
  expect(setStepUnhandled(spec, 9, "1")).toBe(spec);
});

test("unhandled is set, changed and taken away", () => {
  const set = setUnhandled(spec, "{ 'error': error.detail }");
  expect(set.response).toEqual({
    unhandled: { body: "{ 'error': error.detail }" },
  });
  expect(setUnhandled(set, "{ 'error': error.detail }")).toBe(set);
  expect(setUnhandled(set, undefined)).not.toHaveProperty("response");
  expect(setUnhandled(answering, undefined)).toBe(answering);
});

test("answers' lines go with their step, and with its outputs", () => {
  const user = branched.nodes.findIndex((n) => n.id === "user");
  const joined = joinAnswer(joinAnswer(answering, 1, "user", 404), 0, "user");
  expect(
    renameNode(joined, user, "person").response?.answers?.map((a) => a.from),
  ).toEqual(["person", "person"]);
  expect(removeNodes(joined, [user]).response?.answers).toEqual([
    { status: 200 },
    { status: 404 },
  ]);
  expect(removeOutput(joined, user, 409).response).toEqual(joined.response);
  expect(removeOutput(joined, user, 404).response?.answers).toEqual([
    { status: 200, from: "user" },
    { status: 404 },
  ]);
});

test("a switch's cases are added, changed, moved and removed, their lines going along", () => {
  const respond = answering.nodes.length - 1;
  const cased = toCases(answering, respond, 200);
  expect(cased.nodes[respond]).toEqual({
    id: "respond",
    kind: "transform",
    switch: { cases: [{ when: "", status: 200, body: "nodes.crm.body" }] },
  });
  // A step's lines leave the first case's exit once it has cases.
  const next = connect(answering, "respond", "orders");
  expect(toCases(next, respond, 201).edges?.at(-1)).toEqual({
    from: "respond",
    to: "orders",
    on: 201,
  });
  const two = addCase(addCase(cased, respond, 404, "missing"), respond, 409);
  expect(two.nodes[respond]?.switch?.cases?.[1]).toEqual({
    name: "missing",
    when: "",
    status: 404,
  });
  // A case's status changed takes the lines leaving its exit along; one it
  // has already changes nothing.
  const joined = joinAnswer(two, 1, "respond", 404);
  const renumbered = setCaseStatus(joined, respond, 1, 410);
  expect(renumbered.nodes[respond]?.switch?.cases?.[1]?.status).toBe(410);
  expect(renumbered.response?.answers?.[1]).toEqual({
    status: 404,
    from: "respond",
    on: 410,
  });
  expect(setCaseStatus(joined, respond, 1, 404)).toBe(joined);
  // Removed, a case takes the lines leaving its exit.
  expect(removeCase(renumbered, respond, 1).response?.answers?.[1]).toEqual({
    status: 404,
  });
  const changed = updateCase(two, respond, 2, (c) => ({
    ...c,
    when: "nodes.crm.status = 409",
  }));
  expect(changed.nodes[respond]?.switch?.cases?.slice(1)).toEqual([
    { name: "missing", when: "", status: 404 },
    { when: "nodes.crm.status = 409", status: 409 },
  ]);
  const moved = moveCase(changed, respond, 2, 0);
  expect(moved.nodes[respond]?.switch?.cases?.map((c) => c.status)).toEqual([
    409, 200, 404,
  ]);
  expect(moveCase(changed, respond, 0, 5)).toBe(changed);
  expect(
    removeCase(moved, respond, 0).nodes[respond]?.switch?.cases?.map(
      (c) => c.status,
    ),
  ).toEqual([200, 404]);
  // A step without cases has none to change.
  expect(addCase(answering, respond, 404)).toBe(answering);
});

test("an output moves into a step, respond, joined to the response's one answer, 200", () => {
  const draft: Definition = {
    ...branched,
    output: "{ 'user': nodes.user.body, 'crm': nodes.crm.body }",
    output_schema: { type: "object" },
    ui: { positions: { user: { x: 0, y: 100 }, crm: { x: 600, y: 300 } } },
  };
  const { draft: moved, step } = outputToStep(draft);
  expect(step).toBe("respond");
  expect(moved).not.toHaveProperty("output");
  expect(moved).not.toHaveProperty("output_schema");
  expect(moved.nodes.at(-1)).toEqual({
    id: "respond",
    kind: "transform",
    expr: draft.output,
  });
  // It runs after the 2xx of each step the output reads.
  expect(moved.edges?.slice(draft.edges?.length)).toEqual([
    { from: "user", to: "respond" },
    { from: "crm", to: "respond" },
  ]);
  expect(moved.response).toEqual({
    answers: [{ status: 200, from: "respond", schema: { type: "object" } }],
  });
  // After the rightmost step it reads, level with their middle.
  expect(moved.ui?.positions?.respond).toEqual({ x: 600 + 240 + 80, y: 200 });
  expect(draft).not.toHaveProperty("response");
});

test("an output moves only once, into a step whose id is free", () => {
  expect(outputToStep(spec)).toEqual({ draft: spec });
  const both: Definition = {
    ...spec,
    output: "1",
    response: { answers: [{ status: 200, from: "crm" }] },
  };
  expect(outputToStep(both).draft).toBe(both);
  const taken: Definition = {
    ...spec,
    nodes: [...spec.nodes, { id: "respond", kind: "transform", expr: "1" }],
    output: "nodes.respond.body",
  };
  const { draft, step } = outputToStep(taken);
  expect(step).toBe("respond_2");
  expect(draft.edges?.at(-1)).toEqual({ from: "respond", to: "respond_2" });
  // With nothing placed, the layout places it.
  expect(draft.ui).toBeUndefined();
});

test("a node is added where it was put, at a whole position", () => {
  const after = addNode(
    spec,
    { id: "notify", kind: "transform", expr: "1" },
    { x: 10.4, y: 20.6 },
  );
  expect(after.nodes.at(-1)?.id).toBe("notify");
  expect(after.ui?.positions?.notify).toEqual({ x: 10, y: 21 });
});

test("a drag stores where each node ended up", () => {
  const after = move(spec, {
    user: { x: 5.5, y: -3.2 },
    crm: { x: 900, y: 0 },
  });
  expect(after.ui?.positions).toEqual({
    user: { x: 6, y: -3 },
    crm: { x: 900, y: 0 },
  });
});

test("removing edges goes by their places in the list", () => {
  const after = removeEdges(spec, [0, 3]);
  expect(after.edges).toEqual([
    { from: "user", to: "prefs" },
    { from: "orders", to: "crm" },
  ]);
});

test("removing a node takes its edges and position with it", () => {
  const placed = move(spec, { orders: { x: 1, y: 2 }, crm: { x: 3, y: 4 } });
  const after = removeNodes(placed, [1]); // orders
  expect(after.nodes.map((n) => n.id)).toEqual(["user", "prefs", "crm"]);
  expect(after.edges).toEqual([
    { from: "user", to: "prefs" },
    { from: "prefs", to: "crm" },
  ]);
  expect(after.ui?.positions).toEqual({ crm: { x: 3, y: 4 } });
});

test("removing one of two nodes that share an id keeps the id's edges", () => {
  const draft: Definition = {
    nodes: [
      { id: "a", kind: "transform", expr: "1" },
      { id: "a", kind: "transform", expr: "2" },
      { id: "b", kind: "transform", expr: "3" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "ghost" },
    ],
  };
  const after = removeNodes(draft, [1]);
  expect(after.nodes).toHaveLength(2);
  expect(after.edges).toEqual(draft.edges);
});

test("an update that changes nothing gives back the same draft", () => {
  expect(updateNode(spec, 3, (n) => ({ ...n }))).toBe(spec);
  const after = updateNode(spec, 3, (n) => ({ ...n, id: "contacts" }));
  expect(after.nodes[3]?.id).toBe("contacts");
  expect(spec.nodes[3]?.id).toBe("crm");
});

test("an edge's condition is set in its place; an unchanged edge changes nothing", () => {
  expect(updateEdge(spec, 3, (e) => ({ ...e }))).toBe(spec);
  const after = updateEdge(spec, 3, (e) => ({ ...e, when: "true" }));
  expect(after.edges?.[3]).toEqual({ from: "prefs", to: "crm", when: "true" });
  expect(spec.edges?.[3]?.when).toBeUndefined();
});

test("a workflow field is set, removed, and left alone when it's the same", () => {
  const set = setField(spec, "output", "nodes.crm.body");
  expect(set.output).toBe("nodes.crm.body");
  expect(setField(set, "output", "nodes.crm.body")).toBe(set);
  expect("output" in setField(set, "output", undefined)).toBe(false);
  expect(setField(spec, "input_schema", undefined)).toBe(spec);
});

test("reads names the steps an expression reads, in the definition's order", () => {
  expect(
    reads(spec, '{ "c": nodes.crm.body, "u": nodes.user.body.id }'),
  ).toEqual(["user", "crm"]);
  expect(reads(spec, "nodes.users.body")).toEqual([]);
  expect(reads(spec, undefined)).toEqual([]);
});

test("renaming a node takes its edges and position with it", () => {
  const placed = move(spec, { user: { x: 1, y: 2 } });
  const after = renameNode(placed, 0, "person");
  expect(after.nodes[0]?.id).toBe("person");
  expect(after.edges).toEqual([
    { from: "person", to: "orders" },
    { from: "person", to: "prefs" },
    { from: "orders", to: "crm" },
    { from: "prefs", to: "crm" },
  ]);
  expect(after.ui?.positions).toEqual({ person: { x: 1, y: 2 } });
});

test("renaming one of two nodes that share an id leaves the id's edges", () => {
  const draft: Definition = {
    nodes: [
      { id: "a", kind: "transform", expr: "1" },
      { id: "a", kind: "transform", expr: "2" },
      { id: "b", kind: "transform", expr: "3" },
    ],
    edges: [{ from: "a", to: "b" }],
  };
  const after = renameNode(draft, 1, "c");
  expect(after.nodes.map((n) => n.id)).toEqual(["a", "c", "b"]);
  expect(after.edges).toEqual(draft.edges);
});

test("mentions finds every place that still reads a node by its id", () => {
  const draft: Definition = {
    nodes: [
      {
        id: "crm",
        kind: "http",
        request: {
          method: "POST",
          url: "https://crm.example.com/{{ nodes.user.body.id }}",
          headers: { "X-User": "{{ nodes.user.body.name }}" },
          body: "nodes.users.body",
        },
      },
      { id: "merge", kind: "transform", expr: "nodes.user.body" },
    ],
    edges: [{ from: "crm", to: "merge", when: "nodes.user.status = 200" }],
    output: "nodes.merge.body",
  };
  expect(mentions(draft, "user")).toEqual([
    "crm's URL",
    "crm's headers",
    "merge's expression",
    "the condition on the connection from crm to merge",
  ]);
  expect(mentions(draft, "merge")).toEqual(["the workflow's output"]);
  expect(mentions(draft, "a(b")).toEqual([]);
});

test("mentions finds a step read in cases, and in an Unhandled body", () => {
  const draft: Definition = {
    nodes: [
      {
        id: "check",
        kind: "transform",
        switch: {
          cases: [
            { name: "found", when: "nodes.user.status = 200", status: 200 },
            { when: "true", status: 404, body: "nodes.user.body.error" },
            { when: "true", status: 500, body: "'none'" },
          ],
        },
        unhandled: { body: "{ 'id': nodes.user.body.id }" },
      },
    ],
    response: {
      answers: [{ status: 200, from: "check", on: 200 }],
      unhandled: { body: "nodes.user.body" },
    },
  };
  expect(mentions(draft, "user")).toEqual([
    "check's case found",
    "check's Case 2",
    "check's Unhandled body",
    "the response's Unhandled body",
  ]);
});

test.each([
  ["fetch_user", true],
  ["a", true],
  ["Fetch", false],
  ["1st", false],
  ["has-dash", false],
  ["", false],
])("%j is a node id: %s", (id, ok) => {
  expect(NODE_ID.test(id)).toBe(ok);
});
