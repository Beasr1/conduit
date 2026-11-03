import { useState } from "react";
import { useParams } from "react-router";

import { Editor } from "@/features/editor/components/editor";
import { fill } from "@/features/editor/upstreams";
import { useVersionsOf } from "@/features/editor/hooks/use-upstreams";
import { useWorkflow } from "@/lib/workflows";

// The workflow's page: its editor, opened on the latest revision.
export function Component() {
  const { id = "" } = useParams();
  const { data, isPending, refetch } = useWorkflow(id);
  // The versions of upstreams and the revisions of workflows its steps
  // use, which draw those steps (plan 07).
  const used = useVersionsOf(data?.revision.definition);
  // Counts the times the newest revision was opened afresh, as when another
  // tab saved first. Until then the editor keeps what it opened.
  const [opened, setOpened] = useState(0);

  if (isPending || used.pending)
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  // A refetch that fails keeps the workflow on screen, and the draft with it.
  if (!data)
    return <p className="text-sm text-destructive">Couldn&apos;t load it.</p>;

  return (
    <div className="flex h-full flex-col gap-4">
      <Editor
        key={`${data.workflow.id}#${opened}`}
        workflow={data.workflow}
        revision={{
          ...data.revision,
          definition: fill(
            data.revision.definition,
            used.versions,
            used.called,
          ),
        }}
        versions={used.versions}
        called={used.called}
        onReload={() =>
          void refetch().then((r) => {
            if (r.isSuccess) setOpened((n) => n + 1);
          })
        }
      />
    </div>
  );
}
