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
type Case = components["schemas"]["Case"];
type DefinitionNode = components["schemas"]["Node"];
type StepOutcome = components["schemas"]["StepOutcome"];

// Every node is drawn at this size, or taller to fit its outputs, so placing
// nodes and drawing them agree.
export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 72;
// The room between one rank of the layout and the next.
export const RANK_GAP = 80;
// The least distance between two handles' centres, so a 24 px circle around
// each touches no other (design.md, the floor).
const HANDLE_GAP = 24;

// handlesOf is a node's outputs, as the ids of the handles its edges leave
// from: an HTTP step's 2xx and each status it lists, a transform's cases'
// statuses, its exits, or a transform's one.
export function handlesOf(node: DefinitionNode): string[] {
  if (node.kind === "http")
    return ["2xx", ...(node.outputs ?? []).map((o) => String(o.status))];
  return node.switch ? exitsOf(node).map((e) => String(e.status)) : ["out"];
}

// Exit is a way a transform with cases leaves: one of its cases, by the
// part of the step it is, what it's called, and the status that names it.
export interface Exit {
  part: string;
  label: string;
  status: number;
}

// exitsOf is a transform's exits, its cases' in their order; none for one
// with an expression. A draft saved without cases has none either.
export function exitsOf(node: DefinitionNode | undefined): Exit[] {
  const cases: Case[] = node?.switch?.cases ?? [];
  return cases.map((c, k) => ({
    part: `case:${k}`,
    label: c.name || `Case ${k + 1}`,
    status: c.status,
  }));
}

// UNHANDLED is a step's Unhandled block among its outputs, as the editor
// counts them: beside each status, and undefined for 2xx and a transform's
// one. The definition writes a line from it as unhandled: true, and the
// canvas draws it as a strip along the step's bottom, with this handle.
export const UNHANDLED = -1;
export const UNHANDLED_HANDLE = "unhandled";

// outputOf is the output a line, an edge or an answer's, leaves from.
export function outputOf(line: {
  on?: number;
  unhandled?: boolean;
}): number | undefined {
  return line.unhandled ? UNHANDLED : line.on;
}

// lineFrom is how the definition writes a line that leaves from output on.
export function lineFrom(on: number | undefined): {
  on?: number;
  unhandled?: boolean;
} {
  if (on === UNHANDLED) return { unhandled: true };
  return on === undefined ? {} : { on };
}

// onOf is the output an edge drawn from a handle leaves from, as the
// editor counts it: a status, UNHANDLED, or nothing for 2xx and a
// transform's one.
export function onOf(handle: string | null | undefined): number | undefined {
  if (handle === UNHANDLED_HANDLE) return UNHANDLED;
  const status = Number(handle);
  return Number.isInteger(status) ? status : undefined;
}

// handleOf is the handle a line leaves its step from: its status's, the
// Unhandled strip's, or the first, 2xx or a transform's one. Undefined when
// the step has none such, as one of a kind the editor doesn't know has no
// strip.
function handleOf(
  line: { on?: number; unhandled?: boolean },
  node: DefinitionNode | undefined,
): string | undefined {
  if (line.unhandled)
    return node && hasStrip(node) ? UNHANDLED_HANDLE : undefined;
  const handles = handlesOf(node ?? { id: "", kind: "http" });
  // No output, or 0 as the server reads it, is the first: 2xx, or a
  // transform's one. A line from a transform's cases names one.
  const handle = line.on
    ? String(line.on)
    : node?.switch
      ? ""
      : (handles[0] ?? "");
  return handles.includes(handle) ? handle : undefined;
}

// hasStrip says whether a step is drawn with its Unhandled strip: each of
// the kinds the editor knows is.
export function hasStrip(node: DefinitionNode): boolean {
  const kind: string = node.kind;
  return kind === "http" || kind === "transform";
}

// heightOf is how tall a node is drawn: an HTTP step's response blocks and
// its + Add share its right side, each at least HANDLE_GAP tall, so the
// handles on them are at least that far apart, and its Unhandled strip runs
// along its bottom, as tall.
function heightOf(node: DefinitionNode): number {
  const strip = hasStrip(node) ? HANDLE_GAP : 0;
  return (
    Math.max(NODE_HEIGHT, (handlesOf(node).length + 1) * HANDLE_GAP) + strip
  );
}

// Way is a line into a step: an edge, by its place in the definition's
// edges, the step it comes from, and the output it leaves.
export interface Way {
  index: number;
  from: string;
  on: number | undefined;
}

// waysInto is the edges into the step with id, in the definition's order:
// a transform's ways, when there's more than one.
export function waysInto(definition: Definition, id: string): Way[] {
  return (definition.edges ?? []).flatMap((e, index) =>
    e.to === id ? [{ index, from: e.from, on: outputOf(e) }] : [],
  );
}

// wayLabel is a way as the screen names it: the step it comes from, and the
// response it leaves, "prefs · 404", the case, "check · missing", or its
// Unhandled; a transform's one value needs no name.
export function wayLabel(
  definition: Definition,
  from: string,
  on: number | undefined,
): string {
  const name = outputName(
    definition.nodes.find((n) => n.id === from),
    on,
  );
  return name === undefined ? from : `${from} · ${name}`;
}

// outputName is a step's output as the screen names it: an HTTP step's
// response by its status, "2xx" for none or 0, a case by its name,
// Unhandled; undefined for a transform's one value.
function outputName(
  node: DefinitionNode | undefined,
  on: number | undefined,
): string | undefined {
  if (on === UNHANDLED) return "Unhandled";
  if (node?.kind === "http")
    return on === undefined || on === 0 ? "2xx" : String(on);
  return exitsOf(node).find((e) => e.status === on)?.label;
}

// outcomeTag is how a step's Input tags an earlier step, from what it may
// have done in a run that reaches this one: "conditional" when the run may
// have skipped it, the outputs it may have answered through when there are
// several, "2xx or 400", Unhandled last, or both; undefined when it surely
// gave the one.
export function outcomeTag(
  node: DefinitionNode | undefined,
  outcome: StepOutcome,
): string | undefined {
  const tags = [];
  if (outcome.conditional) tags.push("conditional");
  if (outcome.outputs.length > 1) {
    const last = (on: number) => (on === UNHANDLED ? 1 : 0);
    const outputs = outcome.outputs.toSorted((a, b) => last(a) - last(b));
    tags.push(
      outputs.map((on) => outputName(node, on) ?? "value").join(" or "),
    );
  }
  return tags.length > 0 ? tags.join(" · ") : undefined;
}

// The response card's key. "#" can't appear in a node id, so the card is
// never stored, connected or deleted as one.
export const RESPONSE = "#response";

// A node component finds what to draw through data.index, its place in
// definition.nodes, and an edge's panel through its place in
// definition.edges. The response card isn't a node of the definition, nor
// a line into it an edge: their index is -1, a line's answer is its place
// in the response's answers, as is its point's id on the card, and line is
// its place in the answer's lines.
export type FlowNode = Node<
  { index: number },
  "http" | "transform" | "unknown" | "response"
>;
export type FlowEdge = Edge<{
  index: number;
  answer?: number;
  line?: number;
  way?: boolean;
}>;

export interface Flow {
  nodes: FlowNode[];
  edges: FlowEdge[];
  // Edges the canvas can't draw, because an end names no node, or the
  // output it leaves from is one its step doesn't have: their places in
  // definition.edges.
  undrawn: number[];
}

// toFlow is the canvas's view of a definition: a node for each node, an edge
// for each edge it can draw, each where the definition places it or, failing
// that, where the layout does, and the lines into the response's answers,
// last. Each line into a transform with more than one is one of its ways,
// as it may not come, unless it's required. The same definition always
// gives the same picture.
export function toFlow(definition: Definition): Flow {
  // A draft may be saved with problems, such as two nodes sharing an id, but
  // the canvas needs a key per node. "#" can't appear in a valid id, so a key
  // with one in it can't clash with another node's.
  const keys: string[] = [];
  const keyOf = new Map<string, string>(); // a node's id → the key of the first node with it
  const nodeOf = new Map<string, DefinitionNode>(); // and that node
  for (const [i, n] of definition.nodes.entries()) {
    const key = n.id !== "" && !keyOf.has(n.id) ? n.id : `${n.id}#${i}`;
    keys.push(key);
    if (n.id !== "" && !keyOf.has(n.id)) {
      keyOf.set(n.id, key);
      nodeOf.set(n.id, n);
    }
  }

  // The transforms more than one line comes into, by id.
  const lines = new Map<string, number>();
  for (const e of definition.edges ?? [])
    if (nodeOf.get(e.to)?.kind === "transform")
      lines.set(e.to, (lines.get(e.to) ?? 0) + 1);

  const edges: FlowEdge[] = [];
  const undrawn: number[] = [];
  const repeats = new Map<string, number>();
  for (const [i, e] of (definition.edges ?? []).entries()) {
    const source = keyOf.get(e.from);
    const target = keyOf.get(e.to);
    const handle = handleOf(e, nodeOf.get(e.from));
    if (source === undefined || target === undefined || handle === undefined) {
      undrawn.push(i);
      continue;
    }
    const id = `${source}->${target}`;
    const seen = repeats.get(id) ?? 0;
    repeats.set(id, seen + 1);
    const way = !e.required && (lines.get(e.to) ?? 0) > 1;
    edges.push({
      id: seen === 0 ? id : `${id}#${seen}`,
      source,
      target,
      sourceHandle: handle,
      targetHandle: "in",
      // A condition shows as a small label; what it says is in the panel.
      ...(e.when ? { label: "if" } : {}),
      data: { index: i, ...(way ? { way } : {}) },
    });
  }

  const heights = definition.nodes.map(heightOf);
  const positions = place(definition, keys, edges, heights);
  const nodes = definition.nodes.map((n, i): FlowNode => {
    const key = keys[i] ?? "";
    // The type says a kind is one the editor knows, but a draft saved with
    // problems can hold any string.
    const kind: string = n.kind;
    const height = heights[i] ?? NODE_HEIGHT;
    return {
      id: key,
      type: kind === "http" || kind === "transform" ? kind : "unknown",
      position: positions.get(key) ?? { x: 0, y: 0 },
      // React Flow draws a node at a size it's given rather than measuring it.
      width: NODE_WIDTH,
      height,
      // And it keeps a node's handle positions only when the node says it
      // was measured. Every edit draws new node objects, so without this,
      // each one wiped every node's handles and blinked all the edges off
      // until React Flow measured them again: every key typed in a step's
      // settings.
      measured: { width: NODE_WIDTH, height },
      data: { index: i },
    };
  });
  // Each line into an answer is drawn once its step and the output it leaves
  // on are there, into the answer's own point, and the layout leaves it out:
  // the card isn't laid out with the steps, but put after them.
  for (const [k, a] of (definition.response?.answers ?? []).entries()) {
    for (const [j, l] of (a.lines ?? []).entries()) {
      const source = keyOf.get(l.from);
      const handle = handleOf(l, nodeOf.get(l.from));
      if (source === undefined || handle === undefined) continue;
      const id = `${source}->${RESPONSE}:${k}`;
      const seen = repeats.get(id) ?? 0;
      repeats.set(id, seen + 1);
      edges.push({
        id: seen === 0 ? id : `${id}#${seen}`,
        source,
        target: RESPONSE,
        sourceHandle: handle,
        targetHandle: String(k),
        data: { index: -1, answer: k, line: j },
      });
    }
  }
  return { nodes, edges, undrawn };
}

// The room kept around a new node, so it doesn't touch one already there.
const SPACING = 24;

// freeSpot moves a spot down, a node's height at a time, until a node there
// would cover none of those placed.
export function freeSpot(at: XYPosition, placed: XYPosition[]): XYPosition {
  const covers = (p: XYPosition, q: XYPosition) =>
    Math.abs(p.x - q.x) < NODE_WIDTH + SPACING &&
    Math.abs(p.y - q.y) < NODE_HEIGHT + SPACING;
  let spot = at;
  while (placed.some((p) => covers(p, spot)))
    spot = { x: spot.x, y: spot.y + NODE_HEIGHT + SPACING };
  return spot;
}

// responseCard is the card that ends the graph: what the workflow answers.
// It goes after the rightmost step, level with the middle of them all, and
// is as tall as its answers and + Add need, as a step is for its responses,
// with its Unhandled strip along its bottom.
// It can be picked, and a line drawn into it, but it can't be dragged or
// deleted. The canvas adds it, since it isn't a node of the definition.
export function responseCard(nodes: FlowNode[], answers: number): FlowNode {
  const xs = nodes.map((n) => n.position.x);
  const ys = nodes.map((n) => n.position.y);
  const position =
    nodes.length === 0
      ? { x: 0, y: 0 }
      : {
          x: Math.max(...xs) + NODE_WIDTH + RANK_GAP,
          y: (Math.min(...ys) + Math.max(...ys)) / 2,
        };
  const height = Math.max(NODE_HEIGHT, (answers + 1) * HANDLE_GAP) + HANDLE_GAP;
  return {
    id: RESPONSE,
    type: "response",
    position,
    width: NODE_WIDTH,
    height,
    measured: { width: NODE_WIDTH, height },
    draggable: false,
    deletable: false,
    data: { index: -1 },
  };
}

// place gives each node the position the definition stores for it. The rest
// are laid out left to right, and put below the stored ones, so a node that
// arrives without a position never lands on one somebody placed.
function place(
  definition: Definition,
  keys: string[],
  edges: FlowEdge[],
  heights: number[],
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

  const laidOut = layoutAll(keys, heights, edges);
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

// layoutAll lays out every node, keys[i] being heights[i] tall.
function layoutAll(
  keys: string[],
  heights: number[],
  edges: FlowEdge[],
): Map<string, XYPosition> {
  const g = new Graph<GraphLabel, NodeLabel, EdgeLabel>();
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: RANK_GAP });
  g.setDefaultEdgeLabel(() => ({}));
  for (const [i, k] of keys.entries())
    g.setNode(k, { width: NODE_WIDTH, height: heights[i] ?? NODE_HEIGHT });
  for (const e of edges)
    if (e.source !== e.target) g.setEdge(e.source, e.target);
  layout(g);
  // dagre places a node by its centre, and React Flow by its top-left corner.
  return new Map(
    keys.map((k, i) => {
      const n = g.node(k);
      const height = heights[i] ?? NODE_HEIGHT;
      return [
        k,
        { x: (n.x ?? 0) - NODE_WIDTH / 2, y: (n.y ?? 0) - height / 2 },
      ];
    }),
  );
}
