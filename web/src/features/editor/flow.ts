import {
  type EdgeLabel,
  Graph,
  type GraphLabel,
  layout,
  type NodeLabel,
} from "@dagrejs/dagre";
import type { Edge, Node, XYPosition } from "@xyflow/react";

import type { components } from "@/gen/schema";

type Definition = components["schemas"]["Definition"];

// Every node is drawn at this size, so placing nodes and drawing them agree.
export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 72;

// A node component finds what to draw through data.index, its place in
// definition.nodes, and an edge's panel through its place in
// definition.edges.
export type FlowNode = Node<
  { index: number },
  "http" | "transform" | "unknown"
>;
export type FlowEdge = Edge<{ index: number }>;

export interface Flow {
  nodes: FlowNode[];
  edges: FlowEdge[];
  // Edges the canvas can't draw, because an end names no node: their
  // places in definition.edges.
  undrawn: number[];
}

// toFlow is the canvas's view of a definition: a node for each node, an edge
// for each edge it can draw, each where the definition places it or, failing
// that, where the layout does. The same definition always gives the same
// picture.
export function toFlow(definition: Definition): Flow {
  // A draft may be saved with problems, such as two nodes sharing an id, but
  // the canvas needs a key per node. "#" can't appear in a valid id, so a key
  // with one in it can't clash with another node's.
  const keys: string[] = [];
  const keyOf = new Map<string, string>(); // a node's id → the key of the first node with it
  for (const [i, n] of definition.nodes.entries()) {
    const key = n.id !== "" && !keyOf.has(n.id) ? n.id : `${n.id}#${i}`;
    keys.push(key);
    if (n.id !== "" && !keyOf.has(n.id)) keyOf.set(n.id, key);
  }

  const edges: FlowEdge[] = [];
  const undrawn: number[] = [];
  const repeats = new Map<string, number>();
  for (const [i, e] of (definition.edges ?? []).entries()) {
    const source = keyOf.get(e.from);
    const target = keyOf.get(e.to);
    if (source === undefined || target === undefined) {
      undrawn.push(i);
      continue;
    }
    const id = `${source}->${target}`;
    const seen = repeats.get(id) ?? 0;
    repeats.set(id, seen + 1);
    edges.push({
      id: seen === 0 ? id : `${id}#${seen}`,
      source,
      target,
      sourceHandle: "out",
      targetHandle: "in",
      data: { index: i },
    });
  }

  const positions = place(definition, keys, edges);
  const nodes = definition.nodes.map((n, i): FlowNode => {
    const key = keys[i] ?? "";
    // The type says a kind is http or transform, but a draft saved with
    // problems can hold any string.
    const kind: string = n.kind;
    return {
      id: key,
      type: kind === "http" || kind === "transform" ? kind : "unknown",
      position: positions.get(key) ?? { x: 0, y: 0 },
      // React Flow draws a node at a size it's given rather than measuring it.
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      // And it keeps a node's handle positions only when the node says it
      // was measured. Every edit draws new node objects, so without this,
      // each one wiped every node's handles and blinked all the edges off
      // until React Flow measured them again: every key typed in a step's
      // settings.
      measured: { width: NODE_WIDTH, height: NODE_HEIGHT },
      data: { index: i },
    };
  });
  return { nodes, edges, undrawn };
}

// place gives each node the position the definition stores for it. The rest
// are laid out left to right, and put below the stored ones, so a node that
// arrives without a position never lands on one somebody placed.
function place(
  definition: Definition,
  keys: string[],
  edges: FlowEdge[],
): Map<string, XYPosition> {
  const stored = definition.ui?.positions ?? {};
  const positions = new Map<string, XYPosition>();
  for (const [i, n] of definition.nodes.entries()) {
    const key = keys[i];
    const at = stored[n.id];
    if (key === n.id && at) positions.set(key, { x: at.x, y: at.y });
  }
  const missing = keys.filter((k) => !positions.has(k));
  if (missing.length === 0) return positions;

  const laidOut = layoutAll(keys, edges);
  let below = 0;
  if (positions.size > 0) {
    const storedBottom = Math.max(...[...positions.values()].map((p) => p.y));
    const newTop = Math.min(...missing.map((k) => laidOut.get(k)?.y ?? 0));
    below = storedBottom + NODE_HEIGHT * 2 - newTop;
  }
  for (const k of missing) {
    const p = laidOut.get(k) ?? { x: 0, y: 0 };
    positions.set(k, { x: p.x, y: p.y + below });
  }
  return positions;
}

function layoutAll(keys: string[], edges: FlowEdge[]): Map<string, XYPosition> {
  const g = new Graph<GraphLabel, NodeLabel, EdgeLabel>();
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const k of keys)
    g.setNode(k, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of edges)
    if (e.source !== e.target) g.setEdge(e.source, e.target);
  layout(g);
  // dagre places a node by its centre, and React Flow by its top-left corner.
  return new Map(
    keys.map((k) => {
      const n = g.node(k);
      return [
        k,
        { x: (n.x ?? 0) - NODE_WIDTH / 2, y: (n.y ?? 0) - NODE_HEIGHT / 2 },
      ];
    }),
  );
}
