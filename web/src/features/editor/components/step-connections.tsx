import { ChevronRightIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ProblemMark } from "@/features/editor/components/problem-mark";
import {
  canConnect,
  canJoin,
  connect,
  joinAnswer,
  joinedTo,
} from "@/features/editor/edits";
import {
  outputOf,
  RESPONSE,
  toFlow,
  UNHANDLED,
  UNHANDLED_HANDLE,
} from "@/features/editor/flow";
import { useProblemCount } from "@/features/editor/hooks/use-problems";
import { useEditor, useEditorStore } from "@/features/editor/store";

// StepConnections is what follows one of a step's responses: the
// connections that leave on it, each opening its line, where its condition
// is edited, and the response's answers it gives; then Connect to, which
// joins another step on it, or an answer with no line yet, without drawing,
// as a keyboard can (WCAG 2.5.7). on is the response's status, and none is
// 2xx, or a transform's one value; UNHANDLED is its Unhandled block. exit
// is what a transform's case, whose status on is, is called.
export function StepConnections({
  index,
  on,
  exit,
}: {
  index: number;
  on?: number;
  exit?: string;
}) {
  const edit = useEditor((s) => s.edit);
  const from = useEditor((s) => s.draft.nodes[index]?.id ?? "");
  const http = useEditor((s) => s.draft.nodes[index]?.kind === "http");
  // The connections that leave on this response, by their place in edges.
  const leaving = useEditor(
    useShallow((s) =>
      (s.draft.edges ?? []).flatMap((e, i) =>
        e.from === from && (outputOf(e) ?? 0) === (on ?? 0) ? [i] : [],
      ),
    ),
  );
  // The answers this response gives, and those a line from here could
  // join: each takes one. By their place in the response's answers.
  const statuses = useEditor(
    useShallow((s) => (s.draft.response?.answers ?? []).map((a) => a.status)),
  );
  const gives = useEditor(
    useShallow((s) => (from === "" ? [] : joinedTo(s.draft, from, on))),
  );
  const joinable = useEditor(
    useShallow((s) =>
      from === ""
        ? []
        : (s.draft.response?.answers ?? []).flatMap((_, k) =>
            canJoin(s.draft, k) ? [k] : [],
          ),
    ),
  );
  // The steps a connection from here could go to: not this one, not one
  // it's joined to on this response already, and none that would make a
  // loop. A step whose id is missing or shared can't be named by one.
  const reachable = useEditor(
    useShallow((s) => {
      const ids = s.draft.nodes.map((n) => n.id);
      return ids.filter(
        (id) =>
          id !== "" &&
          from !== "" &&
          ids.indexOf(id) === ids.lastIndexOf(id) &&
          canConnect(s.draft, from, id, on),
      );
    }),
  );
  const unhandled = on === UNHANDLED;
  const handle = unhandled
    ? UNHANDLED_HANDLE
    : on === undefined
      ? http
        ? "2xx"
        : "out"
      : String(on);
  const point = unhandled
    ? "its Unhandled point"
    : http
      ? `the ${handle} point`
      : exit
        ? `the ${exit} point`
        : "its point";

  const none = reachable.length === 0 && joinable.length === 0;

  return (
    <section className="flex flex-col gap-3 text-sm">
      <div className="flex flex-col gap-1.5">
        <h3 className="font-medium">
          {unhandled
            ? "Then, on Unhandled"
            : http
              ? `Then, on ${handle}`
              : exit
                ? `Then, on ${exit}`
                : "Then"}
        </h3>
        {leaving.length === 0 && gives.length === 0 ? (
          <p className="text-muted-foreground">
            None yet: connect a step below, or drag from {point} on the canvas
            to the step.
            {statuses.length > 0 && joinable.length === 0 && (
              <>
                {" "}
                Each answer on the response takes one line, and has it: to
                answer from here too, join this step and the one that gives the
                answer to a transform.
              </>
            )}
          </p>
        ) : (
          <ul className="flex flex-col">
            {leaving.map((i) => (
              <Row key={i} index={i} />
            ))}
            {gives.map((k) => (
              <AnswerRow key={`answer-${k}`} status={statuses[k]} />
            ))}
          </ul>
        )}
      </div>
      <Field>
        <FieldLabel htmlFor={`step-connect-${handle}`}>
          {unhandled ? "Connect Unhandled to" : "Connect to"}
        </FieldLabel>
        <Select<string>
          value={null}
          disabled={none}
          onValueChange={(to) => {
            if (to === null) return;
            if (to.startsWith(ANSWER))
              edit((d) =>
                joinAnswer(d, Number(to.slice(ANSWER.length)), from, on),
              );
            else edit((d) => connect(d, from, to, on));
          }}
        >
          <SelectTrigger id={`step-connect-${handle}`} className="w-full">
            <SelectValue
              placeholder={none ? "No step to connect to" : "Pick a step"}
            />
          </SelectTrigger>
          <SelectContent>
            {reachable.map((id) => (
              <SelectItem key={id} value={id} className="font-mono">
                {id}
              </SelectItem>
            ))}
            {joinable.map((k) => (
              <SelectItem key={`answer-${k}`} value={`${ANSWER}${k}`}>
                Response {statuses[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          The step picked runs after this one when it{" "}
          {unhandled ? "fails into Unhandled" : "answers this way"}. Its
          condition, if it needs one, is the connection&apos;s. Picking an
          answer of the response makes this step give it.
        </FieldDescription>
      </Field>
    </section>
  );
}

// An answer, as Connect to's value names it: its place in the response's
// answers, after this.
const ANSWER = `${RESPONSE}:`;

// AnswerRow is an answer of the response the step gives through this
// response. A click opens the response.
function AnswerRow({ status }: { status: number | undefined }) {
  const show = useEditor((s) => s.show);
  return (
    <li>
      <Button
        variant="ghost"
        className="h-auto w-full justify-start gap-2 py-1.5 text-left font-normal [&_svg]:size-3.5"
        onClick={() => show("nodes", RESPONSE)}
      >
        <span>Response {status}:</span>{" "}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          this step answers
        </span>
        <ChevronRightIcon aria-hidden />
      </Button>
    </li>
  );
}

// Row is one connection leaving on the response: the step it goes to, and
// when it's taken. A click opens its line, as a click on the canvas does.
function Row({ index }: { index: number }) {
  const editor = useEditorStore();
  const show = useEditor((s) => s.show);
  const to = useEditor((s) => s.draft.edges?.[index]?.to ?? "");
  const when = useEditor((s) => s.draft.edges?.[index]?.when);
  const problems = useProblemCount(
    (p) => p.on === "connection" && p.index === index,
  );

  // The canvas names a connection by its key, which toFlow gives it. It's
  // worked out on a click, not on every draw.
  function open() {
    const key = toFlow(editor.getState().draft).edges.find(
      (e) => e.data?.index === index,
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
        {/* The spaces are text of their own: a name drops one at the end
            of an element's text, and a flex row doesn't draw them. */}
        <span className="sr-only">Connection to</span>{" "}
        <span className="font-mono">{to}</span>{" "}
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
