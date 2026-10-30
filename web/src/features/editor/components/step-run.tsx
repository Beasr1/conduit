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
import { useRun, useStepRun } from "@/features/editor/hooks/use-runs";
import { runSaid, said, type StepRun } from "@/features/editor/runs";
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
          No line into it was taken, so it didn&apos;t run.
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
export function RunGot({
  index,
  status,
  kept,
}: {
  index: number;
  status?: number;
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

// RunGave is what a transform step gave in the run shown.
export function RunGave({ index }: { index: number }) {
  const step = useEditor((s) => s.draft.nodes[index]?.id ?? "");
  const run = useStepRun(step);
  const gave = useRecorded(step)?.response;
  if (!run) return null;
  return (
    <InRun title={`In this run: ${said(run)}`}>
      {run.error && <p className="text-destructive">{run.error.detail}</p>}
      {gave && (
        <>
          <p>It gave</p>
          <JsonBlock value={gave.body} />
        </>
      )}
    </InRun>
  );
}

// RunAnswered is what the workflow answered in the run shown, on the
// response card.
export function RunAnswered() {
  const id = useEditor((s) => s.run);
  const run = useRun(id).data;
  if (!run) return null;
  return (
    <InRun title={`In this run: ${runSaid(run)}`}>
      {run.output !== undefined && (
        <>
          <p>It answered</p>
          {run.output_truncated ? (
            <p className="text-muted-foreground">Its first 256 KiB, as text:</p>
          ) : null}
          <JsonBlock value={run.output} />
        </>
      )}
    </InRun>
  );
}
