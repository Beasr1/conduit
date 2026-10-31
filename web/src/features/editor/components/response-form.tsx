import { ChevronRightIcon } from "lucide-react";
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
import { JsonText } from "@/features/editor/components/json-field";
import { MappingField } from "@/features/editor/components/mapping-field";
import { RunAnswered } from "@/features/editor/components/step-run";
import { WholeRunNote } from "@/features/editor/components/whole-run-note";
import {
  addAnswer,
  canJoin,
  leaveAnswer,
  removeAnswer,
  setAnswerSchema,
  setUnhandled,
} from "@/features/editor/edits";
import { readSchema, whole } from "@/features/editor/fields";
import { toFlow } from "@/features/editor/flow";
import { asErrors, useProblems } from "@/features/editor/hooks/use-problems";
import { usePreview } from "@/features/editor/hooks/use-preview";
import { useEditor, useEditorStore } from "@/features/editor/store";

// The statuses an answer can have, as schema/workflow.yaml allows.
const MIN_ANSWER = 200;
const MAX_ANSWER = 599;

// What a new unhandled body answers with, to edit from.
const NEW_UNHANDLED = "{ 'error': error.detail }";

// ResponseForm is the overview of what the workflow's API answers: each
// answer, the step that gives it by its one line, and the schema its body is
// promised to match; unhandled, for a run that gives none; and the
// answers Conduit gives on its own.
export function ResponseForm() {
  return (
    <>
      <RunAnswered />
      <Answers />
      <Unhandled />
      <ConduitAnswers />
    </>
  );
}

// Answers lists the workflow's answers, then adds one. Each is keyed by its
// status, so what's typed in its schema stays with it when an answer before
// it goes.
function Answers() {
  const statuses = useEditor(
    useShallow((s) => (s.draft.response?.answers ?? []).map((a) => a.status)),
  );
  const problems = useProblems(
    (p) => p.on === "response" && p.field === "answers",
  );
  const seen = new Map<number, number>();
  return (
    <section className="flex flex-col gap-3 text-sm">
      <div className="flex flex-col gap-1.5">
        <h3 className="font-medium">Answers</h3>
        <p className="text-muted-foreground">
          Each a status, and the shape a caller gets with it, joined by one line
          from the step that gives it: its body is that step&apos;s result. A
          step joined to several answers picks one with its cases.
        </p>
        <FieldError errors={asErrors(problems)} />
      </div>
      {statuses.map((status, k) => {
        const n = seen.get(status) ?? 0;
        seen.set(status, n + 1);
        return (
          <Answer
            key={n === 0 ? String(status) : `${status}#${n}`}
            index={k}
            status={status}
          />
        );
      })}
      <AddAnswer taken={statuses} />
    </section>
  );
}

// Answer is one of the workflow's answers: its status, the step whose line
// gives it, which a click opens on the response the line leaves on, and the
// schema its body is promised to match.
function Answer({ index, status }: { index: number; status: number }) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const show = useEditor((s) => s.show);
  const from = useEditor((s) => s.draft.response?.answers?.[index]?.from);
  const on = useEditor((s) => s.draft.response?.answers?.[index]?.on);
  const joined = useEditor((s) => !canJoin(s.draft, index));
  const lineProblems = useProblems(
    (p) =>
      p.on === "response" &&
      p.answer === index &&
      (p.field === "status" || p.field === "from" || p.field === "on"),
  );
  const schemaProblems = useProblems(
    (p) => p.on === "response" && p.field === "schema" && p.answer === index,
  );

  // The canvas names a step by its key, which toFlow gives it. It's worked
  // out on a click, not on every draw.
  function open() {
    const draft = editor.getState().draft;
    const at = draft.nodes.findIndex((n) => n.id === from);
    const key = toFlow(draft).nodes[at]?.id;
    const http = draft.nodes[at]?.kind === "http";
    if (key)
      show(
        "nodes",
        key,
        !http ? "request" : on === undefined ? "2xx" : String(on),
      );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-mono font-medium">{status}</h4>
        <Button
          id={`response-answer-${index}-remove`}
          variant="ghost"
          size="xs"
          aria-label={`Remove the ${status} answer`}
          onClick={() => edit((d) => removeAnswer(d, index))}
        >
          Remove
        </Button>
      </div>
      {joined && from ? (
        <div className="flex items-center gap-2">
          <Button
            id={`response-answer-${index}-from`}
            variant="ghost"
            className="h-auto min-w-0 flex-1 justify-start gap-2 py-1.5 text-left font-normal [&_svg]:size-3.5"
            onClick={open}
          >
            {/* The spaces are text of their own: a name drops one at the
                end of an element's text, and a flex row doesn't draw them. */}
            <span className="sr-only">Given by</span>{" "}
            <span className="truncate font-mono">{from}</span>
            {on !== undefined && (
              <>
                {" "}
                <span className="text-muted-foreground">on {on}</span>
              </>
            )}
            <ChevronRightIcon aria-hidden className="ml-auto" />
          </Button>
          <Button
            variant="outline"
            size="xs"
            aria-label={`Disconnect ${from} from ${status}`}
            onClick={() => edit((d) => leaveAnswer(d, index))}
          >
            Disconnect
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground">
          No line yet: drag from the step that gives it to its point on the
          card, or pick Response {status} in that step&apos;s Connect to.
        </p>
      )}
      <FieldError errors={asErrors(lineProblems)} />
      <JsonText
        id={`response-answer-${index}-schema`}
        label={`${status} schema`}
        description="A JSON Schema the body is promised to match. It's checked when saved; runs don't enforce it yet."
        initial={editor.getState().draft.response?.answers?.[index]?.schema}
        read={readSchema}
        apply={(value) => edit((d) => setAnswerSchema(d, index, value))}
        problems={schemaProblems}
      />
    </div>
  );
}

// AddAnswer adds an answer by its status, with no line yet. + Add on the
// card opens the response here.
function AddAnswer({ taken }: { taken: number[] }) {
  const edit = useEditor((s) => s.edit);
  const part = useEditor((s) => s.part);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (part === "add") input.current?.focus();
  }, [part]);
  const status = whole(text, MIN_ANSWER, MAX_ANSWER);
  const error =
    status === null
      ? `A whole number from ${MIN_ANSWER} to ${MAX_ANSWER}.`
      : status !== undefined && taken.includes(status)
        ? "It has that answer already."
        : undefined;

  function add() {
    if (status === null || status === undefined || error !== undefined) return;
    edit((d) => addAnswer(d, status));
    setText("");
  }

  return (
    <Field data-invalid={error !== undefined}>
      <FieldLabel htmlFor="response-add-answer">Add an answer</FieldLabel>
      <div className="flex gap-2">
        <Input
          ref={input}
          id="response-add-answer"
          inputMode="numeric"
          placeholder="404"
          aria-invalid={error !== undefined}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            add();
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={
            status === null || status === undefined || error !== undefined
          }
          onClick={add}
        >
          Add
        </Button>
      </div>
      <FieldError errors={error === undefined ? [] : [{ message: error }]} />
      <FieldDescription>
        By its status, as 404, then join the step that gives it to its point.
        Conduit&apos;s own answers, below, are there whatever the workflow says.
      </FieldDescription>
    </Field>
  );
}

// Unhandled is what the workflow answers a run that gives none: Conduit's
// problem details, or a body of the workflow's own, at the status of the
// failure's cause.
function Unhandled() {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const body = useEditor((s) => s.draft.response?.unhandled?.body);
  const problems = useProblems(
    (p) => p.on === "response" && p.field === "unhandled",
  );
  const preview = usePreview();
  const intro = (
    <p className="text-muted-foreground">
      A step fails or times out, or no answer is reached: the status is the
      cause&apos;s, 502 when an upstream failed, 504 when time ran out, 500
      otherwise.
    </p>
  );
  if (body === undefined)
    return (
      <section className="flex flex-col gap-1.5 text-sm">
        <h3 className="font-medium">Unhandled</h3>
        {intro}
        <p className="text-muted-foreground">
          Its body is Conduit&apos;s problem details, unless you write your own.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => edit((d) => setUnhandled(d, NEW_UNHANDLED))}
        >
          Write your own
        </Button>
      </section>
    );
  return (
    <section className="flex flex-col gap-1.5 text-sm">
      <h3 className="font-medium">Unhandled</h3>
      {intro}
      <MappingField
        id="response-unhandled"
        label="Unhandled body"
        description={
          <>
            JSONata over the run as it stood, every step that succeeded, and{" "}
            <span className="font-mono">error</span>:{" "}
            <span className="font-mono">{"{ code, detail, node }"}</span>.
          </>
        }
        initial={editor.getState().draft.response?.unhandled?.body ?? ""}
        apply={(text) => edit((d) => setUnhandled(d, text))}
        problems={problems}
        preview={preview}
        open={() => []}
        result={() => null}
      />
      <WholeRunNote text={body} />
      <Button
        variant="ghost"
        size="xs"
        className="self-start"
        onClick={() => edit((d) => setUnhandled(d, undefined))}
      >
        Use Conduit&apos;s problem details instead
      </Button>
    </section>
  );
}

// The answers Conduit gives on its own, and when.
const conduitAnswers: [number, string][] = [
  [
    400,
    "The input isn't JSON, or doesn't match the input schema. The body says where.",
  ],
  [401, "The call has no valid token."],
  [404, "Nothing is published at the address called."],
  [
    500,
    "The workflow failed on its own: an expression, or no answer reached, or two. The body says why, and links the run, unless Unhandled answers.",
  ],
  [
    502,
    "An upstream answered with a status its step has no response for, or couldn't be reached. The body names the step and links the run, unless Unhandled answers.",
  ],
  [503, "Too many runs at once. Retry-After says when to try again."],
  [
    504,
    "The run, or a step's last attempt, ran out of time. The body links the run, unless Unhandled answers.",
  ],
];

// ConduitAnswers lists the answers Conduit gives whatever the workflow says,
// so the card reads as the whole of what a caller can get.
function ConduitAnswers() {
  return (
    <section className="flex flex-col gap-1.5 text-sm">
      <h3 className="font-medium">Conduit&apos;s own answers</h3>
      <p className="text-muted-foreground">
        Each body is problem details, sent as application/problem+json, so a
        caller tells them from the workflow&apos;s own answers.
      </p>
      <dl className="flex flex-col gap-1">
        {conduitAnswers.map(([status, when]) => (
          <div key={status} className="flex gap-3">
            <dt className="w-8 shrink-0 font-mono">{status}</dt>
            <dd className="text-muted-foreground">{when}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
