import { useParams } from "react-router";

import { useWorkflow } from "@/features/workflows/hooks/use-workflows";

// The workflow's page. Phase B of plan 04 puts the graph editor here.
export function Component() {
  const { id = "" } = useParams();
  const { data, isPending, isError } = useWorkflow(id);

  if (isPending)
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (isError)
    return <p className="text-sm text-destructive">Couldn't load it.</p>;

  const { workflow, revision } = data;
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-2">
      <h1 className="font-heading text-xl font-semibold">{workflow.name}</h1>
      <p className="font-mono text-sm text-muted-foreground">
        /serve/{workflow.slug} · revision {revision.revision}
      </p>
      <p className="text-sm text-muted-foreground">
        The graph editor isn&apos;t built yet.
      </p>
    </div>
  );
}
