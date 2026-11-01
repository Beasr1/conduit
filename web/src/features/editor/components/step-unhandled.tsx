import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import {
  JsonBlock,
  MappingField,
  Skipped,
} from "@/features/editor/components/mapping-field";
import { StepConnections } from "@/features/editor/components/step-connections";
import { RunCaught } from "@/features/editor/components/step-run";
import { WholeRunNote } from "@/features/editor/components/whole-run-note";
import { joinedTo, parents, setStepUnhandled } from "@/features/editor/edits";
import { UNHANDLED } from "@/features/editor/flow";
import { atStep, useProblems } from "@/features/editor/hooks/use-problems";
import { usePreview } from "@/features/editor/hooks/use-preview";
import { useEditor, useEditorStore } from "@/features/editor/store";

// StepUnhandled is a step's Unhandled block, as its panel shows it: in a
// run, what it took; what it takes, and what the steps after it read; its
// body, if it has one, with what that gives over a failure made up; then the
// lines that leave it. Once an HTTP step's is joined straight to an answer
// with no body, it warns that callers get what the upstream sent. A
// transform's panel has no tabs, so a click on the strip brings it into
// view there.
export function StepUnhandled({ index }: { index: number }) {
  const id = useEditor((s) => s.draft.nodes[index]?.id ?? "");
  const kind: string = useEditor((s) => s.draft.nodes[index]?.kind ?? "");
  const http = kind === "http";
  const body = useEditor((s) => s.draft.nodes[index]?.unhandled?.body);
  const answers = useEditor(
    (s) => id !== "" && joinedTo(s.draft, id, UNHANDLED).length > 0,
  );
  const edit = useEditor((s) => s.edit);
  const part = useEditor((s) => s.part);
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    // jsdom draws nothing, so it has no scrollIntoView.
    if (part === "unhandled" && !http)
      section.current?.scrollIntoView?.({ block: "nearest" });
  }, [part, http]);
  const node = <span className="font-mono">{`nodes.${id}.error`}</span>;
  return (
    <div className="flex flex-col gap-5">
      <RunCaught index={index} />
      <section
        ref={section}
        aria-labelledby={`step-unhandled-${index}`}
        className="flex flex-col gap-1.5 text-sm"
      >
        <h3 id={`step-unhandled-${index}`} className="font-medium">
          Unhandled
        </h3>
        <p className="text-muted-foreground">
          {http
            ? "It takes what the step's responses don't: a status none of them is for, the connection or a timeout after its retries, a body over the cap or a 2xx body that isn't JSON, an address it may not call, or its JSONata failing."
            : kind === "merge"
              ? "It takes the step's JSONata failing: its expression."
              : "It takes the step's JSONata failing: its expression, or a case's condition or body."}{" "}
          Joined, the run goes on down the lines from here. With none, the
          failure fails the run, and the response&apos;s Unhandled answers it.
        </p>
        <p className="text-muted-foreground">
          The steps after read the failure as {node},{" "}
          <span className="font-mono">{"{ code, detail }"}</span>
          {http && (
            <>
              , beside <span className="font-mono">status</span>,{" "}
              <span className="font-mono">headers</span> and{" "}
              <span className="font-mono">body</span> when the upstream answered
            </>
          )}
          .
        </p>
      </section>
      {body === undefined ? (
        <section className="flex flex-col gap-1.5 text-sm">
          <p className="text-muted-foreground">
            {http
              ? "As its body, it gives what the upstream sent, if anything."
              : "It gives no body."}{" "}
            Write your own to give a fallback: the steps after read it as{" "}
            <span className="font-mono">{`nodes.${id}.body`}</span>, and an
            answer joined straight to the block answers with it.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() =>
              edit((d) =>
                setStepUnhandled(
                  d,
                  index,
                  `{ 'error': nodes.${id}.error.detail }`,
                ),
              )
            }
          >
            Write your own
          </Button>
        </section>
      ) : (
        <UnhandledBody index={index} id={id} answers={answers} />
      )}
      <StepConnections index={index} on={UNHANDLED} />
      {answers && http && body === undefined && (
        <p className="flex gap-1.5 text-sm text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
          <TriangleAlertIcon aria-hidden />
          Callers get whatever the upstream sent with its failure, an error page
          or a stack trace included. To send them less, write a body for
          Unhandled.
        </p>
      )}
    </div>
  );
}

// UnhandledBody edits the JSONata a step's Unhandled block gives, over what
// the step reads with its failure made up, as a run would: the steps after
// read its value as the step's body, and an answer joined straight to the
// block answers with it.
function UnhandledBody({
  index,
  id,
  answers,
}: {
  index: number;
  id: string;
  answers: boolean;
}) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const body = useEditor((s) => s.draft.nodes[index]?.unhandled?.body);
  const preview = usePreview({ step: index });
  const problems = useProblems(atStep(index, "unhandled_body"));
  return (
    <>
      <MappingField
        id="step-unhandled-body"
        label="Unhandled body"
        description={
          <>
            JSONata over what the step reads, its failure among it. The steps
            after read its value as{" "}
            <span className="font-mono">{`nodes.${id}.body`}</span>, and an
            answer joined straight to the block answers with it.
          </>
        }
        initial={editor.getState().draft.nodes[index]?.unhandled?.body ?? ""}
        apply={(text) => edit((d) => setStepUnhandled(d, index, text))}
        problems={problems}
        preview={preview}
        open={(of) => [...parents(of, of.nodes[index]?.id), id]}
        reads={(p) => p.unhandled?.reads ?? p.reads}
        result={(p) =>
          p.skipped ? (
            <Skipped />
          ) : (
            <>
              <h3 className="font-medium">It gives</h3>
              {p.unhandled?.gives === undefined ? (
                <p className="text-muted-foreground">Nothing.</p>
              ) : (
                <JsonBlock value={p.unhandled.gives} />
              )}
            </>
          )
        }
      />
      {answers && <WholeRunNote text={body} />}
      <Button
        variant="ghost"
        size="xs"
        className="self-start"
        onClick={() => edit((d) => setStepUnhandled(d, index, undefined))}
      >
        Give what the step got instead
      </Button>
    </>
  );
}
