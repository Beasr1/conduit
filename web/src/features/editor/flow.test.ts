import { expect, test } from "vitest";

import {
  exitsOf,
  type Flow,
  freeSpot,
  lineFrom,
  NODE_HEIGHT,
  NODE_WIDTH,
  onOf,
  outputOf,
  responseCard,
  toFlow,
  UNHANDLED,
  wayLabel,
  waysInto,
} from "@/features/editor/flow";
import type { components } from "@/gen/schema";
import { specExample as spec } from "@/test/fixtures";

type Definition = components["schemas"]["Definition"];
type NodeKind = components["schemas"]["NodeKind"];

function at(flow: Flow, id: string) {
  const node = flow.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node.position;
}

test("a definition without positions is laid out left to right", () => {
  const flow = toFlow(spec);
  expect(at(flow, "user").x).toBeLessThan(at(flow, "orders").x);
  expect(at(flow, "orders").x).toBe(at(flow, "prefs").x);
  expect(at(flow, "orders").y).not.toBe(at(flow, "prefs").y);
  expect(at(flow, "crm").x).toBeGreaterThan(at(flow, "orders").x);
});

test("stored positions are used as they are", () => {
  const flow = toFlow({
    ...spec,
    ui: {
      positions: {
        user: { x: 10, y: 20 },
        orders: { x: 300, y: 0 },
        prefs: { x: 300, y: 200.5 },
        crm: { x: 600, y: 100 },
      },
    },
  });
  expect(at(flow, "user")).toEqual({ x: 10, y: 20 });
  expect(at(flow, "prefs")).toEqual({ x: 300, y: 200.5 });
});

test("a node without a position goes below the ones that have one", () => {
  const flow = toFlow({
    ...spec,
    ui: {
      positions: {
        user: { x: 0, y: 0 },
        orders: { x: 300, y: 0 },
        prefs: { x: 300, y: 200 },
      },
    },
  });
  expect(at(flow, "crm").y).toBeGreaterThanOrEqual(200 + NODE_HEIGHT);
});

test("the same definition always gives the same picture", () => {
  expect(toFlow(spec)).toEqual(toFlow(spec));
});

test("each node and edge is drawn, joined at named handles", () => {
  const flow = toFlow(spec);
  expect(flow.nodes.map((n) => [n.id, n.type, n.data.index])).toEqual([
    ["user", "http", 0],
    ["orders", "http", 1],
    ["prefs", "http", 2],
    ["crm", "http", 3],
  ]);
  expect(flow.edges[0]).toEqual({
    id: "user->orders",
    source: "user",
    target: "orders",
    sourceHandle: "2xx",
    targetHandle: "in",
    data: { index: 0 },
  });
  expect(flow.undrawn).toEqual([]);
});

test("a connection leaves from its output's handle, if its step has that output", () => {
  const flow = toFlow({
    nodes: [
      {
        id: "user",
        kind: "http",
        request: { method: "GET", url: "https://users.example.com/v1" },
        outputs: [{ status: 404 }],
      },
      { id: "create", kind: "transform", expr: "1" },
      { id: "log", kind: "transform", expr: "2" },
    ],
    edges: [
      { from: "user", to: "create", on: 404 },
      { from: "user", to: "log" },
      { from: "create", to: "log" },
      { from: "user", to: "log", on: 409 }, // user has no 409 output
      { from: "create", to: "log", on: 404 }, // a transform has one output
    ],
  });
  expect(flow.edges.map((e) => [e.id, e.sourceHandle])).toEqual([
    ["user->create", "404"],
    ["user->log", "2xx"],
    ["create->log", "out"],
  ]);
  expect(flow.undrawn).toEqual([3, 4]);
});

test("a step grows to fit its outputs, a handle at least 24 px from the next", () => {
  const step = (statuses: number[]) =>
    toFlow({
      nodes: [
        {
          id: "user",
          kind: "http",
          request: { method: "GET", url: "https://users.example.com/v1" },
          outputs: statuses.map((status) => ({ status })),
        },
      ],
    }).nodes[0];
  // The Unhandled strip runs along the bottom, 24 px tall.
  expect(step([404])).toMatchObject({
    height: NODE_HEIGHT + 24,
    measured: { height: NODE_HEIGHT + 24 },
  });
  // Four handles above it, each 1/5 of the way further down: 24 px apart.
  expect(step([404, 409, 500])).toMatchObject({
    height: 144,
    measured: { height: 144 },
  });
});

test("a connection with a condition is labelled", () => {
  const flow = toFlow({
    ...spec,
    edges: [{ from: "user", to: "orders", when: "nodes.user.status = 200" }],
  });
  expect(flow.edges[0]?.label).toBe("if");
  expect(toFlow(spec).edges[0]).not.toHaveProperty("label");
});

test("the response card goes after the rightmost step, level with the middle", () => {
  const { nodes } = toFlow({
    ...spec,
    ui: {
      positions: {
        user: { x: 0, y: 100 },
        orders: { x: 300, y: 0 },
        prefs: { x: 300, y: 200 },
        crm: { x: 600, y: 100 },
      },
    },
  });
  const card = responseCard(nodes, 1);
  expect(card.position).toEqual({ x: 600 + NODE_WIDTH + 80, y: 100 });
  // A line can be drawn into it, though it can't be moved or deleted.
  expect(card).toMatchObject({
    draggable: false,
    deletable: false,
    height: NODE_HEIGHT + 24,
  });
  expect(card.connectable).not.toBe(false);
  // It grows to fit its answers and + Add, 24 px apiece, above its
  // Unhandled strip.
  expect(responseCard(nodes, 3).height).toBe(120);
  expect(responseCard([], 0).position).toEqual({ x: 0, y: 0 });
});

test("each answer's line leaves from its step, on its output, into the answer's point", () => {
  const branched = {
    ...spec,
    nodes: spec.nodes.map((n) =>
      n.id === "user" ? { ...n, outputs: [{ status: 404 }] } : n,
    ),
  };
  const line = (k: number, source: string, sourceHandle: string) => ({
    id: `${source}->#response:${k}`,
    source,
    target: "#response",
    sourceHandle,
    targetHandle: String(k),
    data: { index: -1, answer: k },
  });
  const flow = toFlow({
    ...branched,
    response: {
      answers: [
        { status: 200, from: "crm" },
        { status: 404, from: "user", on: 404 },
        { status: 409 },
      ],
    },
  });
  expect(flow.edges.slice(-2)).toEqual([
    line(0, "crm", "2xx"),
    line(1, "user", "404"),
  ]);
  expect(flow.undrawn).toEqual([]);
  // A transform's leaves from its one point.
  expect(
    toFlow({
      nodes: [{ id: "a", kind: "transform", expr: "1" }],
      response: { answers: [{ status: 200, from: "a" }] },
    }).edges,
  ).toEqual([line(0, "a", "out")]);
  // They don't move a step, and none is drawn from a step that isn't there,
  // or on a response its step doesn't have.
  const answers = (from: string, on?: number) => ({
    answers: [{ status: 200, from, on }],
  });
  expect(toFlow({ ...spec, response: answers("crm") }).nodes).toEqual(
    toFlow(spec).nodes,
  );
  for (const response of [answers("gone"), answers("crm", 404)])
    expect(toFlow({ ...spec, response }).edges).toEqual(toFlow(spec).edges);
});

test("a line from a step's Unhandled leaves from its strip", () => {
  const flow = toFlow({
    nodes: [
      ...spec.nodes,
      { id: "fallback", kind: "transform", expr: "1" },
      // The API stores any string as a kind, and an unknown one has no strip.
      { id: "odd", kind: "nonsense" as NodeKind },
    ],
    edges: [
      { from: "user", to: "fallback", unhandled: true },
      { from: "user", to: "fallback" },
      { from: "odd", to: "fallback", unhandled: true },
    ],
    response: {
      answers: [
        { status: 200, from: "fallback" },
        { status: 500, from: "fallback", unhandled: true },
      ],
    },
  });
  expect(flow.edges.map((e) => `${e.id} ${e.sourceHandle ?? ""}`)).toEqual([
    "user->fallback unhandled",
    "user->fallback#1 2xx",
    "fallback->#response:0 out",
    "fallback->#response:1 unhandled",
  ]);
  expect(flow.undrawn).toEqual([2]);
});

test("lines into a transform with more than one come to its one point, dashed, as each may not come", () => {
  const flow = toFlow({
    nodes: [
      {
        id: "prefs",
        kind: "http",
        request: { method: "GET", url: "https://prefs.example.com/v1" },
        outputs: [{ status: 400 }],
      },
      { id: "fallback", kind: "transform", expr: "1" },
      { id: "prefs_ok", kind: "transform", expr: "1" },
      { id: "greet", kind: "transform", expr: "2" },
    ],
    edges: [
      { from: "prefs", to: "prefs_ok" },
      { from: "prefs", to: "fallback", on: 400 },
      { from: "fallback", to: "prefs_ok" },
      { from: "fallback", to: "prefs_ok", unhandled: true },
      { from: "prefs_ok", to: "greet" },
    ],
  });
  expect(
    flow.edges.map(
      (e) =>
        `${e.id} ${e.sourceHandle} ${e.targetHandle}${e.data?.way ? " way" : ""}`,
    ),
  ).toEqual([
    "prefs->prefs_ok 2xx in way",
    "prefs->fallback 400 in",
    "fallback->prefs_ok out in way",
    "fallback->prefs_ok#1 unhandled in way",
    "prefs_ok->greet out in",
  ]);
  // A line marked required has to come, so it isn't dashed; those beside it
  // still may not.
  expect(
    toFlow({
      nodes: [
        { id: "a", kind: "transform", expr: "1" },
        { id: "b", kind: "transform", expr: "2" },
        { id: "t", kind: "transform", expr: "3" },
      ],
      edges: [
        { from: "a", to: "t", required: true },
        { from: "b", to: "t" },
      ],
    }).edges.map((e) => e.data?.way ?? false),
  ).toEqual([false, true]);
  // A step of a kind the editor doesn't know needs every line, as far as
  // the canvas can tell.
  expect(
    toFlow({
      nodes: [
        { id: "a", kind: "transform", expr: "1" },
        { id: "b", kind: "transform", expr: "2" },
        { id: "gone", kind: "merge" as NodeKind, expr: "3" },
      ],
      edges: [
        { from: "a", to: "gone" },
        { from: "b", to: "gone" },
      ],
    }).edges.map((e) => e.data?.way ?? false),
  ).toEqual([false, false]);
  // It's drawn as a transform is, however many lines come into it.
  expect(flow.nodes.find((n) => n.id === "prefs_ok")).toMatchObject({
    type: "transform",
    height: NODE_HEIGHT + 24,
  });
  expect(
    waysInto(
      {
        nodes: [],
        edges: [
          { from: "a", to: "e", on: 404 },
          { from: "a", to: "b" },
          { from: "b", to: "e", unhandled: true },
        ],
      },
      "e",
    ),
  ).toEqual([
    { index: 0, from: "a", on: 404 },
    { index: 2, from: "b", on: UNHANDLED },
  ]);
});

test("a transform with cases has an exit per case, its lines leaving each by its status", () => {
  const flow = toFlow({
    nodes: [
      {
        id: "check",
        kind: "transform",
        switch: {
          cases: [
            { name: "found", when: "true", status: 200 },
            { when: "false", status: 404 },
          ],
        },
      },
      { id: "next", kind: "transform", expr: "1" },
    ],
    edges: [
      { from: "check", to: "next", on: 200 },
      { from: "check", to: "next", on: 404 },
      // One naming no case can't be drawn.
      { from: "check", to: "next" },
    ],
  });
  expect(flow.edges.map((e) => `${e.id} ${e.sourceHandle}`)).toEqual([
    "check->next 200",
    "check->next#1 404",
  ]);
  expect(flow.undrawn).toEqual([2]);
  // Its exits, then + Case, 24 px apiece, above its Unhandled strip.
  expect(flow.nodes[0]).toMatchObject({ height: NODE_HEIGHT + 24 });
  expect(exitsOf(undefined)).toEqual([]);
});

test("a way is named by its step and the response, case or Unhandled it leaves", () => {
  const of: Definition = {
    nodes: [
      {
        id: "user",
        kind: "http",
        request: { method: "GET", url: "https://users.example.com/v1" },
      },
      {
        id: "check",
        kind: "transform",
        switch: {
          cases: [
            { name: "found", when: "true", status: 200 },
            { when: "false", status: 404 },
          ],
        },
      },
      { id: "count", kind: "transform", expr: "1" },
    ],
  };
  expect(wayLabel(of, "user", undefined)).toBe("user · 2xx");
  expect(wayLabel(of, "user", 404)).toBe("user · 404");
  expect(wayLabel(of, "user", UNHANDLED)).toBe("user · Unhandled");
  expect(wayLabel(of, "check", 200)).toBe("check · found");
  expect(wayLabel(of, "check", 404)).toBe("check · Case 2");
  // A transform's one value, and a case no longer there, need no name.
  expect(wayLabel(of, "count", undefined)).toBe("count");
  expect(wayLabel(of, "check", 500)).toBe("check");
});

test("the editor counts Unhandled beside a step's other outputs", () => {
  expect(onOf("unhandled")).toBe(UNHANDLED);
  expect(onOf("404")).toBe(404);
  expect(onOf("2xx")).toBeUndefined();
  expect(outputOf({ on: 404 })).toBe(404);
  expect(outputOf({ unhandled: true })).toBe(UNHANDLED);
  expect(outputOf({})).toBeUndefined();
  expect(lineFrom(UNHANDLED)).toEqual({ unhandled: true });
  expect(lineFrom(404)).toEqual({ on: 404 });
  expect(lineFrom(undefined)).toEqual({});
});

test("a draft saved with problems still draws", () => {
  const flow = toFlow({
    nodes: [
      { id: "a", kind: "transform", expr: "1" },
      { id: "a", kind: "transform", expr: "2" },
      { id: "", kind: "transform", expr: "3" },
      // The API stores any string as a kind, and validation reports it.
      { id: "b", kind: "nonsense" as NodeKind, expr: "4" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "a", to: "b" },
      { from: "a", to: "ghost" },
      { from: "b", to: "b" },
    ],
  });
  expect(flow.nodes.map((n) => n.id)).toEqual(["a", "a#1", "#2", "b"]);
  expect(flow.nodes[3]?.type).toBe("unknown");
  // It has no Unhandled strip, so nothing for it to grow by.
  expect(flow.nodes[3]?.height).toBe(NODE_HEIGHT);
  expect(flow.edges.map((e) => e.id)).toEqual(["a->b", "a->b#1", "b->b"]);
  expect(flow.undrawn).toEqual([2]);
});

test("a cycle still lays out", () => {
  const flow = toFlow({
    nodes: [
      { id: "a", kind: "transform", expr: "1" },
      { id: "b", kind: "transform", expr: "2" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "a" },
    ],
  });
  expect(at(flow, "a")).not.toEqual(at(flow, "b"));
});

test("a new node goes below the middle until it covers no other", () => {
  const placed = [
    { x: 0, y: 0 },
    { x: 0, y: NODE_HEIGHT + 24 },
  ];
  // On top of both, it moves down past them.
  expect(freeSpot({ x: 10, y: 10 }, placed)).toEqual({
    x: 10,
    y: 10 + 2 * (NODE_HEIGHT + 24),
  });
  // Clear of them, it stays.
  expect(freeSpot({ x: NODE_WIDTH + 24, y: 0 }, placed)).toEqual({
    x: NODE_WIDTH + 24,
    y: 0,
  });
});
