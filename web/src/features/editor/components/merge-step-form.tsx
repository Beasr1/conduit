import { ChevronRightIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  JsonBlock,
  MappingField,
  Skipped,
} from "@/features/editor/components/mapping-field";
import { ProblemMark } from "@/features/editor/components/problem-mark";
import { StepConnections } from "@/features/editor/components/step-connections";
import { RunGave } from "@/features/editor/components/step-run";
import { StepUnhandled } from "@/features/editor/components/step-unhandled";
import { WholeRunNote } from "@/features/editor/components/whole-run-note";
import {
  connect,
  joinedTo,
  newWays,
  parents,
  updateNode,
} from "@/features/editor/edits";
import {
  lineFrom,
  toFlow,
  wayFromHandle,
  wayHandle,
  wayLabel,
  waysInto,
} from "@/features/editor/flow";
import {
  atStep,
  useProblemCount,
  useProblems,
} from "@/features/editor/hooks/use-problems";
import { usePreview } from "@/features/editor/hooks/use-preview";
import { useEditor, useEditorStore } from "@/features/editor/store";

// MergeStepForm edits a Merge step: the ways it can come by, with one to
// add; its expression, which makes its value from whatever came, between
// what it reads and what it gives, simulated over the samples; then what
// follows it, and its Unhandled.
export function MergeStepForm({ index }: { index: number }) {
  return (
    <>
      <RunGave index={index} />
      <Ways index={index} />
      <MergeExpression index={index} />
      <StepConnections index={index} />
      <StepUnhandled index={index} />
    </>
  );
}

// Ways lists the connections into a Merge step, each opening its line,
// where its condition is, and adds one from another step's response, as
// drawing a line to + Add on the step does, so it can be done from the
// keyboard too (WCAG 2.5.7).
function Ways({ index }: { index: number }) {
  const edit = useEditor((s) => s.edit);
  const id = useEditor((s) => s.draft.nodes[index]?.id ?? "");
  const edges = useEditor(
    useShallow((s) => waysInto(s.draft, id).map((w) => w.index)),
  );
  const labels = useEditor(
    useShallow((s) =>
      waysInto(s.draft, id).map((w) => wayLabel(s.draft, w.from, w.on)),
    ),
  );
  const offered = useEditor(
    useShallow((s) =>
      newWays(s.draft, id).map((w) =>
        wayHandle({ from: w.from, ...lineFrom(w.on) }),
      ),
    ),
  );
  const named = useEditor(
    useShallow((s) =>
      newWays(s.draft, id).map((w) => wayLabel(s.draft, w.from, w.on)),
    ),
  );
  return (
    <section className="flex flex-col gap-3 text-sm">
      <div className="flex flex-col gap-1.5">
        <h3 className="font-medium">Ways</h3>
        <p className="text-muted-foreground">
          It waits for every line into it to end, then runs if any came, its
          expression reading whichever did.
        </p>
        {edges.length === 0 ? (
          <p className="text-muted-foreground">
            None yet: add one below, or draw a line from a step&apos;s point to
            + Add on this step.
          </p>
        ) : (
          <ul className="flex flex-col">
            {edges.map((k, j) => (
              <WayRow key={k} edge={k} label={labels[j] ?? ""} />
            ))}
          </ul>
        )}
      </div>
      <Field>
        <FieldLabel htmlFor={`merge-add-way-${index}`}>
          Add a way from
        </FieldLabel>
        <Select<string>
          value={null}
          disabled={offered.length === 0}
          onValueChange={(handle) => {
            if (handle === null) return;
            const w = wayFromHandle(handle);
            edit((d) => connect(d, w.from, id, w.on));
          }}
        >
          <SelectTrigger id={`merge-add-way-${index}`} className="w-full">
            <SelectValue
              placeholder={
                offered.length === 0
                  ? "No step to add a way from"
                  : "Pick a step's response"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {offered.map((h, k) => (
              <SelectItem key={h} value={h}>
                {named[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </section>
  );
}

// WayRow is one way into a Merge step: where it comes from, and when it's
// taken. A click opens its line, as a click on the canvas does.
function WayRow({ edge, label }: { edge: number; label: string }) {
  const editor = useEditorStore();
  const show = useEditor((s) => s.show);
  const when = useEditor((s) => s.draft.edges?.[edge]?.when);
  const problems = useProblemCount(
    (p) => p.on === "connection" && p.index === edge,
  );

  // The canvas names a connection by its key, which toFlow gives it. It's
  // worked out on a click, not on every draw.
  function open() {
    const key = toFlow(editor.getState().draft).edges.find(
      (e) => e.data?.index === edge,
    )?.id;
    if (key) show("edges", key);
  }

  return (
    <li>
      <Button
        variant="ghost"
        className="h-auto w-full justify-start gap-2 py-1.5 text-left font-normal [&_svg]:size-3.5"
        onClick={open}
      >
        {/* The spaces are text of their own: a name drops one at the end of
            an element's text, and a flex row doesn't draw them. */}
        <span className="sr-only">Way from</span>{" "}
        <span className="font-mono">{label}</span>{" "}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {when ? (
            <>
              if <span className="font-mono">{when}</span>
            </>
          ) : (
            "always"
          )}
        </span>
        {problems > 0 && <ProblemMark count={problems} />}
        <ChevronRightIcon aria-hidden />
      </Button>
    </li>
  );
}

// MergeExpression edits a Merge step's expression: JSONata over the steps
// before it, whichever came, that makes its value. Its value goes to callers
// only once the step answers, so only then is sending the run warned about.
function MergeExpression({ index }: { index: number }) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const id = useEditor((s) => s.draft.nodes[index]?.id ?? "");
  const expr = useEditor((s) => s.draft.nodes[index]?.expr);
  const answers = useEditor(
    (s) => id !== "" && joinedTo(s.draft, id).length > 0,
  );
  const preview = usePreview({ step: index });
  const problems = useProblems(atStep(index, "expr"));
  return (
    <>
      <MappingField
        id="step-expr"
        label="Expression"
        description={
          <>
            JSONata over the steps before it, whichever came; one that
            didn&apos;t run is missing, so{" "}
            <span className="font-mono">$exists(nodes.a) ? … : …</span> picks.
            Steps after this one read its value as{" "}
            <span className="font-mono">{`nodes.${id}.body`}</span>.
          </>
        }
        initial={editor.getState().draft.nodes[index]?.expr ?? ""}
        apply={(text) =>
          edit((d) => updateNode(d, index, (n) => ({ ...n, expr: text })))
        }
        problems={problems}
        preview={preview}
        open={(of) => parents(of, of.nodes[index]?.id)}
        result={(p) =>
          p.skipped ? (
            <Skipped />
          ) : (
            <>
              <h3 className="font-medium">It gives</h3>
              {p.gives === undefined ? (
                <p className="text-muted-foreground">Nothing.</p>
              ) : (
                <JsonBlock value={p.gives} />
              )}
            </>
          )
        }
      />
      {answers && <WholeRunNote text={expr} />}
    </>
  );
}
