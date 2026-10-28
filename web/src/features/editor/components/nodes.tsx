import { Handle, type NodeProps, Position } from "@xyflow/react";
import { memo, type ReactNode } from "react";

import type { FlowNode } from "@/features/editor/flow";
import { useEditor } from "@/features/editor/store";

// Frame is every node's shape: its id, a line saying what it does, and the
// two handles edges join. Each handle has an id, since an edge names the
// handle it uses.
function Frame({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col justify-center gap-0.5 rounded-lg border bg-card px-3 text-card-foreground shadow-xs">
      <Handle type="target" position={Position.Left} id="in" />
      <span className="truncate font-mono text-sm font-medium">
        {id || "(no id)"}
      </span>
      <span className="truncate text-xs text-muted-foreground">{children}</span>
      <Handle type="source" position={Position.Right} id="out" />
    </div>
  );
}

// Each node reads only its own node from the draft, so editing one node
// redraws only that one.
const HttpNode = memo(function HttpNode({ data }: NodeProps<FlowNode>) {
  const node = useEditor((s) => s.draft.nodes[data.index]);
  if (!node) return null;
  return (
    <Frame id={node.id}>
      {node.request
        ? `${node.request.method} ${node.request.url || "(no URL yet)"}`
        : "No request yet"}
    </Frame>
  );
});

const TransformNode = memo(function TransformNode({
  data,
}: NodeProps<FlowNode>) {
  const node = useEditor((s) => s.draft.nodes[data.index]);
  if (!node) return null;
  return <Frame id={node.id}>{node.expr || "No expression yet"}</Frame>;
});

// A draft saved with problems can hold a kind the editor doesn't know.
const UnknownNode = memo(function UnknownNode({ data }: NodeProps<FlowNode>) {
  const node = useEditor((s) => s.draft.nodes[data.index]);
  if (!node) return null;
  return <Frame id={node.id}>Unknown kind: {node.kind}</Frame>;
});

// At module scope: React Flow redraws every node when this object changes.
export const nodeTypes = {
  http: HttpNode,
  transform: TransformNode,
  unknown: UnknownNode,
};
