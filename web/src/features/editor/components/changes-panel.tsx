import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { plainOf, usedIn, wordsOf } from "@/features/editor/changes";
import { toFlow } from "@/features/editor/flow";
import { useChanges, useDismiss } from "@/features/editor/hooks/use-changes";
import { useEditor, useEditorStore } from "@/features/editor/store";
import type { components } from "@/gen/schema";

type Change = components["schemas"]["Change"];

const when = (t: string) => new Date(t).toLocaleString();

// ChangesButton opens the changes list (plan 16), saying how many are
// active.
export function ChangesButton({ workflow }: { workflow: string }) {
  const openPanel = useEditor((s) => s.openPanel);
  const active = useChanges(workflow, false).data?.changes.length ?? 0;
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={active > 0 ? `Changes, ${active} active` : "Changes"}
      onClick={() => openPanel("changes")}
    >
      Changes
      {active > 0 && <Badge variant="secondary">{active}</Badge>}
    </Button>
  );
}

// ChangesPanel is what has happened to what the workflow uses (plan 16):
// what's still to come, or waits on someone, then the history, newest
// first. A change about something a step uses opens that step, where it's
// taken up.
export function ChangesPanel({ workflow }: { workflow: string }) {
  const active = useChanges(workflow, false);
  const history = useChanges(workflow, true);
  return (
    <>
      <section aria-labelledby="changes-active" className="flex flex-col gap-2">
        <h3 id="changes-active" className="text-sm font-medium">
          Active
        </h3>
        <List
          workflow={workflow}
          changes={active.data?.changes}
          failed={active.isError}
          none="Nothing waits on you."
        />
      </section>
      <section
        aria-labelledby="changes-history"
        className="flex flex-col gap-2"
      >
        <h3 id="changes-history" className="text-sm font-medium">
          History
        </h3>
        <List
          workflow={workflow}
          changes={history.data?.changes}
          failed={history.isError}
          none="Nothing has happened yet."
        />
      </section>
    </>
  );
}

function List({
  workflow,
  changes,
  failed,
  none,
}: {
  workflow: string;
  changes: Change[] | undefined;
  failed: boolean;
  none: string;
}) {
  if (changes === undefined)
    return failed ? (
      <p className="text-sm text-destructive">Couldn&apos;t load them.</p>
    ) : (
      <p className="text-sm text-muted-foreground">Loading…</p>
    );
  if (changes.length === 0)
    return <p className="text-sm text-muted-foreground">{none}</p>;
  return (
    <ul className="flex flex-col gap-2">
      {changes.map((c) => (
        <Line key={c.id} workflow={workflow} change={c} />
      ))}
    </ul>
  );
}

function Line({ workflow, change: c }: { workflow: string; change: Change }) {
  const editor = useEditorStore();
  const show = useEditor((s) => s.show);
  const dismiss = useDismiss(workflow);
  const words = wordsOf(c);
  const uses = usedIn(c);
  // The step that uses what it's about, worked out on a click.
  function open() {
    const draft = editor.getState().draft;
    const node = toFlow(draft).nodes.find((n) => {
      const u = draft.nodes[n.data.index]?.uses;
      return (
        (uses.upstream !== undefined && u?.upstream === uses.upstream) ||
        (uses.workflow !== undefined && u?.workflow === uses.workflow)
      );
    });
    if (node) show("nodes", node.id);
  }
  const said = (
    <span className="wrap-break-word">
      {words.code && <span className="font-mono">{words.code}</span>}
      {words.code && " "}
      {words.text}
    </span>
  );
  return (
    <li className="flex flex-col gap-1 rounded-md border p-2 text-sm">
      <div className="flex items-start justify-between gap-2">
        {c.state === "active" && (uses.upstream || uses.workflow) ? (
          <Button
            variant="link"
            // A button keeps its width and one line, by the kit's classes: this
            // one shrinks and wraps, so Dismiss stays beside it.
            className="h-auto min-w-0 shrink justify-start p-0 text-left font-normal whitespace-normal"
            onClick={open}
          >
            {said}
          </Button>
        ) : (
          said
        )}
        {c.state === "active" && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            aria-label={`Dismiss: ${plainOf(words)}`}
            disabled={dismiss.isPending}
            onClick={() => dismiss.mutate(c.id)}
          >
            Dismiss
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {when(c.created_at)}
        {c.state === "dismissed" && c.dismissed_at
          ? ` · dismissed ${when(c.dismissed_at)}`
          : ""}
      </p>
    </li>
  );
}
