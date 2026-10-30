import { Handle, type NodeProps, Position } from "@xyflow/react";
import { memo, type ReactNode } from "react";

import { ProblemMark } from "@/features/editor/components/problem-mark";
import { reads } from "@/features/editor/edits";
import type { FlowNode } from "@/features/editor/flow";
import { atStep, useProblemCount } from "@/features/editor/hooks/use-problems";
import { useEditor } from "@/features/editor/store";

// Frame is every node's shape: its id, a line saying what it does, and the
// two handles edges join. Each handle has an id, since an edge names the
// handle it uses. A node with problems is marked.
function Frame({
  id,
  problems,
  children,
}: {
  id: string;
  problems: number;
  children: ReactNode;
}) {
  return (
    <div
      data-problems={problems > 0 || undefined}
      className="flex h-full w-full flex-col justify-center gap-0.5 rounded-lg border bg-card px-3 text-card-foreground shadow-xs data-problems:border-destructive"
    >
      <Handle type="target" position={Position.Left} id="in" />
      <span className="flex items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
        <span className="truncate font-mono text-sm font-medium">
          {id || "(no id)"}
        </span>
        {problems > 0 && <ProblemMark count={problems} />}
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
  const problems = useProblemCount(atStep(data.index));
  if (!node) return null;
  return (
    <Frame id={node.id} problems={problems}>
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
  const problems = useProblemCount(atStep(data.index));
  if (!node) return null;
  return (
    <Frame id={node.id} problems={problems}>
      {node.expr || "No expression yet"}
    </Frame>
  );
});

// A draft saved with problems can hold a kind the editor doesn't know.
const UnknownNode = memo(function UnknownNode({ data }: NodeProps<FlowNode>) {
  const node = useEditor((s) => s.draft.nodes[data.index]);
  const problems = useProblemCount(atStep(data.index));
  if (!node) return null;
  return (
    <Frame id={node.id} problems={problems}>
      Unknown kind: {node.kind}
    </Frame>
  );
});

// The response card ends the graph: what the workflow answers, and which
// steps its output reads. It has no handles, since the output reads steps by
// name rather than along connections.
const ResponseNode = memo(function ResponseNode() {
  const line = useEditor((s) => {
    if (!s.draft.output) return "No output yet";
    const read = reads(s.draft, s.draft.output);
    return read.length === 0 ? "Reads no step" : `Reads ${read.join(", ")}`;
  });
  const problems = useProblemCount((p) => p.on === "response");
  return (
    <div
      data-problems={problems > 0 || undefined}
      className="flex h-full w-full flex-col justify-center gap-0.5 rounded-lg border border-dashed bg-card px-3 text-card-foreground shadow-xs data-problems:border-destructive"
    >
      <span className="flex items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
        <span className="truncate text-sm font-medium">Response</span>
        {problems > 0 && <ProblemMark count={problems} />}
      </span>
      <span className="truncate text-xs text-muted-foreground">{line}</span>
    </div>
  );
});

// At module scope: React Flow redraws every node when this object changes.
export const nodeTypes = {
  http: HttpNode,
  transform: TransformNode,
  unknown: UnknownNode,
  response: ResponseNode,
};
