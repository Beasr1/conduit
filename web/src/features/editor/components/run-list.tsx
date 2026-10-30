import { Button } from "@/components/ui/button";
import { useRuns } from "@/features/editor/hooks/use-runs";
import { runSaid } from "@/features/editor/runs";
import { useEditor } from "@/features/editor/store";

// RunList lists a workflow's latest runs, newest first: those started here,
// and those its callers made through its URL. Picking one shows it on the
// canvas.
export function RunList({ workflow }: { workflow: string }) {
  const runs = useRuns(workflow);
  const shown = useEditor((s) => s.run);
  const showRun = useEditor((s) => s.showRun);
  if (runs.isPending)
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (runs.isError)
    return <p className="text-sm text-destructive">Couldn&apos;t load them.</p>;
  if (runs.data.runs.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No runs yet. Run the workflow, or call it at its URL once it&apos;s
        published.
      </p>
    );
  return (
    <ul className="flex flex-col gap-1">
      {runs.data.runs.map((r) => (
        <li key={r.id}>
          <Button
            variant="ghost"
            aria-current={r.id === shown || undefined}
            className="h-auto w-full flex-col items-start gap-0.5 py-1.5 text-left font-normal whitespace-normal aria-current:bg-muted"
            onClick={() => showRun(r.id)}
          >
            <span className="font-medium">
              {new Date(r.started_at).toLocaleString()} · revision {r.revision}
            </span>
            <span className="text-muted-foreground">
              {runSaid(r)} ·{" "}
              {r.trigger === "served" ? "called at its URL" : "run here"}
            </span>
          </Button>
        </li>
      ))}
    </ul>
  );
}
