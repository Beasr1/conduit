import { Background, Controls, ReactFlow } from "@xyflow/react";
import { useMemo } from "react";

import { nodeTypes } from "@/features/editor/components/nodes";
import { toFlow } from "@/features/editor/flow";
import { useEditor } from "@/features/editor/store";

// Canvas draws the draft. Nothing on it can be edited yet: dragging,
// connecting and deleting come with the next step.
export function Canvas() {
  const draft = useEditor((s) => s.draft);
  const { nodes, edges } = useMemo(() => toFlow(draft), [draft]);
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      colorMode="system"
      fitView
    >
      <Background />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
