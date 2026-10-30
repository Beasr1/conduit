import { expect, test } from "vitest";

import {
  type Flow,
  freeSpot,
  NODE_HEIGHT,
  NODE_WIDTH,
  responseCard,
  toFlow,
} from "@/features/editor/flow";
import type { components } from "@/gen/schema";
import { specExample as spec } from "@/test/fixtures";

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
  expect(step([404])).toMatchObject({
    height: NODE_HEIGHT,
    measured: { height: NODE_HEIGHT },
  });
  // Four handles, each 1/5 of the way further down: 24 px apart.
  expect(step([404, 409, 500])).toMatchObject({
    height: 120,
    measured: { height: 120 },
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
  const card = responseCard(nodes);
  expect(card.position).toEqual({ x: 600 + NODE_WIDTH + 80, y: 100 });
  expect(card).toMatchObject({
    draggable: false,
    connectable: false,
    deletable: false,
  });
  expect(responseCard([]).position).toEqual({ x: 0, y: 0 });
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
