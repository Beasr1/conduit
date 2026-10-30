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
import { canConnect, connect } from "@/features/editor/edits";
import { toFlow } from "@/features/editor/flow";
import { useProblemCount } from "@/features/editor/hooks/use-problems";
import { useEditor, useEditorStore } from "@/features/editor/store";

// StepConnections is what follows one of a step's responses: the
// connections that leave on it, each opening its line, where its condition
// is edited; then Connect to, which joins another step on it without
// drawing, as a keyboard can (WCAG 2.5.7). on is the response's status, and
// none is 2xx, or a transform's one value.
export function StepConnections({ index, on }: { index: number; on?: number }) {
  const edit = useEditor((s) => s.edit);
  const from = useEditor((s) => s.draft.nodes[index]?.id ?? "");
  const http = useEditor((s) => s.draft.nodes[index]?.kind === "http");
  // The connections that leave on this response, by their place in edges.
  const leaving = useEditor(
    useShallow((s) =>
      (s.draft.edges ?? []).flatMap((e, i) =>
        e.from === from && (e.on ?? 0) === (on ?? 0) ? [i] : [],
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
  const handle = on === undefined ? (http ? "2xx" : "out") : String(on);
  const point = http ? `the ${handle} point` : "its point";

  return (
    <section className="flex flex-col gap-3 text-sm">
      <div className="flex flex-col gap-1.5">
        <h3 className="font-medium">{http ? `Then, on ${handle}` : "Then"}</h3>
        {leaving.length === 0 ? (
          <p className="text-muted-foreground">
            None yet: connect a step below, or drag from {point} on the canvas
            to the step.
          </p>
        ) : (
          <ul className="flex flex-col">
            {leaving.map((i) => (
              <Row key={i} index={i} />
            ))}
          </ul>
        )}
      </div>
      <Field>
        <FieldLabel htmlFor={`step-connect-${handle}`}>Connect to</FieldLabel>
        <Select<string>
          value={null}
          disabled={reachable.length === 0}
          onValueChange={(to) => {
            if (to !== null) edit((d) => connect(d, from, to, on));
          }}
        >
          <SelectTrigger id={`step-connect-${handle}`} className="w-full">
            <SelectValue
              placeholder={
                reachable.length === 0 ? "No step to connect to" : "Pick a step"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {reachable.map((id) => (
              <SelectItem key={id} value={id} className="font-mono">
                {id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          The step picked runs after this one when it answers this way. Its
          condition, if it needs one, is the connection&apos;s.
        </FieldDescription>
      </Field>
    </section>
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
