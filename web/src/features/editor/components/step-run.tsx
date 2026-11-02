import {
  BanIcon,
  CheckIcon,
  CircleDashedIcon,
  ClockIcon,
  LoaderIcon,
  MinusIcon,
  RotateCwIcon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { JsonBlock } from "@/features/editor/components/mapping-field";
import { withSample } from "@/features/editor/components/step-sample";
import { updateNode } from "@/features/editor/edits";
import { wayLabel, waysInto } from "@/features/editor/flow";
import {
  useRun,
  useRunSteps,
  useStepRun,
} from "@/features/editor/hooks/use-runs";
import { runSaid, said, type StepRun, tookLine } from "@/features/editor/runs";
import { useEditor } from "@/features/editor/store";

const marks = {
  waiting: ClockIcon,
  running: LoaderIcon,
  retrying: RotateCwIcon,
  succeeded: CheckIcon,
  failed: XIcon,
  skipped: MinusIcon,
  cancelled: BanIcon,
  "not run": CircleDashedIcon,
};

// RunMark says how a step went in the run shown: a mark, and the words,
// since a mark or a colour alone isn't a signal.
export function RunMark({ run }: { run: StepRun }) {
  const Mark = marks[run.state];
  return (
    <span
      data-failed={run.state === "failed" || undefined}
      className="inline-flex items-center gap-1 data-failed:text-destructive"
    >
      <Mark
        aria-hidden
        className={run.state === "running" ? "motion-safe:animate-spin" : ""}
      />
      {said(run)}
    </span>
  );
}

// useRecorded is a step's part of the run shown, once the server has it.
function useRecorded(step: string) {
  const id = useEditor((s) => s.run);
  return useRun(id, (run) => run.nodes?.find((n) => n.node === step)).data;
}

// InRun frames what a part of a step's panel says about the run shown.
function InRun({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-5 flex flex-col gap-1.5 rounded-md border p-3 text-sm">
      <h3 className="font-medium">{title}</h3>
      {children}
    </section>
  );
}

// Headers lists headers as name: value lines, in the code font.
function Headers({ headers }: { headers: Record<string, string> }) {
  if (Object.keys(headers).length === 0) return null;
  return (
    <dl className="flex flex-col gap-0.5">
      {Object.entries(headers).map(([name, value]) => (
        <div key={name} className="font-mono break-all">
          <dt className="inline">{name}: </dt>
          <dd className="inline">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// RunSent is what an HTTP step did in the run shown, at the top of its
// Request tab: what it sent, or why it sent nothing.
export function RunSent({ index }: { index: number }) {
  const step = useEditor((s) => s.draft.nodes[index]?.id ?? "");
  const run = useStepRun(step);
  const sent = useRecorded(step)?.request;
  if (!run) return null;
  return (
    <InRun title={`In this run: ${said(run)}`}>
      {run.state === "skipped" && (
        <p className="text-muted-foreground">
          A line it needs wasn&apos;t taken, so it didn&apos;t run.
        </p>
      )}
      {run.error && <p className="text-destructive">{run.error.detail}</p>}
      {sent && (
        <>
          <p>It sent</p>
          <p className="font-mono break-all">
            {sent.method} {sent.url}
          </p>
          <Headers headers={sent.headers} />
          {sent.body !== undefined && <JsonBlock value={sent.body} />}
        </>
      )}
    </InRun>
  );
}

// RunGot is what an HTTP step got back in the run shown, in the tab of the
// response it was (status, none for 2xx), beside that response's sample,
// with a way to keep it as the sample. kept is told once it's been kept.
// Locked, the samples are an upstream's, kept by editing it (plan 07).
export function RunGot({
  index,
  status,
  locked = false,
  kept,
}: {
  index: number;
  status?: number;
  locked?: boolean;
  kept: () => void;
}) {
  const step = useEditor((s) => s.draft.nodes[index]?.id ?? "");
  const edit = useEditor((s) => s.edit);
  const run = useStepRun(step);
  const got = useRecorded(step)?.response;
  if (!run || got?.status === undefined) return null;
  const mine =
    status === undefined
      ? got.status >= 200 && got.status <= 299
      : got.status === status;
  if (!mine) return null;
  const title = status === undefined ? "2xx" : String(status);
  return (
    <InRun
      title={`In this run it got ${got.status}${run.ms === undefined ? "" : `, in ${run.ms} ms`}`}
    >
      <Headers headers={got.headers ?? {}} />
      <JsonBlock value={got.body} />
      {got.truncated ? (
        <p className="text-muted-foreground">
          Too big to keep as the sample: only its first 256 KiB was kept.
        </p>
      ) : locked ? (
        <p className="text-muted-foreground">
          Its samples are the upstream&apos;s: edit the upstream to keep this as
          one.
        </p>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => {
            edit((d) =>
              updateNode(d, index, (n) =>
                withSample(n, status, {
                  ...(status === undefined ? { status: got.status } : {}),
                  ...(got.headers ? { headers: got.headers } : {}),
                  body: got.body,
                }),
              ),
            );
            kept();
          }}
        >
          Keep as the {title} sample
        </Button>
      )}
    </InRun>
  );
}

// RunGave is what a transform step gave in the run shown, the status of
// the case that held among it when it has cases, and the ways it came by,
// the lines into it the steps before it took, when more than one line comes
// into it. One whose Unhandled block took its failure gave nothing of its
// own: its Unhandled says what the block did.
export function RunGave({ index }: { index: number }) {
  const step = useEditor((s) => s.draft.nodes[index]?.id ?? "");
  const run = useStepRun(step);
  const steps = useRunSteps();
  const came = useEditor((s) => {
    const ways = waysInto(s.draft, step);
    return ways.length > 1 && steps
      ? ways
          .filter((w) => tookLine(w.on, steps(w.from), step))
          .map((w) => wayLabel(s.draft, w.from, w.on))
          .join(", ")
      : "";
  });
  const gave = useRecorded(step)?.response;
  if (!run) return null;
  return (
    <InRun title={`In this run: ${said(run)}`}>
      {run.error && <p className="text-destructive">{run.error.detail}</p>}
      {came && (
        <p>
          It came by <span className="font-mono">{came}</span>.
        </p>
      )}
      {gave && run.state === "succeeded" && (
        <>
          <p>It gave{gave.status === undefined ? "" : ` ${gave.status}`}</p>
          <JsonBlock value={gave.body} />
        </>
      )}
    </InRun>
  );
}

// RunCaught is what a step's Unhandled block took in the run shown, in its
// Unhandled: the failure, what an HTTP step got with it, and what the
// block's body gave.
export function RunCaught({ index }: { index: number }) {
  const step = useEditor((s) => s.draft.nodes[index]?.id ?? "");
  const run = useStepRun(step);
  const got = useRecorded(step)?.response;
  if (!run?.error?.caught) return null;
  return (
    <InRun title={`In this run: ${said(run)}`}>
      <p className="text-destructive">{run.error.detail}</p>
      {got?.status !== undefined && (
        <>
          <p>It got {got.status}</p>
          <Headers headers={got.headers ?? {}} />
          <JsonBlock value={got.body} />
        </>
      )}
      {got?.gave !== undefined && (
        <>
          <p>Its Unhandled body gave</p>
          <JsonBlock value={got.gave} />
        </>
      )}
    </InRun>
  );
}

// RunAnswered is what the workflow answered in the run shown, on the
// response card: the status, which the title says, and the body.
export function RunAnswered() {
  const id = useEditor((s) => s.run);
  const run = useRun(id).data;
  if (!run) return null;
  return (
    <InRun title={`In this run: ${runSaid(run)}`}>
      {run.answered !== undefined &&
        (run.output === undefined ? (
          <p className="text-muted-foreground">With no body.</p>
        ) : (
          <>
            <p>
              {run.output_truncated
                ? "Its body's first 256 KiB, as text:"
                : "Its body:"}
            </p>
            <JsonBlock value={run.output} />
          </>
        ))}
    </InRun>
  );
}
