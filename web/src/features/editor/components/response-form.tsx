import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { JsonText } from "@/features/editor/components/json-field";
import { MappingField } from "@/features/editor/components/mapping-field";
import { RunAnswered } from "@/features/editor/components/step-run";
import { WholeRunNote } from "@/features/editor/components/whole-run-note";
import {
  addAnswer,
  leaveLines,
  moveAnswer,
  removeAnswer,
  setAnswerSchema,
  setErrorBody,
} from "@/features/editor/edits";
import { readSchema, whole } from "@/features/editor/fields";
import { outputOf, toFlow, UNHANDLED } from "@/features/editor/flow";
import { asErrors, useProblems } from "@/features/editor/hooks/use-problems";
import { usePreview } from "@/features/editor/hooks/use-preview";
import { useEditor, useEditorStore } from "@/features/editor/store";

// The statuses an answer can have, as schema/workflow.yaml allows.
const MIN_ANSWER = 200;
const MAX_ANSWER = 599;

// What a new error body answers with, to edit from.
const NEW_ERROR_BODY = "{ 'error': error.code, 'detail': error.detail }";

// ResponseForm is the overview of what the workflow's API answers: each
// answer, in the order a run tries them, the steps whose lines give it, and
// the schema its body is promised to match; the error body; then, a line
// each, Unhandled, for a run that gives none, and the answers Conduit gives
// on its own.
export function ResponseForm() {
  return (
    <>
      <RunAnswered />
      <Answers />
      <ErrorBody />
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
        <div className="flex items-center gap-1">
          <h3 className="font-medium">Answers</h3>
          <Hint about="Answers">
            Each a status, joined by lines from the steps that give it. A run
            gives the first, top to bottom, that one of its lines reached, with
            that step&apos;s result as the body.
          </Hint>
        </div>
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
            count={statuses.length}
          />
        );
      })}
      <AddAnswer taken={statuses} />
    </section>
  );
}

// Answer is one of the workflow's answers: its place, as a run tries them
// top to bottom (plan 14), moved with Move up and down; its status; the
// lines into it, each opening the step it's from on the block it leaves;
// and the schema its body is promised to match.
function Answer({
  index,
  status,
  count,
}: {
  index: number;
  status: number;
  count: number;
}) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const lines = useEditor((s) => s.draft.response?.answers?.[index]?.lines);
  const lineProblems = useProblems(
    (p) =>
      p.on === "response" &&
      p.answer === index &&
      (p.field === "status" || p.field === "from" || p.field === "on"),
  );
  const schemaProblems = useProblems(
    (p) => p.on === "response" && p.field === "schema" && p.answer === index,
  );

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-medium">
          <span className="text-muted-foreground">{index + 1}.</span>{" "}
          <span className="font-mono">{status}</span>
        </h4>
        <div className="flex shrink-0 gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Move ${status} up`}
            disabled={index === 0}
            onClick={() => edit((d) => moveAnswer(d, index, index - 1))}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Move ${status} down`}
            disabled={index === count - 1}
            onClick={() => edit((d) => moveAnswer(d, index, index + 1))}
          >
            <ArrowDownIcon />
          </Button>
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
      </div>
      {lines === undefined ? (
        <p className="text-muted-foreground">No line yet.</p>
      ) : (
        <ul className="flex flex-col">
          {lines.map((l, j) => (
            <AnswerLine
              key={`${l.from} ${outputOf(l) ?? ""}`}
              answer={index}
              line={j}
              status={status}
            />
          ))}
        </ul>
      )}
      <FieldError errors={asErrors(lineProblems)} />
      <JsonText
        id={`response-answer-${index}-schema`}
        label={`${status} schema`}
        description="A JSON Schema the body is promised to match. Checked when saved, not yet on runs."
        initial={editor.getState().draft.response?.answers?.[index]?.schema}
        read={readSchema}
        apply={(value) => edit((d) => setAnswerSchema(d, index, value))}
        problems={schemaProblems}
      />
    </div>
  );
}

// AnswerLine is line j into answer k: the step it's from, which a click
// opens on the block the line leaves, and Disconnect.
function AnswerLine({
  answer,
  line,
  status,
}: {
  answer: number;
  line: number;
  status: number;
}) {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const show = useEditor((s) => s.show);
  const l = useEditor(
    (s) => s.draft.response?.answers?.[answer]?.lines?.[line],
  );
  if (!l) return null;
  const on = outputOf(l);

  // The canvas names a step by its key, which toFlow gives it. It's worked
  // out on a click, not on every draw.
  function open() {
    const draft = editor.getState().draft;
    const at = draft.nodes.findIndex((n) => n.id === l?.from);
    const key = toFlow(draft).nodes[at]?.id;
    const http = draft.nodes[at]?.kind === "http";
    if (key)
      show(
        "nodes",
        key,
        on === UNHANDLED
          ? "unhandled"
          : !http
            ? "request"
            : on === undefined
              ? "2xx"
              : String(on),
      );
  }

  const block =
    on === UNHANDLED ? "Unhandled" : on === undefined ? undefined : String(on);
  return (
    <li className="flex items-center gap-2">
      <Button
        id={`response-answer-${answer}-line-${line}`}
        variant="ghost"
        className="h-auto min-w-0 flex-1 justify-start gap-2 py-1.5 text-left font-normal [&_svg]:size-3.5"
        onClick={open}
      >
        {/* The spaces are text of their own: a name drops one at the end of
            an element's text, and a flex row doesn't draw them. */}
        <span className="sr-only">Given by</span>{" "}
        <span className="truncate font-mono">{l.from}</span>
        {block !== undefined && (
          <>
            {" "}
            <span className="text-muted-foreground">on {block}</span>
          </>
        )}
        <ChevronRightIcon aria-hidden className="ml-auto" />
      </Button>
      <Button
        variant="outline"
        size="xs"
        aria-label={`Disconnect ${l.from}${block === undefined ? "" : ` on ${block}`} from ${status}`}
        onClick={() =>
          edit((d) => {
            const gone = d.response?.answers?.[answer]?.lines?.[line];
            return gone ? leaveLines(d, [gone]) : d;
          })
        }
      >
        Disconnect
      </Button>
    </li>
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
      <div className="flex items-center gap-1">
        <FieldLabel htmlFor="response-add-answer">Add an answer</FieldLabel>
        <Hint about="Add an answer">
          By its status, as 404, then join the step that gives it to its point
          on the card.
        </Hint>
      </div>
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
    </Field>
  );
}

// ErrorBody is the workflow's error body (plan 12): what answers each error
// it passes on without a body of its own, a run that gives no answer, and an
// error response or an Unhandled joined straight to an answer; unwritten,
// Conduit's problem details do.
function ErrorBody() {
  const editor = useEditorStore();
  const edit = useEditor((s) => s.edit);
  const body = useEditor((s) => s.draft.response?.errors?.body);
  const problems = useProblems(
    (p) => p.on === "response" && p.field === "errors",
  );
  const preview = usePreview();
  if (body === undefined)
    return (
      <section className="flex flex-col gap-1.5 text-sm">
        <div className="flex items-center gap-1">
          <h3 className="font-medium">Error body</h3>
          <Hint about="the error body">
            One body for every error the workflow answers without one of its
            own: a run that gives no answer, and a step&apos;s error response or
            Unhandled joined straight to an answer.
          </Hint>
        </div>
        <p className="text-muted-foreground">Problem details.</p>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => edit((d) => setErrorBody(d, NEW_ERROR_BODY))}
        >
          Write it
        </Button>
      </section>
    );
  return (
    <section className="flex flex-col gap-1.5 text-sm">
      <MappingField
        id="response-errors"
        label="Error body"
        hint={
          <>
            One body for every error the workflow answers without one of its
            own. JSONata over the run as it stood, and{" "}
            <span className="font-mono">error</span>:{" "}
            <span className="font-mono">{"{ code, detail, node }"}</span>, with
            the upstream&apos;s <span className="font-mono">status</span>,{" "}
            <span className="font-mono">headers</span> and{" "}
            <span className="font-mono">body</span> when it answered.
          </>
        }
        initial={editor.getState().draft.response?.errors?.body ?? ""}
        apply={(text) => edit((d) => setErrorBody(d, text))}
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
        onClick={() => edit((d) => setErrorBody(d, undefined))}
      >
        Use problem details instead
      </Button>
    </section>
  );
}

// Unhandled says, in a line, what answers a run that gives no answer.
function Unhandled() {
  return (
    <section className="flex items-center gap-1 text-sm">
      <p>
        <span className="font-medium">Unhandled</span>{" "}
        <span className="text-muted-foreground">500, 502 or 504, by cause</span>
      </p>
      <Hint about="Unhandled">
        A run that gives no answer: a step fails it, or no answer is reached.
        502 when an upstream failed, 504 when time ran out, 500 otherwise. The
        error body answers it.
      </Hint>
    </section>
  );
}

// The answers Conduit gives on its own, and when.
const conduitAnswers: [number, string][] = [
  [400, "the input isn't JSON, or doesn't match the input schema"],
  [401, "the call has no valid token"],
  [404, "nothing is published at the address called"],
  [503, "too many runs at once; Retry-After says when to try again"],
];

// ConduitAnswers says, in a line, the answers Conduit gives whatever the
// workflow says, so the card reads as the whole of what a caller can get.
function ConduitAnswers() {
  return (
    <section className="flex items-center gap-1 text-sm">
      <p>
        <span className="font-medium">Conduit&apos;s own</span>{" "}
        <span className="font-mono text-muted-foreground">
          {conduitAnswers.map(([status]) => status).join(" ")}
        </span>
      </p>
      <Hint about="Conduit's own answers">
        <span className="flex flex-col gap-1">
          {conduitAnswers.map(([status, when]) => (
            <span key={status}>
              <span className="font-mono">{status}</span> {when}.
            </span>
          ))}
          <span>Each is problem details, as application/problem+json.</span>
        </span>
      </Hint>
    </section>
  );
}
