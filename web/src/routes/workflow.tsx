import { useParams } from "react-router";

import { Editor } from "@/features/editor/components/editor";
import { useWorkflow } from "@/features/workflows/hooks/use-workflows";

// The workflow's page: what it is and where it's served, above its editor.
export function Component() {
  const { id = "" } = useParams();
  const { data, isPending, isError } = useWorkflow(id);

  if (isPending)
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (isError)
    return <p className="text-sm text-destructive">Couldn't load it.</p>;

  const { workflow, revision } = data;
  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold">{workflow.name}</h1>
        <p className="font-mono text-sm text-muted-foreground">
          /serve/{workflow.slug} · revision {revision.revision}
        </p>
      </div>
      <Editor key={workflow.id} definition={revision.definition} />
    </div>
  );
}
