import { Button } from "@/components/ui/button";
import { useFollowRun, useRun } from "@/features/editor/hooks/use-runs";
import { runSaid } from "@/features/editor/runs";
import { useEditor } from "@/features/editor/store";

// RunBar says which run the canvas shows and how it went, follows the run
// while it goes on, and leads to the runs before it, or back to editing.
// moved says whether the draft has changed since a revision.
export function RunBar({ moved }: { moved: (revision: number) => boolean }) {
  const id = useEditor((s) => s.run);
  const closeRun = useEditor((s) => s.closeRun);
  const openPanel = useEditor((s) => s.openPanel);
  const run = useRun(id);
  useFollowRun(id, run.data?.status === "running");
  if (!id) return null;
  const started = run.data
    ? new Date(run.data.started_at).toLocaleTimeString()
    : "";
  // nokey: Delete or Backspace on its buttons would otherwise delete what's
  // selected on the canvas.
  return (
    <div className="nokey flex basis-full flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-sm">
      {/* A status, so a screen reader hears the run end. */}
      <p role="status">
        {run.data
          ? `Run of revision ${run.data.revision}, started ${started}: ${runSaid(run.data)}${moved(run.data.revision) ? ". The draft has changed since." : ""}`
          : run.isError
            ? "Couldn't load the run."
            : "Loading the run…"}
      </p>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={() => openPanel("runs")}>
          Runs
        </Button>
        <Button variant="ghost" size="sm" onClick={closeRun}>
          Close run
        </Button>
      </div>
    </div>
  );
}
