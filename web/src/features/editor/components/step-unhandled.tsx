import { useEffect, useRef } from "react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import {
  JsonBlock,
  MappingField,
  Skipped,
} from "@/features/editor/components/mapping-field";
import { StepConnections } from "@/features/editor/components/step-connections";
import { RunCaught } from "@/features/editor/components/step-run";
import { WholeRunNote } from "@/features/editor/components/whole-run-note";
import {
  joinedTo,
  parents,
  setStepFails,
  setStepUnhandled,
} from "@/features/editor/edits";
import { UNHANDLED } from "@/features/editor/flow";
import {
  asErrors,
  atStep,
  useProblems,
} from "@/features/editor/hooks/use-problems";
import { usePreview } from "@/features/editor/hooks/use-preview";
import { useEditor, useEditorStore } from "@/features/editor/store";

// StepUnhandled is a step's Unhandled block, as its panel shows it: in a
// run, what it took; then what the step does with its failures, chosen
// (plan 12): fail the run, or go on down the lines that leave the block,
// which takes a body of its own then, if it's given one. A transform's
// panel has no tabs, so a click on the strip brings it into view there.
export function StepUnhandled({ index }: { index: number }) {
  const id = useEditor((s) => s.draft.nodes[index]?.id ?? "");
  const http = useEditor((s) => s.draft.nodes[index]?.kind === "http");
  const body = useEditor((s) => s.draft.nodes[index]?.unhandled?.body);
  const fails = useEditor(
    (s) => s.draft.nodes[index]?.unhandled?.fail === true,
  );
  // Whether a line or an answer leaves the block, which takes the failures.
  const leaves = useEditor(
    (s) =>
      id !== "" &&
      ((s.draft.edges ?? []).some((e) => e.from === id && e.unhandled) ||
        joinedTo(s.draft, id, UNHANDLED).length > 0),
  );
  const deciding = useProblems(atStep(index, "unhandled"));
  const edit = useEditor((s) => s.edit);
  const part = useEditor((s) => s.part);
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    // jsdom draws nothing, so it has no scrollIntoView.
    if (part === "unhandled" && !http)
      section.current?.scrollIntoView?.({ block: "nearest" });
  }, [part, http]);
  return (
    <div className="flex flex-col gap-5">
      <RunCaught index={index} />
      <section
        ref={section}
        aria-labelledby={`step-unhandled-${index}`}
        className="flex flex-col gap-3 text-sm"
      >
        <div className="flex items-center gap-1">
          <h3 id={`step-unhandled-${index}`} className="font-medium">
            When it fails
          </h3>
          <Hint about="Unhandled">
            {http
              ? "A status with no response, the connection or a timeout after its retries, a body over the cap or a 2xx body that isn't JSON, an address it may not call, or its JSONata failing."
              : "Its JSONata failing: its expression, or a case's."}{" "}
            The steps after read it as{" "}
            <span className="font-mono">{`nodes.${id}.error`}</span>.
          </Hint>
        </div>
        <FieldError errors={asErrors(deciding)} />
        {/* A line or an answer from the block takes the failures, so the
            run can't fail with them too; one saved with both can still be
            unchecked. */}
        <Field orientation="horizontal" data-disabled={leaves && !fails}>
          <Checkbox
            id="step-unhandled-fail"
            checked={fails}
            disabled={leaves && !fails}
            aria-invalid={deciding.length > 0}
            onCheckedChange={(on) =>
              edit((d) => setStepFails(d, index, on === true))
            }
          />
          <FieldContent>
            <div className="flex items-center gap-1">
              <FieldLabel htmlFor="step-unhandled-fail">
                Fail the run
              </FieldLabel>
              <Hint about="Fail the run">
                The run stops, and the response answers by cause, 502, 504 or
                500, with its error body. To go on instead, connect Unhandled to
                a step or an answer.
              </Hint>
            </div>
          </FieldContent>
        </Field>
      </section>
      {!fails && (
        <>
          <StepConnections index={index} on={UNHANDLED} />
          {body === undefined ? (
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
              Write a body
            </Button>
          ) : (
            <UnhandledBody index={index} id={id} />
          )}
        </>
      )}
    </div>
  );
}

// UnhandledBody edits the JSONata a step's Unhandled block gives, over what
// the step reads with its failure made up, as a run would: the steps after
// read its value as the step's body, and an answer joined straight to the
// block answers with it.
function UnhandledBody({ index, id }: { index: number; id: string }) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const body = useEditor((s) => s.draft.nodes[index]?.unhandled?.body);
  const answers = useEditor(
    (s) => id !== "" && joinedTo(s.draft, id, UNHANDLED).length > 0,
  );
  const preview = usePreview({ step: index });
  const problems = useProblems(atStep(index, "unhandled_body"));
  return (
    <>
      <MappingField
        id="step-unhandled-body"
        label="Unhandled body"
        hint={
          <>
            JSONata over what the step reads, its failure among it. The steps
            after read its value as{" "}
            <span className="font-mono">{`nodes.${id}.body`}</span>, and an
            answer joined to Unhandled answers with it.
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
              <h3 className="font-medium">Gives</h3>
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
        Remove the body
      </Button>
    </>
  );
}
