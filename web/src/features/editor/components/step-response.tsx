import type { ReactNode } from "react";

import { useEditor } from "@/features/editor/store";

// StepResponse says what an http step gets back, and how the steps after it
// read that: its part of the run's data, as the engine builds it.
export function StepResponse({ index }: { index: number }) {
  const id = useEditor((s) => s.draft.nodes[index]?.id ?? "");
  const parts: [string, ReactNode][] = [
    ["status", "The status code, which says which response it was."],
    [
      "headers",
      <>
        The headers, with names in lower case. A name with a hyphen goes in
        backticks, as in{" "}
        <span className="font-mono">{`nodes.${id}.headers.\`content-type\``}</span>
        .
      </>,
    ],
    [
      "body",
      "The JSON body, or null if there's none, or, for a response besides 2xx, if it isn't JSON.",
    ],
  ];
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>Steps after this one can read what it gets back:</p>
      <dl className="flex flex-col gap-2">
        {parts.map(([part, what]) => (
          <div key={part}>
            <dt className="font-mono">{`nodes.${id}.${part}`}</dt>
            <dd className="text-muted-foreground">{what}</dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground">
        A status the step has no response for, or a 2xx body that isn&apos;t
        JSON, fails the step, and with it the run.
      </p>
    </div>
  );
}
