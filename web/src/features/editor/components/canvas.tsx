import { Background, Controls, Panel, ReactFlow } from "@xyflow/react";
import { useMemo } from "react";

import { AddNodeDialog } from "@/features/editor/components/add-node-dialog";
import { nodeTypes } from "@/features/editor/components/nodes";
import {
  canConnect,
  connect,
  removeEdges,
  removeNodes,
} from "@/features/editor/edits";
import { type FlowEdge, type FlowNode, toFlow } from "@/features/editor/flow";
import { useEditor } from "@/features/editor/store";

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

  const flow = useMemo(() => toFlow(draft), [draft]);
  // Only a node that's moving or selected gets a new object, so the rest
  // aren't redrawn.
  const nodes = useMemo(
    () =>
      flow.nodes.map((n): FlowNode => {
        const at = moving[n.id];
        const on = selected.nodes.includes(n.id);
        return at || on
          ? { ...n, position: at ?? n.position, selected: on }
          : n;
      }),
    [flow, moving, selected.nodes],
  );
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
      colorMode="system"
      fitView
    >
      <Background />
      <Controls showInteractive={false} />
      <Panel position="top-left" className="flex gap-2">
        <AddNodeDialog kind="http" />
        <AddNodeDialog kind="transform" />
      </Panel>
    </ReactFlow>
  );
}
