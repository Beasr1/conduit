import { Button } from "@/components/ui/button";
import { removeEdges } from "@/features/editor/edits";
import { RESPONSE, toFlow } from "@/features/editor/flow";
import { useProblems } from "@/features/editor/hooks/use-problems";
import type { Found, Place, StepField } from "@/features/editor/problems";
import { useEditor, useEditorStore } from "@/features/editor/store";
import type { components } from "@/gen/schema";

type Definition = components["schemas"]["Definition"];

const fieldNames: Record<StepField, string> = {
  id: "Id",
  kind: "Kind",
  request: "Request",
  expr: "Expression",
  method: "Method",
  url: "URL",
  headers: "Request headers",
  query: "Query",
  body: "Request body",
  timeout: "Timeout",
  attempts: "Attempts",
  idempotent: "Idempotent",
};

const everywhere = () => true;

// The forms' element ids for a step's fields.
const fieldIds: Partial<Record<StepField, string>> = {
  id: "step-id",
  method: "step-method",
  url: "step-url",
  body: "step-body",
  timeout: "step-timeout",
  attempts: "step-attempts",
  idempotent: "step-idempotent",
  expr: "step-expr",
};

// fieldOf is the element a problem's field is drawn as, once its panel is
// open: a header or parameter by its row, which the form draws in the
// definition's order. A problem with no field goes to the step's first.
function fieldOf(
  place: Place,
  code: string,
  draft: Definition,
): string | undefined {
  switch (place.on) {
    case "step": {
      const { field, name } = place;
      if ((field === "headers" || field === "query") && name !== undefined) {
        const map = draft.nodes[place.index]?.request?.[field] ?? {};
        const row = Object.keys(map).indexOf(name);
        const part = code === "invalid_header_name" ? "name" : "value";
        if (row >= 0) return `step-${field}-${row}-${part}`;
      }
      return fieldIds[field ?? "id"] ?? "step-id";
    }
    case "connection":
      return "connection-when";
    case "response":
      return place.field === "output" ? "response-output" : "response-schema";
    case "settings":
      return "workflow-input-schema";
    default:
      return undefined;
  }
}

// ProblemList lists what the last check found, steps first. Picking one
// opens what it's in.
export function ProblemList() {
  const found = useProblems(everywhere);
  if (found.length === 0)
    return <p className="text-sm text-muted-foreground">No problems.</p>;
  return (
    <>
      <p className="text-sm text-muted-foreground">
        A workflow with problems can be saved, but not published.
      </p>
      <ul className="flex flex-col gap-1">
        {found.map((f, i) => (
          <li key={i}>
            <Entry found={f} />
          </li>
        ))}
      </ul>
    </>
  );
}

// Entry is one problem: where it is, and what's wrong. A connection the
// canvas can't draw, since an end names no step, can't be opened, so it's
// offered for removal instead.
function Entry({ found: { place, code, message } }: { found: Found }) {
  const editor = useEditorStore();
  const draft = useEditor((s) => s.draft);
  const show = useEditor((s) => s.show);
  const openPanel = useEditor((s) => s.openPanel);
  const edit = useEditor((s) => s.edit);
  const text = (
    <>
      <span className="font-medium">
        <Where place={place} draft={draft} />
      </span>
      <span className="text-muted-foreground">{message}</span>
    </>
  );

  if (place.on === "workflow")
    return (
      <div className="flex flex-col gap-0.5 px-2 py-1.5 text-sm">{text}</div>
    );
  if (place.on === "connection" && !drawn(draft, place.index))
    return (
      <div className="flex items-start justify-between gap-2 px-2 py-1.5">
        <div className="flex flex-col gap-0.5 text-sm">{text}</div>
        <Button
          variant="outline"
          size="xs"
          onClick={() => edit((d) => removeEdges(d, [place.index]))}
        >
          Remove connection
        </Button>
      </div>
    );

  // The canvas names a step or connection by its key, which toFlow gives
  // it. It's worked out on a click, not on every draw. The cursor goes to
  // the field once its panel is drawn.
  function open() {
    const draft = editor.getState().draft;
    const flow = toFlow(draft);
    const field = fieldOf(place, code, draft);
    if (field)
      requestAnimationFrame(() => document.getElementById(field)?.focus());
    if (place.on === "settings") openPanel("settings");
    else if (place.on === "response") show("nodes", RESPONSE);
    else if (place.on === "step") {
      const key = flow.nodes[place.index]?.id;
      if (key) show("nodes", key);
    } else if (place.on === "connection") {
      const key = flow.edges.find((e) => e.data?.index === place.index)?.id;
      if (key) show("edges", key);
    }
  }

  return (
    <Button
      variant="ghost"
      className="h-auto w-full flex-col items-start gap-0.5 py-1.5 text-left font-normal whitespace-normal"
      onClick={open}
    >
      {text}
    </Button>
  );
}

// drawn says whether the canvas draws a connection: both its ends name a
// step.
function drawn(draft: Definition, index: number): boolean {
  const e = draft.edges?.[index];
  const named = (id: string | undefined) =>
    !!id && draft.nodes.some((n) => n.id === id);
  return named(e?.from) && named(e?.to);
}

// Where says where a problem is, in the screen's words.
function Where({ place, draft }: { place: Place; draft: Definition }) {
  switch (place.on) {
    case "step": {
      const id = draft.nodes[place.index]?.id || "(no id)";
      const part =
        place.field === undefined
          ? undefined
          : place.name === undefined
            ? fieldNames[place.field]
            : place.field === "headers"
              ? `Request header “${place.name}”`
              : `Query parameter “${place.name}”`;
      return (
        <>
          <span className="font-mono">{id}</span>
          {part && ` · ${part}`}
        </>
      );
    }
    case "connection": {
      const e = draft.edges?.[place.index];
      return (
        <>
          Connection <span className="font-mono">{e?.from}</span> →{" "}
          <span className="font-mono">{e?.to}</span>
          {place.field === "when" && " · Condition"}
        </>
      );
    }
    case "response":
      return (
        <>Response · {place.field === "output" ? "Output" : "Output schema"}</>
      );
    case "settings":
      return <>Workflow settings · Input schema</>;
    default:
      return <>Workflow</>;
  }
}
