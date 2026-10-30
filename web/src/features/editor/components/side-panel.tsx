import { XIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { ConnectionForm } from "@/features/editor/components/connection-form";
import { JsonField } from "@/features/editor/components/json-field";
import { ProblemList } from "@/features/editor/components/problem-list";
import { ResponseForm } from "@/features/editor/components/response-form";
import { StepSettings } from "@/features/editor/components/step-panel";
import { RESPONSE, toFlow } from "@/features/editor/flow";
import { useEditor } from "@/features/editor/store";

const stepTitles: Record<string, string> = {
  http: "HTTP step",
  transform: "Transform step",
};

// SidePanel holds the settings of what's picked on the canvas, one thing at a
// time: a step, a connection or the response, or else the workflow's own
// settings or the list of problems, once they're opened.
export function SidePanel() {
  const draft = useEditor((s) => s.draft);
  const selected = useEditor((s) => s.selected);
  const panel = useEditor((s) => s.panel);
  const pick = useEditor((s) => s.pick);
  const closePanel = useEditor((s) => s.closePanel);
  const flow = useMemo(() => toFlow(draft), [draft]);

  const node =
    selected.nodes.length === 1 && selected.edges.length === 0
      ? selected.nodes[0]
      : undefined;
  const edge =
    selected.edges.length === 1 && selected.nodes.length === 0
      ? selected.edges[0]
      : undefined;

  let title: string;
  let body: ReactNode;
  let close: () => void;
  if (panel === "settings") {
    title = "Workflow settings";
    body = (
      <JsonField
        id="workflow-input-schema"
        label="Input schema"
        field="input_schema"
        description="A JSON Schema the run's input must match. A served workflow answers input that doesn't with 400."
      />
    );
    close = closePanel;
  } else if (panel === "problems") {
    title = "Problems";
    body = <ProblemList />;
    close = closePanel;
  } else if (node === RESPONSE) {
    title = "Response";
    body = <ResponseForm />;
    close = () => pick("nodes", [{ id: RESPONSE, selected: false }]);
  } else if (node !== undefined) {
    const index = flow.nodes.find((n) => n.id === node)?.data.index;
    if (index === undefined) return null;
    title = stepTitles[draft.nodes[index]?.kind ?? ""] ?? "Step";
    body = <StepSettings index={index} />;
    close = () => pick("nodes", [{ id: node, selected: false }]);
  } else if (edge !== undefined) {
    const index = flow.edges.find((e) => e.id === edge)?.data?.index;
    if (index === undefined) return null;
    title = "Connection";
    body = <ConnectionForm key={`edge-${index}`} index={index} />;
    close = () => pick("edges", [{ id: edge, selected: false }]);
  } else {
    return null;
  }

  // nokey: React Flow deletes what's selected on Delete or Backspace anywhere
  // on the page except in a text field. Without it, either key on one of
  // these buttons deleted the step being edited.
  return (
    <aside
      aria-labelledby="panel-title"
      className="nokey flex w-96 shrink-0 flex-col gap-5 overflow-y-auto rounded-lg border p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="panel-title" className="font-heading text-base font-semibold">
          {title}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          onClick={close}
        >
          <XIcon />
        </Button>
      </div>
      {body}
    </aside>
  );
}
