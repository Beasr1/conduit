import {
  Handle,
  type NodeProps,
  Position,
  useUpdateNodeInternals,
} from "@xyflow/react";
import { CheckIcon } from "lucide-react";
import { memo, type ReactNode, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";

import { ProblemMark } from "@/features/editor/components/problem-mark";
import { RunMark } from "@/features/editor/components/step-run";
import {
  exitsOf,
  type FlowNode,
  handlesOf,
  UNHANDLED,
  UNHANDLED_HANDLE,
} from "@/features/editor/flow";
import { atStep, useProblemCount } from "@/features/editor/hooks/use-problems";
import { useRun, useStepRun } from "@/features/editor/hooks/use-runs";
import { runSaid, wayOf } from "@/features/editor/runs";
import { type Refused, useEditor } from "@/features/editor/store";

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
      <span className="truncate text-xs text-muted-foreground [&_svg]:size-3 [&_svg]:shrink-0">
        {children}
      </span>
    </div>
  );
}

// Card is a step's outline, marked when the step has problems: its blocks
// in a row, and its Unhandled strip along the bottom.
function Card({
  problems,
  strip,
  children,
}: {
  problems: number;
  strip?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-problems={problems > 0 || undefined}
      className="relative flex h-full w-full flex-col rounded-lg border bg-card text-card-foreground shadow-xs data-problems:border-destructive"
    >
      <div className="relative flex min-h-0 flex-1">{children}</div>
      {strip}
    </div>
  );
}

// UnhandledStrip is a step's Unhandled block, along the bottom of its card:
// it takes what the step's other blocks don't, its failures, once a line
// leaves its handle, and the run goes on down those lines. Until one does,
// it's dimmed, and says what's chosen: the failure fails the run, or that
// nothing is yet (plan 12). It names the answers its failures join, as the
// canvas draws those lines only while they're picked. While a run is shown,
// it's marked when the step's failure went to it.
function UnhandledStrip({ step }: { step: string }) {
  const fails = useEditor(
    (s) => s.draft.nodes.find((n) => n.id === step)?.unhandled?.fail === true,
  );
  const answers = useEditor((s) =>
    step === ""
      ? ""
      : (s.draft.response?.answers ?? [])
          .filter((a) =>
            (a.lines ?? []).some((l) => l.from === step && l.unhandled),
          )
          .map((a) => a.status)
          .join(", "),
  );
  const lined = useEditor(
    (s) =>
      step !== "" &&
      (s.draft.edges ?? []).some((e) => e.from === step && e.unhandled),
  );
  const joined = lined || answers !== "";
  const run = useStepRun(step);
  const took = run !== undefined && wayOf(run) === UNHANDLED;
  return (
    <div
      data-part="unhandled"
      data-unjoined={!joined || undefined}
      className="relative flex h-6 shrink-0 items-center gap-1 border-t px-3 text-xs data-unjoined:text-muted-foreground [&_svg]:size-3"
    >
      <span className="font-mono">Unhandled</span>
      {answers !== "" && (
        <>
          {" "}
          <span>→ {answers}</span>
        </>
      )}
      {!joined && (
        <>
          {" "}
          <span>· {fails ? "fails the run" : "not decided"}</span>
        </>
      )}
      {took && (
        <>
          <CheckIcon aria-hidden />
          <span className="sr-only">, the block its failure took</span>
        </>
      )}
      <Handle type="source" position={Position.Right} id={UNHANDLED_HANDLE} />
    </div>
  );
}

// Each node reads only its own node from the draft, so editing one node
// redraws only that one. An HTTP step is blocks: its request on the left,
// and on the right a block per response, with the handle its connections
// leave from, then + Add, and its Unhandled strip along the bottom. Each
// block says which part of the step it is, and the canvas opens that part
// when it's clicked.
const HttpNode = memo(function HttpNode({ id, data }: NodeProps<FlowNode>) {
  const node = useEditor((s) => s.draft.nodes[data.index]);
  const problems = useProblemCount(atStep(data.index));
  const outputs = node ? handlesOf(node) : [];
  // React Flow finds a node's handles when it mounts; one added or taken
  // away later has to be pointed out.
  const update = useUpdateNodeInternals();
  const handles = outputs.join(" ");
  useEffect(() => update(id), [update, id, handles]);
  // While a run is shown, the request block says how the step went, and
  // the response it got is marked.
  const run = useStepRun(node?.id ?? "");
  const got =
    run?.state !== "succeeded" || run.status === undefined
      ? undefined
      : run.status >= 200 && run.status <= 299
        ? "2xx"
        : String(run.status);
  if (!node) return null;
  return (
    <Card problems={problems} strip={<UnhandledStrip step={node.id} />}>
      <Frame id={node.id} problems={problems} part="request">
        {run ? (
          <RunMark run={run} />
        ) : node.request ? (
          `${node.request.method} ${node.request.url || "(no URL yet)"}`
        ) : (
          "No request yet"
        )}
      </Frame>
      <div className="flex w-18 shrink-0 flex-col border-l font-mono text-xs">
        {outputs.map((o) => (
          <div
            key={o}
            data-part={o}
            className="relative flex flex-1 items-center gap-1 border-b px-2.5 [&_svg]:size-3"
          >
            {o}
            {o === got && (
              <>
                <CheckIcon aria-hidden />
                <span className="sr-only">, the response it got</span>
              </>
            )}
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

// A transform step with an expression gives its value from its one point on
// the right. One with cases is blocks, as an HTTP step is: its id on the
// left, and on the right an exit per case, each named and with its status
// and the handle its lines leave from, then + Case, with its Unhandled strip
// along the bottom, which takes no case holding. A click on a block opens
// its tab.
const TransformNode = memo(function TransformNode({
  id,
  data,
}: NodeProps<FlowNode>) {
  const node = useEditor((s) => s.draft.nodes[data.index]);
  const problems = useProblemCount(atStep(data.index));
  const run = useStepRun(node?.id ?? "");
  // React Flow finds a node's handles when it mounts; an exit added or
  // taken away later has to be pointed out.
  const update = useUpdateNodeInternals();
  const handles = (node ? handlesOf(node) : []).join(" ");
  useEffect(() => update(id), [update, id, handles]);
  if (!node) return null;
  // While a run is shown, the exit it took is marked.
  const took = run?.state === "succeeded" ? run.status : undefined;
  return (
    <Card problems={problems} strip={<UnhandledStrip step={node.id} />}>
      <Frame id={node.id} problems={problems}>
        {run ? (
          <RunMark run={run} />
        ) : node.switch ? (
          "Cases"
        ) : (
          node.expr || "No expression yet"
        )}
      </Frame>
      {node.switch ? (
        <div className="flex w-32 shrink-0 flex-col border-l font-mono text-xs">
          {/* The status names the exit, so it stays whole; the name gives
              way. */}
          {exitsOf(node).map((exit) => (
            <div
              key={exit.part}
              data-part={exit.part}
              className="relative flex min-w-0 flex-1 items-center gap-1 border-b px-2.5 [&_svg]:size-3 [&_svg]:shrink-0"
            >
              <span className="min-w-0 truncate">{exit.label}</span>{" "}
              <span className="shrink-0">· {exit.status}</span>
              {exit.status === took && (
                <>
                  <CheckIcon aria-hidden />
                  <span className="sr-only">, the case that held</span>
                </>
              )}
              <Handle
                type="source"
                position={Position.Right}
                id={String(exit.status)}
              />
            </div>
          ))}
          <div
            data-part="add"
            className="flex flex-1 items-center px-2.5 text-muted-foreground"
          >
            + Case
          </div>
        </div>
      ) : (
        <Handle type="source" position={Position.Right} id="out" />
      )}
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

// The response card ends the graph: what the workflow's API answers. Its
// answers are blocks on its left, top to bottom as a run tries them (plan
// 14), then + Add, each with its point, where lines arrive from the steps
// that give it; an answer no line reaches yet is dimmed. It names Conduit's
// own answers too, and along its bottom, its Unhandled: the body for a run
// that gives no answer, yours or Conduit's. Each block says which part it
// is, for the canvas to open. While a run is shown, the card says how it
// went, and the answer it gave is marked, Unhandled when a run that failed
// was answered with it. Below it, a status says why a line it just refused
// couldn't be drawn; it's there, empty, all along, so a screen reader hears
// it fill.
const ResponseNode = memo(function ResponseNode({ id }: NodeProps<FlowNode>) {
  const statuses = useEditor(
    useShallow((s) => (s.draft.response?.answers ?? []).map((a) => a.status)),
  );
  // The steps each answer's lines come from, joined by a space, as a
  // selector keeps a list of strings.
  const froms = useEditor(
    useShallow((s) =>
      (s.draft.response?.answers ?? []).map((a) =>
        (a.lines ?? []).map((l) => l.from).join(" "),
      ),
    ),
  );
  const errors = useEditor((s) => s.draft.response?.errors !== undefined);
  const refused = useEditor((s) => s.refused);
  const problems = useProblemCount((p) => p.on === "response");
  const shown = useEditor((s) => s.run);
  const said = useRun(shown, (r) => `In this run: ${runSaid(r)}`).data;
  const answered = useRun(shown, (r) =>
    r.status === "succeeded" ? r.answered : undefined,
  ).data;
  const caught = useRun(
    shown,
    (r) => r.status === "failed" && r.answered !== undefined,
  ).data;
  // The card grows with its answers, each with its point.
  const update = useUpdateNodeInternals();
  useEffect(() => update(id), [update, id, statuses.length]);
  const steps = [
    ...new Set(froms.flatMap((f) => f.split(" ")).filter((f) => f !== "")),
  ];
  return (
    <div
      data-problems={problems > 0 || undefined}
      className="relative flex h-full w-full flex-col rounded-lg border border-dashed bg-card text-card-foreground shadow-xs data-problems:border-destructive"
    >
      <div className="relative flex min-h-0 flex-1">
        <div className="flex w-18 shrink-0 flex-col border-r font-mono text-xs">
          {statuses.map((status, k) => (
            <div
              key={k}
              data-part={String(status)}
              data-unjoined={froms[k] === "" || undefined}
              className="relative flex flex-1 items-center gap-1 border-b px-2.5 data-unjoined:text-muted-foreground [&_svg]:size-3"
            >
              <Handle
                type="target"
                position={Position.Left}
                id={String(k)}
                className="block-point"
              />
              {status}
              {status === answered && (
                <>
                  <CheckIcon aria-hidden />
                  <span className="sr-only">, the answer it gave</span>
                </>
              )}
            </div>
          ))}
          <div
            data-part="add"
            className="flex flex-1 items-center px-2.5 text-muted-foreground"
          >
            + Add
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-3">
          <span className="flex items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
            <span className="truncate text-sm font-medium">Response</span>
            {problems > 0 && <ProblemMark count={problems} />}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {said ??
              (steps.length > 0
                ? `From ${steps.join(", ")}`
                : "Nothing answers yet")}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            also 4xx · 5xx
          </span>
        </div>
      </div>
      <div
        data-part="unhandled"
        className="flex h-6 shrink-0 items-center gap-1 border-t border-dashed px-3 text-xs [&_svg]:size-3"
      >
        <span className="font-mono">Unhandled</span>{" "}
        <span className="truncate text-muted-foreground">
          · {errors ? "your error body" : "problem details"}
        </span>
        {caught && (
          <>
            <CheckIcon aria-hidden />
            <span className="sr-only">, the answer it gave</span>
          </>
        )}
      </div>
      <p
        role="status"
        className={
          refused
            ? "absolute top-full left-0 mt-2 w-full rounded-md border bg-popover p-2 text-xs text-popover-foreground shadow-md"
            : "sr-only"
        }
      >
        {refused && <Refusal refused={refused} />}
      </p>
    </div>
  );
});

// Refusal says why a line into the response couldn't be drawn: there's no
// answer to join yet, or the line was let go off an answer's point.
function Refusal({ refused: { step } }: { refused: Refused }) {
  const answers = useEditor(useShallow((s) => s.draft.response?.answers ?? []));
  const name = (id: string) => <span className="font-mono">{id}</span>;
  if (answers.length === 0)
    return <>Add an answer with + Add, then join {name(step)} to it.</>;
  return (
    <>
      Let go on the answer {name(step)} gives:{" "}
      {answers.map((a) => a.status).join(" or ")}.
    </>
  );
}

// At module scope: React Flow redraws every node when this object changes.
export const nodeTypes = {
  http: HttpNode,
  transform: TransformNode,
  unknown: UnknownNode,
  response: ResponseNode,
};
