import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { StepConnections } from "@/features/editor/components/step-connections";
import { joinedTo } from "@/features/editor/edits";
import { UNHANDLED } from "@/features/editor/flow";
import { useEditor } from "@/features/editor/store";

// StepUnhandled is a step's Unhandled block, as its panel shows it: what it
// takes, what the steps after it read, then the lines that leave it. Once
// an HTTP step's is joined straight to an answer, it warns that callers
// get what the upstream sent. A transform's panel has no tabs, so a click
// on the strip brings it into view there.
export function StepUnhandled({ index }: { index: number }) {
  const id = useEditor((s) => s.draft.nodes[index]?.id ?? "");
  const http = useEditor((s) => s.draft.nodes[index]?.kind === "http");
  const answers = useEditor(
    (s) => id !== "" && joinedTo(s.draft, id, UNHANDLED).length > 0,
  );
  const part = useEditor((s) => s.part);
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    // jsdom draws nothing, so it has no scrollIntoView.
    if (part === "unhandled" && !http)
      section.current?.scrollIntoView?.({ block: "nearest" });
  }, [part, http]);
  const node = <span className="font-mono">{`nodes.${id}.error`}</span>;
  return (
    <div className="flex flex-col gap-5">
      <section
        ref={section}
        aria-labelledby={`step-unhandled-${index}`}
        className="flex flex-col gap-1.5 text-sm"
      >
        <h3 id={`step-unhandled-${index}`} className="font-medium">
          Unhandled
        </h3>
        <p className="text-muted-foreground">
          {http
            ? "It takes what the step's responses don't: a status none of them is for, the connection or a timeout after its retries, a body over the cap or a 2xx body that isn't JSON, an address it may not call, or its JSONata failing."
            : "It takes the step's JSONata failing: its expression, or a case's condition or body."}{" "}
          Joined, the run goes on down the lines from here. With none, the
          failure fails the run, and the response&apos;s Unhandled answers it.
        </p>
        <p className="text-muted-foreground">
          The steps after read the failure as {node},{" "}
          <span className="font-mono">{"{ code, detail }"}</span>
          {http && (
            <>
              , beside <span className="font-mono">status</span>,{" "}
              <span className="font-mono">headers</span> and{" "}
              <span className="font-mono">body</span> when the upstream answered
            </>
          )}
          .
        </p>
      </section>
      <StepConnections index={index} on={UNHANDLED} />
      {answers && http && (
        <p className="flex gap-1.5 text-sm text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
          <TriangleAlertIcon aria-hidden />
          Callers get whatever the upstream sent with its failure, an error page
          or a stack trace included. To send them less, join a transform step
          that picks what they need.
        </p>
      )}
    </div>
  );
}
