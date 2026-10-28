import {
  Background,
  Controls,
  Panel,
  ReactFlow,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { useEffect, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { AddNodeDialog } from "@/features/editor/components/add-node-dialog";
import { nodeTypes } from "@/features/editor/components/nodes";
import {
  canConnect,
  connect,
  removeEdges,
  removeNodes,
} from "@/features/editor/edits";
import {
  type FlowEdge,
  type FlowNode,
  NODE_HEIGHT,
  NODE_WIDTH,
  RESPONSE,
  responseCard,
  toFlow,
} from "@/features/editor/flow";
import { useEditor } from "@/features/editor/store";

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
  const openSettings = useEditor((s) => s.openSettings);

  const flow = useMemo(() => toFlow(draft), [draft]);
  // Only a node that's moving or selected gets a new object, so the rest
  // aren't redrawn. The response card comes last, after the steps.
  const nodes = useMemo(() => {
    const steps = flow.nodes.map((n): FlowNode => {
      const at = moving[n.id];
      const on = selected.nodes.includes(n.id);
      return at || on ? { ...n, position: at ?? n.position, selected: on } : n;
    });
    const card = responseCard(flow.nodes);
    const on = selected.nodes.includes(RESPONSE);
    return [...steps, on ? { ...card, selected: true } : card];
  }, [flow, moving, selected.nodes]);
  const edges = useMemo(
    () =>
      flow.edges.map((e): FlowEdge =>
        selected.edges.includes(e.id) ? { ...e, selected: true } : e,
      ),
    [flow, selected.edges],
  );

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
      onNodeDragStop={(_event, _node, dragged) =>
        drop(Object.fromEntries(dragged.map((n) => [n.id, n.position])))
      }
      onEdgesChange={(changes) => {
        const picks = changes.filter((c) => c.type === "select");
        if (picks.length > 0) pick("edges", picks);
      }}
      // A node keyed with "#" has a missing or shared id, which an edge
      // can't name.
      isValidConnection={(c) =>
        !c.source.includes("#") &&
        !c.target.includes("#") &&
        canConnect(draft, c.source, c.target)
      }
      onConnect={(c) => edit((d) => connect(d, c.source, c.target))}
      // Edges go first: removing nodes doesn't move the remaining edges, but
      // the indexes here are for the draft as it is now.
      onDelete={({ nodes: gone, edges: cut }) =>
        edit((d) =>
          removeNodes(
            removeEdges(
              d,
              cut.flatMap((e) => (e.data ? [e.data.index] : [])),
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
        <Button variant="outline" size="sm" onClick={openSettings}>
          Workflow settings
        </Button>
      </Panel>
      <KeepPickedInView />
    </ReactFlow>
  );
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
    const dy = shift(at.y * zoom + y, NODE_HEIGHT * zoom, height);
    if (dx !== 0 || dy !== 0)
      void flow.setViewport({ x: x + dx, y: y + dy, zoom });
  }, [picked, width, height, flow]);
  return null;
}
