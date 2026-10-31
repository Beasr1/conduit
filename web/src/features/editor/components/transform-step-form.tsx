import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  JsonBlock,
  MappingField,
  Reads,
  Skipped,
} from "@/features/editor/components/mapping-field";
import { StepConnections } from "@/features/editor/components/step-connections";
import { RunGave } from "@/features/editor/components/step-run";
import { StepUnhandled } from "@/features/editor/components/step-unhandled";
import { WholeRunNote } from "@/features/editor/components/whole-run-note";
import {
  addCase,
  joinedTo,
  moveCase,
  parents,
  removeCase,
  toSwitch,
  updateCase,
  updateNode,
  updateOtherwise,
} from "@/features/editor/edits";
import { whole } from "@/features/editor/fields";
import {
  asErrors,
  atStep,
  useProblems,
} from "@/features/editor/hooks/use-problems";
import { usePreview } from "@/features/editor/hooks/use-preview";
import type { Found, Place, StepField } from "@/features/editor/problems";
import { useEditor, useEditorStore } from "@/features/editor/store";
import type { components } from "@/gen/schema";

type Definition = components["schemas"]["Definition"];
type Preview = components["schemas"]["Preview"];

// The statuses a case can answer with, as schema/workflow.yaml allows.
const MIN_STATUS = 200;
const MAX_STATUS = 599;

// TransformStepForm edits a transform step: one expression, or cases that
// pick its status and body, between the data it reads and what it gives,
// simulated over the samples; then what follows it.
export function TransformStepForm({ index }: { index: number }) {
  const cases = useEditor((s) => s.draft.nodes[index]?.switch !== undefined);
  return (
    <>
      <RunGave index={index} />
      {cases ? <SwitchForm index={index} /> : <ExpressionForm index={index} />}
      <StepConnections index={index} />
      <StepUnhandled index={index} />
    </>
  );
}

// The status a step answers with by default: the first answer it's joined
// to, else 200.
function firstAnswer(d: Definition, index: number): number {
  const id = d.nodes[index]?.id ?? "";
  const k = joinedTo(d, id)[0];
  return d.response?.answers?.[k ?? -1]?.status ?? 200;
}

// ExpressionForm edits a transform step's one expression, and turns it into
// cases, the expression the body of Otherwise. Its value goes to callers
// only once the step answers, so only then is sending the run warned about.
function ExpressionForm({ index }: { index: number }) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const id = useEditor((s) => s.draft.nodes[index]?.id ?? "");
  const expr = useEditor((s) => s.draft.nodes[index]?.expr);
  const answers = useEditor((s) => joinedTo(s.draft, id).length > 0);
  const preview = usePreview({ step: index });
  const problems = useProblems(atStep(index, "expr"));
  return (
    <>
      <MappingField
        id="step-expr"
        label="Expression"
        description={
          <>
            JSONata over the input. Steps after this one read its value as{" "}
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
      <section className="flex flex-col gap-1.5 text-sm">
        <h3 className="font-medium">Cases</h3>
        <p className="text-muted-foreground">
          To pick the status it answers with by conditions, use cases: this
          expression becomes the body of Otherwise, the answer when no case
          holds.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() =>
            edit((d) =>
              updateNode(d, index, (n) => toSwitch(n, firstAnswer(d, index))),
            )
          }
        >
          Use cases
        </Button>
      </section>
    </>
  );
}

// SwitchForm edits a transform step's cases: what it reads, once, then each
// case's condition, status and body, then Otherwise's, then what it gives
// over the samples. A field picked from what it reads goes where the cursor
// was last, or, before any field has had it, into the first case's
// condition, or Otherwise's body. The cases' fields are keyed by the times
// cases were added, moved or removed, so each starts afresh from the draft
// after one is, rather than keeping another case's text.
function SwitchForm({ index }: { index: number }) {
  const edit = useEditor((s) => s.edit);
  const count = useEditor(
    (s) => s.draft.nodes[index]?.switch?.cases?.length ?? 0,
  );
  const preview = usePreview({ step: index });
  const [layout, setLayout] = useState(0);
  const target = useRef<((path: string) => void) | undefined>(undefined);
  const relaid = (change: (d: Definition) => Definition) => {
    target.current = undefined;
    edit(change);
    setLayout((n) => n + 1);
  };
  const aim: Aim = {
    focused: (insert) => {
      target.current = insert;
    },
    first: (insert) => {
      target.current ??= insert;
    },
  };
  return (
    <>
      <Reads
        into="the field the cursor was last in"
        preview={preview}
        open={(of) => parents(of, of.nodes[index]?.id)}
        onPick={(path) => target.current?.(path)}
      />
      <section className="flex flex-col gap-3 text-sm">
        <div className="flex flex-col gap-1.5">
          <h3 className="font-medium">Cases</h3>
          <p className="text-muted-foreground">
            The first case whose condition holds gives the status and body it
            answers with; Otherwise does when none does. Each status is an
            answer on the response this step is joined to.
          </p>
        </div>
        {Array.from({ length: count }, (_, k) => (
          <CaseFields
            key={`${layout}-${k}`}
            index={index}
            k={k}
            count={count}
            aim={aim}
            relaid={relaid}
          />
        ))}
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => relaid((d) => addCase(d, index, nextStatus(d, index)))}
        >
          + Add a case
        </Button>
      </section>
      <OtherwiseFields
        key={`otherwise-${layout}`}
        index={index}
        aim={aim}
        first={count === 0}
      />
      {preview.data !== undefined && (
        <section className="flex flex-col gap-1.5 text-sm">
          <Gives preview={preview.data.preview} />
        </section>
      )}
    </>
  );
}

// Aim is how a switch's fields say where a picked path goes: the field
// focused, else the first.
interface Aim {
  focused: (insert: (path: string) => void) => void;
  first: (insert: (path: string) => void) => void;
}

// nextStatus is a new case's status: an answer the step is joined to that
// no case gives yet, else Otherwise's.
function nextStatus(d: Definition, index: number): number {
  const s = d.nodes[index]?.switch;
  const gives = [s?.otherwise.status, ...(s?.cases ?? []).map((c) => c.status)];
  const id = d.nodes[index]?.id ?? "";
  const free = joinedTo(d, id)
    .map((k) => d.response?.answers?.[k]?.status)
    .find((status) => status !== undefined && !gives.includes(status));
  return free ?? s?.otherwise.status ?? 200;
}

// Gives is what a switch gives over the samples: the status and body of
// the case that holds.
function Gives({ preview }: { preview: Preview }) {
  if (preview.skipped) return <Skipped />;
  const gives = preview.gives as
    { status?: number; body?: unknown } | undefined;
  return (
    <>
      <h3 className="font-medium">
        {gives?.status === undefined
          ? "It gives"
          : `It answers ${gives.status}`}
      </h3>
      {gives === undefined ? (
        <p className="text-muted-foreground">Nothing.</p>
      ) : gives.body === undefined ? (
        <p className="text-muted-foreground">With no body.</p>
      ) : (
        <JsonBlock value={gives.body} />
      )}
    </>
  );
}

// CaseFields edits case k: its condition, status and body, and moves or
// removes it.
function CaseFields({
  index,
  k,
  count,
  aim,
  relaid,
}: {
  index: number;
  k: number;
  count: number;
  aim: Aim;
  relaid: (change: (d: Definition) => Definition) => void;
}) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const c = editor.getState().draft.nodes[index]?.switch?.cases?.[k];
  const body = useEditor((s) => s.draft.nodes[index]?.switch?.cases?.[k]?.body);
  const mine = (field: StepField) => (p: Place) =>
    p.on === "step" && p.index === index && p.field === field && p.case === k;
  const whenProblems = useProblems(mine("case_when"));
  const statusProblems = useProblems(mine("case_status"));
  const bodyProblems = useProblems(mine("case_body"));
  const n = k + 1;
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-medium">Case {n}</h4>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Move case ${n} up`}
            disabled={k === 0}
            onClick={() => relaid((d) => moveCase(d, index, k, k - 1))}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Move case ${n} down`}
            disabled={k === count - 1}
            onClick={() => relaid((d) => moveCase(d, index, k, k + 1))}
          >
            <ArrowDownIcon />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Remove case ${n}`}
            onClick={() => relaid((d) => removeCase(d, index, k))}
          >
            Remove
          </Button>
        </div>
      </div>
      <ExprField
        id={`step-case-${k}-when`}
        label={`Case ${n} when`}
        description="JSONata over the input, true or false, as a connection's condition is."
        initial={c?.when ?? ""}
        apply={(text) =>
          edit((d) => updateCase(d, index, k, (c) => ({ ...c, when: text })))
        }
        problems={whenProblems}
        aim={aim}
        first={k === 0}
      />
      <StatusField
        id={`step-case-${k}-status`}
        label={`Case ${n} status`}
        initial={c?.status}
        apply={(status) =>
          edit((d) => updateCase(d, index, k, (c) => ({ ...c, status })))
        }
        problems={statusProblems}
      />
      <ExprField
        id={`step-case-${k}-body`}
        label={`Case ${n} body`}
        description="JSONata whose value is the body. Empty sends none."
        initial={c?.body ?? ""}
        apply={(text) =>
          edit((d) => updateCase(d, index, k, (c) => withBody(c, text)))
        }
        problems={bodyProblems}
        aim={aim}
      />
      <WholeRunNote text={body} />
    </div>
  );
}

// OtherwiseFields edits Otherwise: the status and body a switch gives when
// no case holds.
function OtherwiseFields({
  index,
  aim,
  first,
}: {
  index: number;
  aim: Aim;
  first: boolean;
}) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const o = editor.getState().draft.nodes[index]?.switch?.otherwise;
  const body = useEditor((s) => s.draft.nodes[index]?.switch?.otherwise.body);
  const statusProblems = useProblems(atStep(index, "otherwise_status"));
  const bodyProblems = useProblems(atStep(index, "otherwise_body"));
  const statuses = useEditor(
    useShallow((s) =>
      (s.draft.nodes[index]?.switch?.cases ?? []).map((c) => c.status),
    ),
  );
  return (
    <section className="flex flex-col gap-3 rounded-md border p-3 text-sm">
      <h4 className="font-medium">Otherwise</h4>
      <p className="text-muted-foreground">
        {statuses.length === 0
          ? "With no cases, it always answers this."
          : "When no case holds."}
      </p>
      <StatusField
        id="step-otherwise-status"
        label="Otherwise status"
        initial={o?.status}
        apply={(status) =>
          edit((d) => updateOtherwise(d, index, (o) => ({ ...o, status })))
        }
        problems={statusProblems}
      />
      <ExprField
        id="step-otherwise-body"
        label="Otherwise body"
        description="JSONata whose value is the body. Empty sends none."
        initial={o?.body ?? ""}
        apply={(text) =>
          edit((d) => updateOtherwise(d, index, (o) => withBody(o, text)))
        }
        problems={bodyProblems}
        aim={aim}
        first={first}
      />
      <WholeRunNote text={body} />
    </section>
  );
}

// withBody gives a case, or Otherwise, the body text; empty, none.
function withBody<T extends { body?: string }>(c: T, text: string): T {
  const next = { ...c };
  if (text.trim() === "") delete next.body;
  else next.body = text;
  return next;
}

// ExprField edits one of a switch's expressions, applied as it's typed. It
// tells aim how to put a path where its cursor is when it gets the cursor,
// and, when it's the first, as it's drawn. Before it has had the cursor, a
// path goes at the end.
function ExprField({
  id,
  label,
  description,
  initial,
  apply,
  problems,
  aim,
  first = false,
}: {
  id: string;
  label: string;
  description: string;
  initial: string;
  apply: (text: string) => void;
  problems: Found[];
  aim: Aim;
  first?: boolean;
}) {
  const [text, setText] = useState(initial);
  const field = useRef<HTMLTextAreaElement>(null);
  const used = useRef(false);
  useEffect(() => {
    if (first) aim.first(insert);
  });

  // insert reads the field itself, not this render's text, as the switch
  // keeps it to call after later edits.
  function insert(path: string) {
    const el = field.current;
    if (!el) return;
    const value = el.value;
    const [start, end] = used.current
      ? [el.selectionStart, el.selectionEnd]
      : [value.length, value.length];
    const next = value.slice(0, start) + path + value.slice(end);
    setText(next);
    apply(next);
    const at = start + path.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
    });
  }

  return (
    <Field data-invalid={problems.length > 0}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        ref={field}
        className="min-h-16 font-mono"
        spellCheck={false}
        aria-invalid={problems.length > 0}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          apply(e.target.value);
        }}
        onFocus={() => {
          used.current = true;
          aim.focused(insert);
        }}
      />
      <FieldError errors={asErrors(problems)} />
      <FieldDescription>{description}</FieldDescription>
    </Field>
  );
}

// StatusField edits a case's status, which counts once it's a whole number
// from 200 to 599; until then the status held stays, and the field says why.
function StatusField({
  id,
  label,
  initial,
  apply,
  problems,
}: {
  id: string;
  label: string;
  initial: number | undefined;
  apply: (status: number) => void;
  problems: Found[];
}) {
  const [text, setText] = useState(
    initial === undefined ? "" : String(initial),
  );
  const status = whole(text, MIN_STATUS, MAX_STATUS);
  const said =
    status === null || status === undefined
      ? [{ message: `A whole number from ${MIN_STATUS} to ${MAX_STATUS}.` }]
      : asErrors(problems);
  return (
    <Field data-invalid={said.length > 0}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        inputMode="numeric"
        className="w-28 font-mono"
        aria-invalid={said.length > 0}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const next = whole(e.target.value, MIN_STATUS, MAX_STATUS);
          if (next !== null && next !== undefined) apply(next);
        }}
      />
      <FieldError errors={said} />
    </Field>
  );
}
