import {
  Background,
  Controls,
  type FinalConnectionState,
  Panel,
  ReactFlow,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { useEffect, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { AddNodeDialog } from "@/features/editor/components/add-node-dialog";
import { nodeTypes } from "@/features/editor/components/nodes";
import { ProblemMark } from "@/features/editor/components/problem-mark";
import {
  canConnect,
  canJoin,
  connect,
  joinAnswer,
  leaveAnswer,
  refusal,
  removeEdges,
  removeNodes,
} from "@/features/editor/edits";
import {
  type FlowEdge,
  type FlowNode,
  NODE_HEIGHT,
  NODE_WIDTH,
  onOf,
  outputOf,
  RESPONSE,
  responseCard,
  toFlow,
  wayHandle,
} from "@/features/editor/flow";
import {
  useProblemCount,
  useProblems,
} from "@/features/editor/hooks/use-problems";
import { useRun, useRunSteps } from "@/features/editor/hooks/use-runs";
import { type StepRun, takenOf } from "@/features/editor/runs";
import { type Refused, useEditor } from "@/features/editor/store";
import type { components } from "@/gen/schema";

type Definition = components["schemas"]["Definition"];

// The room kept between a picked step and the canvas's edge.
const MARGIN = 24;

// Canvas draws the draft and turns what's done on it into edits of the
// draft: a drag, a new edge, a deletion. React Flow keeps nothing of its own.
export function Canvas() {
  const draft = useEditor((s) => s.draft);
  const moving = useEditor((s) => s.moving);
  const selected = useEditor((s) => s.selected);
  const edit = useEditor((s) => s.edit);
  const drag = useEditor((s) => s.drag);
  const drop = useEditor((s) => s.drop);
  const pick = useEditor((s) => s.pick);
  const setPart = useEditor((s) => s.setPart);
  const openPanel = useEditor((s) => s.openPanel);
  const refuse = useEditor((s) => s.refuse);

  const flow = useMemo(() => toFlow(draft), [draft]);
  // Only a node that's moving or selected gets a new object, so the rest
  // aren't redrawn. The response card comes last, after the steps.
  const answers = draft.response?.answers?.length ?? 0;
  const nodes = useMemo(() => {
    const steps = flow.nodes.map((n): FlowNode => {
      const at = moving[n.id];
      const on = selected.nodes.includes(n.id);
      return at || on ? { ...n, position: at ?? n.position, selected: on } : n;
    });
    const card = responseCard(flow.nodes, answers);
    const on = selected.nodes.includes(RESPONSE);
    return [...steps, on ? { ...card, selected: true } : card];
  }, [flow, moving, selected.nodes, answers]);
  // A connection with problems is drawn in the problem colour, and its label
  // says so in words too. While a run is shown, one the run didn't take is
  // dashed, and its name says whether the run took it. A line into an
  // answer is taken once the run answered with it: gave is that status, or
  // -1 while the run goes on. A run that failed took none, even one the
  // response's Unhandled answered. A line into an Either is taken when
  // it's the way the Either says it came by. Until a run says, a way into an
  // Either is dashed too, as it may not be taken; so is one the run is still
  // to decide.
  const troubled = useProblems((p) => p.on === "connection");
  const steps = useRunSteps();
  const gave = useRun(
    useEditor((s) => s.run),
    (r) =>
      r.status === "running"
        ? -1
        : r.status === "succeeded"
          ? (r.answered ?? 0)
          : 0,
  ).data;
  const edges = useMemo(() => {
    const wrong = new Set(
      troubled.map((f) => (f.place.on === "connection" ? f.place.index : -1)),
    );
    return flow.edges.map((e): FlowEdge => {
      const on = selected.edges.includes(e.id);
      const answer =
        e.data?.answer === undefined
          ? undefined
          : draft.response?.answers?.[e.data.answer];
      const bad =
        answer === undefined && e.data !== undefined && wrong.has(e.data.index);
      const edge = e.data && draft.edges?.[e.data.index];
      const line = answer
        ? answer.from === undefined
          ? undefined
          : {
              from: answer.from,
              on: outputOf(answer),
              to: `the ${answer.status} answer`,
            }
        : edge && { from: edge.from, on: outputOf(edge), to: edge.to };
      const into = (): StepRun =>
        answer
          ? {
              state:
                gave === undefined || gave === -1
                  ? "waiting"
                  : gave === answer.status
                    ? "succeeded"
                    : "not run",
            }
          : (steps?.(line?.to ?? "") ?? { state: "waiting" });
      const to = line && !answer ? steps?.(line.to) : undefined;
      const taken =
        line && to?.came
          ? wayHandle(to.came) === wayHandle(line)
          : steps && line
            ? takenOf(line.on, steps(line.from), into())
            : undefined;
      const may = e.data?.way === true && taken === undefined;
      if (!on && !bad && !may && taken === undefined) return e;
      const classes = [
        bad && "problem",
        taken === false && "untaken",
        may && "way",
      ]
        .filter(Boolean)
        .join(" ");
      return {
        ...e,
        selected: on,
        ...(classes ? { className: classes } : {}),
        ...(bad
          ? { label: e.label ? `${String(e.label)} · problem` : "problem" }
          : {}),
        ...(line && taken !== undefined
          ? {
              ariaLabel: `Connection from ${line.from} to ${line.to}, ${taken ? "taken" : "not taken"} in this run`,
            }
          : line && may
            ? {
                ariaLabel: `Connection from ${line.from} to ${line.to}, one of its ways`,
              }
            : {}),
      };
    });
  }, [flow, selected.edges, troubled, steps, draft, gave]);
  const settingsProblems = useProblemCount((p) => p.on === "settings");

  return (
    <ReactFlow<FlowNode, FlowEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={(changes) => {
        const picks = [];
        for (const c of changes) {
          if (c.type === "position" && c.dragging && c.position)
            drag(c.id, c.position);
          if (c.type === "select") picks.push(c);
        }
        if (picks.length > 0) pick("nodes", picks);
      }}
      // A step's blocks each say which part of it they are, so a click on
      // one, or on its point, opens that part. The click picks the step
      // first, which opens its request.
      onNodeClick={(event) => {
        const block =
          event.target instanceof Element
            ? event.target.closest("[data-part]")
            : null;
        const part = block?.getAttribute("data-part");
        if (part) setPart(part);
      }}
      onNodeDragStop={(_event, _node, dragged) =>
        drop(Object.fromEntries(dragged.map((n) => [n.id, n.position])))
      }
      onEdgesChange={(changes) => {
        const picks = changes.filter((c) => c.type === "select");
        if (picks.length > 0) pick("edges", picks);
      }}
      // A click on a point opens its part, so it can't also start a
      // connection: one is drawn by dragging, or made with Connect to in the
      // panel of the response it leaves from.
      connectOnClick={false}
      // A node keyed with "#" has a missing or shared id, which an edge
      // can't name. An edge leaves from the output whose handle it's drawn
      // from, and each answer on the response takes one line, into its own
      // point, whose id is the answer's place.
      isValidConnection={(c) =>
        !c.source.includes("#") &&
        (c.target === RESPONSE
          ? canJoin(draft, Number(c.targetHandle))
          : !c.target.includes("#") &&
            canConnect(draft, c.source, c.target, onOf(c.sourceHandle)))
      }
      onConnect={(c) =>
        edit((d) =>
          c.target === RESPONSE
            ? joinAnswer(
                d,
                Number(c.targetHandle),
                c.source,
                onOf(c.sourceHandle),
              )
            : connect(d, c.source, c.target, onOf(c.sourceHandle)),
        )
      }
      // A line the response refuses makes the card say why.
      onConnectStart={() => refuse(undefined)}
      onPaneClick={() => refuse(undefined)}
      onConnectEnd={(event, state) => refuse(refusedLine(draft, state, event))}
      // Edges go first: removing nodes doesn't move the remaining edges, but
      // the indexes here are for the draft as it is now. The lines into the
      // response's answers aren't edges.
      onDelete={({ nodes: gone, edges: cut }) =>
        edit((d) =>
          removeNodes(
            removeEdges(
              cut.reduce(
                (left, e) =>
                  e.data?.answer === undefined
                    ? left
                    : leaveAnswer(left, e.data.answer),
                d,
              ),
              cut.flatMap((e) =>
                e.data && e.target !== RESPONSE ? [e.data.index] : [],
              ),
            ),
            gone.map((n) => n.data.index),
          ),
        )
      }
      deleteKeyCode={["Backspace", "Delete"]}
      // A drag moves a step without picking it. Picking opens the step's
      // settings, which narrows the canvas under the drag.
      selectNodesOnDrag={false}
      colorMode="system"
      fitView
    >
      <Background />
      <Controls showInteractive={false} />
      {/* nokey: Delete or Backspace on these buttons would otherwise delete
          what's selected on the canvas. */}
      <Panel position="top-left" className="nokey flex gap-2">
        <AddNodeDialog kind="http" />
        <AddNodeDialog kind="transform" />
        <AddNodeDialog kind="either" />
        <Button
          variant="outline"
          size="sm"
          onClick={() => openPanel("settings")}
        >
          Workflow settings
          {settingsProblems > 0 && <ProblemMark count={settingsProblems} />}
        </Button>
        <Button variant="outline" size="sm" onClick={() => openPanel("runs")}>
          Runs
        </Button>
      </Panel>
      <KeepPickedInView />
    </ReactFlow>
  );
}

// refusedLine is a line into the response just refused, for the card to
// say why: drawn into an answer whose one line is another step's, or let
// go on the card off an answer's point. Either end can be the card, as a
// line can be drawn from either end. React Flow names the node only near
// a point, so a drop anywhere on the card counts.
function refusedLine(
  draft: Definition,
  state: FinalConnectionState,
  event: MouseEvent | TouchEvent,
): Refused | undefined {
  if (state.isValid) return undefined;
  const from = state.fromNode?.id;
  const to = state.toNode?.id ?? (droppedOnCard(event) ? RESPONSE : undefined);
  const step = from === RESPONSE ? to : to === RESPONSE ? from : undefined;
  if (step === undefined || step === RESPONSE || step.includes("#"))
    return undefined;
  const handle = from === RESPONSE ? state.fromHandle?.id : state.toHandle?.id;
  if (handle == null) return { step };
  const answer = Number(handle);
  return refusal(draft, step, answer) ? { step, answer } : undefined;
}

// droppedOnCard says whether a drag ended over the response card.
function droppedOnCard(event: MouseEvent | TouchEvent): boolean {
  const at = "changedTouches" in event ? event.changedTouches[0] : event;
  if (!at) return false;
  const under = document.elementFromPoint(at.clientX, at.clientY);
  return under?.closest(`[data-id="${RESPONSE}"]`) != null;
}

// KeepPickedInView pans the canvas, as little as it takes, so the one step
// picked stays in sight. Its settings open beside the canvas and narrow it,
// which could otherwise hide the step being edited.
function KeepPickedInView() {
  const picked = useEditor((s) =>
    s.selected.nodes.length === 1 && s.selected.edges.length === 0
      ? s.selected.nodes[0]
      : undefined,
  );
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const flow = useReactFlow();
  useEffect(() => {
    const node =
      picked === undefined ? undefined : flow.getInternalNode(picked);
    if (!node) return;
    const { x, y, zoom } = flow.getViewport();
    const at = node.internals.positionAbsolute;
    // Bring the far edge in first, then the near one, so a step wider than
    // the canvas shows its start.
    const shift = (start: number, size: number, room: number) => {
      let by = 0;
      if (start + size > room - MARGIN) by = room - MARGIN - (start + size);
      if (start + by < MARGIN) by = MARGIN - start;
      return by;
    };
    const dx = shift(at.x * zoom + x, NODE_WIDTH * zoom, width);
    const tall = node.measured.height ?? NODE_HEIGHT;
    const dy = shift(at.y * zoom + y, tall * zoom, height);
    if (dx !== 0 || dy !== 0)
      void flow.setViewport({ x: x + dx, y: y + dy, zoom });
  }, [picked, width, height, flow]);
  return null;
}
