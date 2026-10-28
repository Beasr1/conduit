import type { XYPosition } from "@xyflow/react";

import { toFlow } from "@/features/editor/flow";
import type { components } from "@/gen/schema";

type Definition = components["schemas"]["Definition"];
type Node = components["schemas"]["Node"];
type Position = components["schemas"]["Position"];

// The definition's rule for a node id, from schema/workflow.yaml. The editor
// checks an id against it as it's typed; the server checks it again and
// decides.
export const NODE_ID = /^[a-z][a-z0-9_]{0,63}$/;

// Each edit takes the draft and returns a new one, leaving its input as it
// was, so the store can tell a change by identity.

// Stored positions are whole numbers: a fraction of a pixel means nothing on
// the canvas.
function round(p: XYPosition): Position {
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

export function addNode(d: Definition, node: Node, at: XYPosition): Definition {
  return {
    ...d,
    nodes: [...d.nodes, node],
    ui: { ...d.ui, positions: { ...d.ui?.positions, [node.id]: round(at) } },
  };
}

// move stores where nodes were dragged to, by node id.
export function move(
  d: Definition,
  to: Record<string, XYPosition>,
): Definition {
  const positions = { ...d.ui?.positions };
  for (const [id, p] of Object.entries(to)) positions[id] = round(p);
  return { ...d, ui: { ...d.ui, positions } };
}

// settle writes down where every node is drawn. The store applies it before
// each edit, so the first edit keeps the layout as the user sees it: a node
// placed automatically doesn't move because another was dragged, or because
// a new edge changed the automatic layout. A node keyed with "#" (a missing
// or shared id) can't be stored by id, so the layout goes on placing it.
export function settle(d: Definition): Definition {
  const stored = d.ui?.positions ?? {};
  const unplaced = toFlow(d).nodes.filter(
    (n) => !n.id.includes("#") && !stored[n.id],
  );
  if (unplaced.length === 0) return d;
  return move(d, Object.fromEntries(unplaced.map((n) => [n.id, n.position])));
}

// canConnect says whether an edge may be drawn from one node to another: not
// to itself, not twice, and not closing a cycle. It's only for feel; the
// server's validation still decides.
export function canConnect(d: Definition, from: string, to: string): boolean {
  if (from === to) return false;
  if ((d.edges ?? []).some((e) => e.from === from && e.to === to)) return false;
  return !reaches(d, to, from);
}

// reaches reports whether edges lead from one node to another.
function reaches(d: Definition, from: string, to: string): boolean {
  const next = new Map<string, string[]>();
  for (const e of d.edges ?? [])
    next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const seen = new Set<string>();
  const stack = [from];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(next.get(id) ?? []));
  }
  return false;
}

export function connect(d: Definition, from: string, to: string): Definition {
  return { ...d, edges: [...(d.edges ?? []), { from, to }] };
}

// removeEdges removes edges by their places in definition.edges.
export function removeEdges(d: Definition, indexes: number[]): Definition {
  const gone = new Set(indexes);
  return { ...d, edges: (d.edges ?? []).filter((_, i) => !gone.has(i)) };
}

// removeNodes removes nodes by their places in definition.nodes. The edges
// and positions of an id that no node has any more go with them; those of a
// node that shared its id with one that stays don't.
export function removeNodes(d: Definition, indexes: number[]): Definition {
  const gone = new Set(indexes);
  const nodes = d.nodes.filter((_, i) => !gone.has(i));
  const left = new Set(nodes.map((n) => n.id));
  const lost = new Set(
    d.nodes.filter((n, i) => gone.has(i) && !left.has(n.id)).map((n) => n.id),
  );
  const edges = (d.edges ?? []).filter(
    (e) => !lost.has(e.from) && !lost.has(e.to),
  );
  if (!d.ui) return { ...d, nodes, edges };
  const positions = Object.fromEntries(
    Object.entries(d.ui.positions ?? {}).filter(([id]) => !lost.has(id)),
  );
  return { ...d, nodes, edges, ui: { ...d.ui, positions } };
}
