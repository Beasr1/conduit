import { expect, test } from "vitest";

import { type Flow, NODE_HEIGHT, toFlow } from "@/features/editor/flow";
import type { components } from "@/gen/schema";

type Definition = components["schemas"]["Definition"];
type NodeKind = components["schemas"]["NodeKind"];

// The roadmap's example: user, then orders and prefs side by side, then crm.
const spec: Definition = {
  nodes: [
    {
      id: "user",
      kind: "http",
      request: { method: "GET", url: "https://users.example.com/v1/users" },
    },
    {
      id: "orders",
      kind: "http",
      request: { method: "GET", url: "https://orders.example.com/v1/orders" },
    },
    {
      id: "prefs",
      kind: "http",
      request: { method: "GET", url: "https://prefs.example.com/v1/prefs" },
    },
    {
      id: "crm",
      kind: "http",
      request: { method: "POST", url: "https://crm.example.com/v1/contacts" },
    },
  ],
  edges: [
    { from: "user", to: "orders" },
    { from: "user", to: "prefs" },
    { from: "orders", to: "crm" },
    { from: "prefs", to: "crm" },
  ],
};

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
    sourceHandle: "out",
    targetHandle: "in",
    data: { index: 0 },
  });
  expect(flow.undrawn).toEqual([]);
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
