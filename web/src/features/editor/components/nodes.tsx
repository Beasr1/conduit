import {
  Handle,
  type NodeProps,
  Position,
  useUpdateNodeInternals,
} from "@xyflow/react";
import { memo, type ReactNode, useEffect } from "react";

import { ProblemMark } from "@/features/editor/components/problem-mark";
import { reads } from "@/features/editor/edits";
import { type FlowNode, handlesOf } from "@/features/editor/flow";
import { atStep, useProblemCount } from "@/features/editor/hooks/use-problems";
import { useEditor } from "@/features/editor/store";

// Frame is a step's request block, and the inside of a step that has no
// others: its id, a line saying what it does, and the handle connections
// come in at, on the left. Each handle has an id, since an edge names the
// handle it uses. A step with problems is marked. part says which part of
// the step the block is, for the canvas to open when it's clicked.
function Frame({
  id,
  problems,
  part,
  children,
}: {
  id: string;
  problems: number;
  part?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-part={part}
      className="relative flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-3"
    >
      <Handle type="target" position={Position.Left} id="in" />
      <span className="flex items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
        <span className="truncate font-mono text-sm font-medium">
          {id || "(no id)"}
        </span>
        {problems > 0 && <ProblemMark count={problems} />}
      </span>
      <span className="truncate text-xs text-muted-foreground">{children}</span>
    </div>
  );
}

// Card is a step's outline, marked when the step has problems.
function Card({
  problems,
  children,
}: {
  problems: number;
  children: ReactNode;
}) {
  return (
    <div
      data-problems={problems > 0 || undefined}
      className="relative flex h-full w-full rounded-lg border bg-card text-card-foreground shadow-xs data-problems:border-destructive"
    >
      {children}
    </div>
  );
}

// Each node reads only its own node from the draft, so editing one node
// redraws only that one. An HTTP step is blocks: its request on the left,
// and on the right a block per response, with the handle its connections
// leave from, then + Add. Each block says which part of the step it is, and
// the canvas opens that part when it's clicked.
const HttpNode = memo(function HttpNode({ id, data }: NodeProps<FlowNode>) {
  const node = useEditor((s) => s.draft.nodes[data.index]);
  const problems = useProblemCount(atStep(data.index));
  const outputs = node ? handlesOf(node) : [];
  // React Flow finds a node's handles when it mounts; one added or taken
  // away later has to be pointed out.
  const update = useUpdateNodeInternals();
  const handles = outputs.join(" ");
  useEffect(() => update(id), [update, id, handles]);
  if (!node) return null;
  return (
    <Card problems={problems}>
      <Frame id={node.id} problems={problems} part="request">
        {node.request
          ? `${node.request.method} ${node.request.url || "(no URL yet)"}`
          : "No request yet"}
      </Frame>
      <div className="flex w-18 shrink-0 flex-col border-l font-mono text-xs">
        {outputs.map((o) => (
          <div
            key={o}
            data-part={o}
            className="relative flex flex-1 items-center border-b px-2.5"
          >
            {o}
            <Handle type="source" position={Position.Right} id={o} />
          </div>
        ))}
        <div
          data-part="add"
          className="flex flex-1 items-center px-2.5 text-muted-foreground"
        >
          + Add
        </div>
      </div>
    </Card>
  );
});

const TransformNode = memo(function TransformNode({
  data,
}: NodeProps<FlowNode>) {
  const node = useEditor((s) => s.draft.nodes[data.index]);
  const problems = useProblemCount(atStep(data.index));
  if (!node) return null;
  return (
    <Card problems={problems}>
      <Frame id={node.id} problems={problems}>
        {node.expr || "No expression yet"}
      </Frame>
      <Handle type="source" position={Position.Right} id="out" />
    </Card>
  );
});

// A draft saved with problems can hold a kind the editor doesn't know.
const UnknownNode = memo(function UnknownNode({ data }: NodeProps<FlowNode>) {
  const node = useEditor((s) => s.draft.nodes[data.index]);
  const problems = useProblemCount(atStep(data.index));
  if (!node) return null;
  return (
    <Card problems={problems}>
      <Frame id={node.id} problems={problems}>
        Unknown kind: {node.kind}
      </Frame>
      <Handle type="source" position={Position.Right} id="out" />
    </Card>
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
