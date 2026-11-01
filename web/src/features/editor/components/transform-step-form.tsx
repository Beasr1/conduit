import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  JsonBlock,
  MappingField,
  Reads,
  Skipped,
} from "@/features/editor/components/mapping-field";
import { Marked } from "@/features/editor/components/problem-mark";
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
  setCaseStatus,
  toCases,
  updateCase,
  updateNode,
} from "@/features/editor/edits";
import { whole } from "@/features/editor/fields";
import { exitsOf } from "@/features/editor/flow";
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

// TransformStepForm edits a transform step: one expression between the data
// it reads and what it gives, simulated over the samples, then what follows
// it and its Unhandled; or its cases, a tab each, each with what it reads.
// With two or more lines into it, the preview is of a run by each: the step
// reads what those runs read, merged, and gives, shown once, what it gives
// in the first that comes (plan 13).
export function TransformStepForm({ index }: { index: number }) {
  const cases = useEditor((s) => s.draft.nodes[index]?.switch !== undefined);
  return (
    <>
      <RunGave index={index} />
      {cases ? (
        <SwitchForm index={index} />
      ) : (
        <>
          <ExpressionForm index={index} />
          <StepConnections index={index} />
          <StepUnhandled index={index} />
        </>
      )}
    </>
  );
}

// givesOf is what a transform gives over the samples: with a run by each
// line into it, what it gives in the first of those a run comes by.
function givesOf(p: Preview): unknown {
  return p.ways === undefined ? p.gives : p.ways.find((w) => !w.skipped)?.gives;
}

// Value is a transform's value over the samples, or that it gave none.
function Value({ gives }: { gives: unknown }) {
  return gives === undefined ? (
    <p className="text-muted-foreground">Nothing.</p>
  ) : (
    <JsonBlock value={gives} />
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
// cases, the expression the first one's body. Its value goes to callers
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
        hint={
          <>
            JSONata over the input. The steps after read its value as{" "}
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
              <h3 className="font-medium">Gives</h3>
              <Value gives={givesOf(p)} />
            </>
          )
        }
      />
      {answers && <WholeRunNote text={expr} />}
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          onClick={() => edit((d) => toCases(d, index, firstAnswer(d, index)))}
        >
          Use cases
        </Button>
        <Hint about="cases">
          Cases pick what it gives and where it goes: the first whose condition
          holds gives its body and exits with its status. This expression
          becomes the first case&apos;s body. When none holds, the step fails
          into its Unhandled.
        </Hint>
      </div>
    </>
  );
}

// SwitchForm edits a transform step's cases, a tab each, the tabs first, as
// an HTTP step's are; then + Case, and its Unhandled, which takes no case
// holding. The tabs' fields are keyed by the times cases were added, moved
// or removed, so each starts afresh from the draft after one is, rather than
// keeping another case's text. The tab open is the editor's part, as an
// HTTP step's is, so a click on an exit on the canvas opens its tab.
function SwitchForm({ index }: { index: number }) {
  const edit = useEditor((s) => s.edit);
  const part = useEditor((s) => s.part);
  const setPart = useEditor((s) => s.setPart);
  const labels = useEditor(
    useShallow((s) => exitsOf(s.draft.nodes[index]).map((e) => e.label)),
  );
  const count = labels.length;
  const preview = usePreview({ step: index });
  const [layout, setLayout] = useState(0);
  const relaid: Relaid = (change, open) => {
    edit(change);
    setLayout((n) => n + 1);
    if (open) setPart(open);
  };
  const mine = (p: Place): p is Extract<Place, { on: "step" }> =>
    p.on === "step" && p.index === index;
  const tabs = [...labels.map((_, k) => `case:${k}`), "add", "unhandled"];
  return (
    <>
      <Tabs
        value={tabs.includes(part) ? part : tabs[0]}
        onValueChange={(value: string) => setPart(value)}
      >
        <TabsList
          activateOnFocus
          className="flex-wrap group-data-horizontal/tabs:h-auto [&>[data-slot=tabs-trigger]]:h-auto"
        >
          {labels.map((label, k) => (
            <TabsTrigger key={k} value={`case:${k}`}>
              {label}
              <Marked where={(p) => mine(p) && p.case === k} />
            </TabsTrigger>
          ))}
          <TabsTrigger value="add" aria-label="Add a case">
            + Case
          </TabsTrigger>
          <TabsTrigger value="unhandled">
            Unhandled
            <Marked
              where={(p) =>
                mine(p) &&
                (p.field === "unhandled" || p.field === "unhandled_body")
              }
            />
          </TabsTrigger>
        </TabsList>
        {/* Each stays mounted while hidden, so what's typed survives a
            switch. */}
        {labels.map((_, k) => (
          <TabsContent key={`${layout}-${k}`} value={`case:${k}`} keepMounted>
            <CaseTab
              index={index}
              k={k}
              count={count}
              preview={preview}
              relaid={relaid}
            />
          </TabsContent>
        ))}
        <TabsContent value="add" keepMounted>
          <AddCase index={index} relaid={relaid} />
        </TabsContent>
        <TabsContent value="unhandled" keepMounted>
          <StepUnhandled index={index} />
        </TabsContent>
      </Tabs>
    </>
  );
}

// CaseTab is case k's tab: what it reads, simulated over the samples, then
// its fields, what it gives when it's the one that holds, and what follows
// its exit. A field picked from what it reads goes where the cursor was
// last in the tab, or, before any field there has had it, into its
// condition.
function CaseTab({
  index,
  k,
  count,
  preview,
  relaid,
}: {
  index: number;
  k: number;
  count: number;
  preview: ReturnType<typeof usePreview>;
  relaid: Relaid;
}) {
  const target = useRef<((path: string) => void) | undefined>(undefined);
  const aim: Aim = {
    focused: (insert) => {
      target.current = insert;
    },
    first: (insert) => {
      target.current ??= insert;
    },
  };
  return (
    <div className="flex flex-col gap-5">
      <Reads
        into="the field the cursor was last in"
        preview={preview}
        open={(of) => parents(of, of.nodes[index]?.id)}
        onPick={(path) => target.current?.(path)}
      />
      <CaseFields index={index} k={k} count={count} aim={aim} relaid={relaid} />
      <Holds index={index} part={`case:${k}`} preview={preview} />
      <ExitConnections index={index} part={`case:${k}`} />
    </div>
  );
}

// Relaid applies a change that adds, moves or removes a case, which lays the
// tabs out afresh, and opens the tab open names, if it names one.
type Relaid = (change: (d: Definition) => Definition, open?: string) => void;

// Aim is how a switch's fields say where a picked path goes: the field
// focused, else the first.
interface Aim {
  focused: (insert: (path: string) => void) => void;
  first: (insert: (path: string) => void) => void;
}

// useOthers is the exits of step index but the one at part, each by its
// status and what it's called: the statuses that one can't take.
function useOthers(
  index: number,
  part: string,
): { status: number; label: string }[] {
  const statuses = useEditor(
    useShallow((s) =>
      exitsOf(s.draft.nodes[index])
        .filter((e) => e.part !== part)
        .map((e) => e.status),
    ),
  );
  const labels = useEditor(
    useShallow((s) =>
      exitsOf(s.draft.nodes[index])
        .filter((e) => e.part !== part)
        .map((e) => e.label),
    ),
  );
  return statuses.map((status, j) => ({ status, label: labels[j] ?? "" }));
}

// nextStatus is a new case's status: the first answer's that no line gives
// yet, nor an exit of the step has, as the case could give it; else the
// first from 400 up that no exit or answer has. An answer with lines, one
// from the step's Unhandled among them, is another step's to give.
function nextStatus(d: Definition, index: number): number {
  const given = new Set(exitsOf(d.nodes[index]).map((e) => e.status));
  const answers = d.response?.answers ?? [];
  const open = answers.filter((a) => !a.lines).map((a) => a.status);
  const taken = new Set([...given, ...answers.map((a) => a.status)]);
  const errors = Array.from({ length: MAX_STATUS - 399 }, (_, i) => 400 + i);
  return (
    open.find((s) => !given.has(s)) ??
    errors.find((s) => !taken.has(s)) ??
    MAX_STATUS
  );
}

// Holds says, over the samples, what the case at part gives when it's the
// one that holds; else which one is, or that none is. With a run by each
// line into the step, it's the first of those a run comes by (plan 13).
function Holds({
  index,
  part,
  preview,
}: {
  index: number;
  part: string;
  preview: ReturnType<typeof usePreview>;
}) {
  const parts = useEditor(
    useShallow((s) => exitsOf(s.draft.nodes[index]).map((e) => e.part)),
  );
  const statuses = useEditor(
    useShallow((s) => exitsOf(s.draft.nodes[index]).map((e) => e.status)),
  );
  const labels = useEditor(
    useShallow((s) => exitsOf(s.draft.nodes[index]).map((e) => e.label)),
  );
  if (preview.data === undefined) return null;
  const { preview: p } = preview.data;
  const gives = givesOf(p) as { status?: number; body?: unknown } | undefined;
  const k = statuses.findIndex((status) => status === gives?.status);
  const none = p.problems.some((pr) => pr.pointer === `/nodes/${index}/switch`);
  return (
    <section className="flex flex-col gap-1.5 text-sm">
      {p.skipped ? (
        <Skipped />
      ) : gives === undefined ? (
        <p className="text-muted-foreground">
          {none
            ? "No case holds with these samples."
            : "Gives nothing with these samples."}
        </p>
      ) : k >= 0 && parts[k] !== part ? (
        <p className="text-muted-foreground">{labels[k]} holds, not this.</p>
      ) : (
        <Gives gives={gives} />
      )}
    </section>
  );
}

// Gives is what a switch gives over the samples: the status and body of
// the case that holds.
function Gives({ gives }: { gives: { status?: number; body?: unknown } }) {
  return (
    <>
      <h3 className="font-medium">
        {gives.status === undefined ? "Gives" : `Gives ${gives.status}`}
      </h3>
      {gives.body === undefined ? (
        <p className="text-muted-foreground">No body.</p>
      ) : (
        <JsonBlock value={gives.body} />
      )}
    </>
  );
}

// ExitConnections is what follows the exit at part: the lines leaving it,
// to steps and to the answer of its status.
function ExitConnections({ index, part }: { index: number; part: string }) {
  const status = useEditor(
    (s) => exitsOf(s.draft.nodes[index]).find((e) => e.part === part)?.status,
  );
  if (status === undefined) return null;
  return <StepConnections index={index} on={status} />;
}

// CaseFields edits case k: its name, condition, status and body, and moves
// or removes it, its tab going with it.
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
  relaid: Relaid;
}) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const c = editor.getState().draft.nodes[index]?.switch?.cases?.[k];
  const body = useEditor((s) => s.draft.nodes[index]?.switch?.cases?.[k]?.body);
  const others = useOthers(index, `case:${k}`);
  const mine = (field: StepField) => (p: Place) =>
    p.on === "step" && p.index === index && p.field === field && p.case === k;
  const whenProblems = useProblems(mine("case_when"));
  const statusProblems = useProblems(mine("case_status"));
  const bodyProblems = useProblems(mine("case_body"));
  const n = k + 1;
  return (
    <section className="flex flex-col gap-3 text-sm">
      <div className="flex items-center justify-end gap-2">
        <div className="flex shrink-0 gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Move case ${n} up`}
            disabled={k === 0}
            onClick={() =>
              relaid((d) => moveCase(d, index, k, k - 1), `case:${k - 1}`)
            }
          >
            <ArrowUpIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Move case ${n} down`}
            disabled={k === count - 1}
            onClick={() =>
              relaid((d) => moveCase(d, index, k, k + 1), `case:${k + 1}`)
            }
          >
            <ArrowDownIcon />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Remove case ${n}`}
            // A step with cases has one at least.
            disabled={count === 1}
            onClick={() => relaid((d) => removeCase(d, index, k))}
          >
            Remove
          </Button>
        </div>
      </div>
      <NameField
        id={`step-case-${k}-name`}
        label={`Case ${n} name`}
        placeholder={`Case ${n}`}
        initial={c?.name ?? ""}
        apply={(text) =>
          edit((d) => updateCase(d, index, k, (c) => withName(c, text)))
        }
      />
      <ExprField
        id={`step-case-${k}-when`}
        label={`Case ${n} when`}
        hint="JSONata over the input, true or false. The first case whose condition holds gives its body and exits with its status."
        initial={c?.when ?? ""}
        apply={(text) =>
          edit((d) => updateCase(d, index, k, (c) => ({ ...c, when: text })))
        }
        problems={whenProblems}
        aim={aim}
        first
      />
      <StatusField
        id={`step-case-${k}-status`}
        label={`Case ${n} status`}
        initial={c?.status}
        apply={(status) => edit((d) => setCaseStatus(d, index, k, status))}
        problems={statusProblems}
        taken={others}
      />
      <ExprField
        id={`step-case-${k}-body`}
        label={`Case ${n} body`}
        hint="JSONata whose value is the body. Empty sends none."
        initial={c?.body ?? ""}
        apply={(text) =>
          edit((d) => updateCase(d, index, k, (c) => withBody(c, text)))
        }
        problems={bodyProblems}
        aim={aim}
      />
      <WholeRunNote text={body} />
    </section>
  );
}

// AddCase adds a case after the others, named if it's given a name, with a
// status no exit of the step has, then opens its tab.
function AddCase({ index, relaid }: { index: number; relaid: Relaid }) {
  const editor = useEditorStore();
  const count = useEditor(
    (s) => s.draft.nodes[index]?.switch?.cases?.length ?? 0,
  );
  const others = useOthers(index, "");
  const [name, setName] = useState("");
  const [text, setText] = useState(() =>
    String(nextStatus(editor.getState().draft, index)),
  );
  const status = whole(text, MIN_STATUS, MAX_STATUS);
  const clash = others.find((o) => o.status === status);
  const said =
    status === null || status === undefined
      ? [{ message: `A whole number from ${MIN_STATUS} to ${MAX_STATUS}.` }]
      : clash
        ? [{ message: `${clash.label} exits with ${status}.` }]
        : [];
  return (
    <section className="flex flex-col gap-3 text-sm">
      <NameField
        id="step-new-case-name"
        label="New case name"
        placeholder={`Case ${count + 1}`}
        initial={name}
        apply={setName}
        value={name}
      />
      <Field data-invalid={said.length > 0}>
        <div className="flex items-center gap-1">
          <FieldLabel htmlFor="step-new-case-status">
            New case status
          </FieldLabel>
          <Hint about="a new case">
            Checked after the others. Its status names its exit, so no other
            case has it.
          </Hint>
        </div>
        <Input
          id="step-new-case-status"
          inputMode="numeric"
          className="w-28 font-mono"
          aria-invalid={said.length > 0}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <FieldError errors={said} />
      </Field>
      <Button
        size="sm"
        className="self-start"
        disabled={typeof status !== "number" || clash !== undefined}
        onClick={() => {
          if (typeof status !== "number") return;
          relaid(
            (d) => addCase(d, index, status, name.trim() || undefined),
            `case:${count}`,
          );
          setName("");
          setText(String(nextStatus(editor.getState().draft, index)));
        }}
      >
        Add
      </Button>
    </section>
  );
}

// withBody gives a case the body text; empty, none.
function withBody<T extends { body?: string }>(c: T, text: string): T {
  const next = { ...c };
  if (text.trim() === "") delete next.body;
  else next.body = text;
  return next;
}

// withName gives a case the name text; empty, none, so it's called by its
// place.
function withName<T extends { name?: string }>(c: T, text: string): T {
  const next = { ...c };
  if (text.trim() === "") delete next.name;
  else next.name = text;
  return next;
}

// NameField edits what a case is called, on its exit and its tab, applied as it's typed. value, when given, is what it shows.
function NameField({
  id,
  label,
  placeholder,
  initial,
  apply,
  value,
}: {
  id: string;
  label: string;
  placeholder: string;
  initial: string;
  apply: (text: string) => void;
  value?: string;
}) {
  const [text, setText] = useState(initial);
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        autoComplete="off"
        placeholder={placeholder}
        value={value ?? text}
        onChange={(e) => {
          setText(e.target.value);
          apply(e.target.value);
        }}
      />
    </Field>
  );
}

// ExprField edits one of a switch's expressions, applied as it's typed. It
// tells aim how to put a path where its cursor is when it gets the cursor,
// and, when it's the first, as it's drawn. Before it has had the cursor, a
// path goes at the end.
function ExprField({
  id,
  label,
  hint,
  initial,
  apply,
  problems,
  aim,
  first = false,
}: {
  id: string;
  label: string;
  hint: string;
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
      <div className="flex items-center gap-1">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Hint about={label}>{hint}</Hint>
      </div>
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
    </Field>
  );
}

// StatusField edits a case's status, which counts once it's a whole number
// from 200 to 599 that no other exit of the step has, taken; until then the
// status held stays, and the field says why.
function StatusField({
  id,
  label,
  initial,
  apply,
  problems,
  taken,
}: {
  id: string;
  label: string;
  initial: number | undefined;
  apply: (status: number) => void;
  problems: Found[];
  taken: { status: number; label: string }[];
}) {
  const [text, setText] = useState(
    initial === undefined ? "" : String(initial),
  );
  const status = whole(text, MIN_STATUS, MAX_STATUS);
  const clash = taken.find((t) => t.status === status);
  const said =
    status === null || status === undefined
      ? [{ message: `A whole number from ${MIN_STATUS} to ${MAX_STATUS}.` }]
      : clash
        ? [{ message: `${clash.label} exits with ${status}.` }]
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
          if (typeof next === "number" && !taken.some((t) => t.status === next))
            apply(next);
        }}
      />
      <FieldError errors={said} />
    </Field>
  );
}
