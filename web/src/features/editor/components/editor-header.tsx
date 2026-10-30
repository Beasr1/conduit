import { CircleAlertIcon } from "lucide-react";
import {
  Fragment,
  type ReactNode,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from "react";
import { useBlocker } from "react-router";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RunBar } from "@/features/editor/components/run-bar";
import { RunButton } from "@/features/editor/components/run-dialog";
import {
  CheckContext,
  CheckingContext,
  useProblems,
} from "@/features/editor/hooks/use-problems";
import { usePublish, useSaveDraft } from "@/features/editor/hooks/use-save";
import { useEditor, useEditorStore } from "@/features/editor/store";
import type { components } from "@/gen/schema";
import { ApiError } from "@/lib/api";

type Definition = components["schemas"]["Definition"];
type Revision = components["schemas"]["Revision"];
type Workflow = components["schemas"]["Workflow"];

const everywhere = () => true;

// changed says whether a draft differs from the one last saved or opened.
function changed(draft: Definition, saved: Definition): boolean {
  return draft !== saved && JSON.stringify(draft) !== JSON.stringify(saved);
}

// EditorHeader names the workflow, says where the draft and the served
// revision stand, and saves and publishes. A save builds on the revision the
// draft started from, sent as If-Match. The editor stays as it is after a
// save, and the next one builds on the new revision.
export function EditorHeader({
  workflow,
  opened,
  onReload,
}: {
  workflow: Workflow;
  opened: Revision;
  onReload: () => void;
}) {
  const editor = useEditorStore();
  const draft = useEditor((s) => s.draft);
  const openPanel = useEditor((s) => s.openPanel);
  const check = useContext(CheckContext);
  const { failed: unchecked } = useContext(CheckingContext);
  const problems = useProblems(everywhere).length;
  const save = useSaveDraft(workflow.id);
  const publish = usePublish(workflow.id);
  // The revision the draft builds on, and the draft as it was saved or
  // opened, which unsaved changes are measured against.
  const [base, setBase] = useState(opened.revision);
  const [saved, setSaved] = useState<Definition>(opened.definition);
  const dirty = useMemo(() => changed(draft, saved), [draft, saved]);
  // A newer revision exists when a save was refused for one, or when the
  // workflow, fetched again as the window regains focus, says so. Nothing is
  // saved over it: the draft stays on screen to copy from until it's loaded.
  const refused = save.error instanceof ApiError && save.error.status === 412;
  const newer = refused || workflow.latest_revision > base;
  const [dismissed, setDismissed] = useState(false);

  async function saveDraft(on: number) {
    const sent = editor.getState().draft;
    try {
      const revision = await save.mutateAsync({ draft: sent, base: on });
      setBase(revision.revision);
      setSaved(sent);
      return revision;
    } catch {
      return undefined; // save.error says what went wrong
    }
  }

  // Publish puts what's on screen live, saving unsaved changes first. A
  // draft the last check found problems in isn't sent at all: the list of
  // problems opens instead, as it does when the server refuses.
  async function publishDraft() {
    if (check?.of === editor.getState().draft && check.problems.length > 0) {
      openPanel("problems");
      return;
    }
    let revision = base;
    if (dirty) {
      const done = await saveDraft(base);
      if (!done) return;
      if (done.problems.length > 0) {
        openPanel("problems");
        return;
      }
      revision = done.revision;
    }
    try {
      await publish.mutateAsync(revision);
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) openPanel("problems");
    }
  }

  // Ctrl-S or Cmd-S saves, wherever the focus is, instead of the browser
  // offering to save the page.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.key.toLowerCase() !== "s" || !(e.ctrlKey || e.metaKey)) return;
    if (e.altKey || e.shiftKey) return;
    e.preventDefault();
    // The draft as it is now: the id field may have just applied what was
    // typed in it, after this last drew.
    if (save.isPending || newer) return;
    if (changed(editor.getState().draft, saved)) void saveDraft(base);
  });
  useEffect(() => {
    const listen = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", listen);
    return () => window.removeEventListener("keydown", listen);
  }, []);

  // Leaving with unsaved changes asks first: another page in the app through
  // a dialog, and closing or reloading the tab through the browser's own.
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const status: ReactNode[] = [];
  if (save.isPending) status.push("Saving…");
  else if (save.isError && !newer)
    status.push(
      <span className="text-destructive">Not saved. {save.error.message}</span>,
    );
  else if (dirty) status.push("Unsaved changes");
  else if (save.isSuccess) status.push("Saved");
  if (newer)
    status.push(
      workflow.latest_revision > base
        ? `Revision ${workflow.latest_revision} was saved elsewhere`
        : "A newer revision was saved elsewhere",
    );
  if (publish.isPending) status.push("Publishing…");
  else if (
    publish.isError &&
    !(publish.error instanceof ApiError && publish.error.status === 422)
  )
    status.push(
      <span className="text-destructive">
        Not published. {publish.error.message}
      </span>,
    );
  if (unchecked) status.push("Couldn't check for problems");

  const served = new URL(`/serve/${workflow.slug}`, window.location.origin)
    .href;
  const live = workflow.published_revision === base && !dirty;

  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold">{workflow.name}</h1>
        <p className="text-sm text-muted-foreground">
          Revision {base}
          {status.map((s, i) => (
            <Fragment key={i}> · {s}</Fragment>
          ))}
        </p>
        <p className="text-sm text-muted-foreground">
          {workflow.published_revision === undefined
            ? "Not published. Publishing serves it at "
            : `Revision ${workflow.published_revision} is served at `}
          <span className="font-mono break-all">{served}</span>
        </p>
      </div>
      {/* nokey: Delete or Backspace on these buttons would otherwise delete
          what's selected on the canvas. */}
      <div className="nokey flex items-center gap-2">
        {problems > 0 && (
          <Button variant="outline" onClick={() => openPanel("problems")}>
            <CircleAlertIcon aria-hidden className="text-destructive" />
            {problems === 1 ? "1 problem" : `${problems} problems`}
          </Button>
        )}
        {newer && (
          <Button variant="outline" onClick={onReload}>
            Load newer revision
          </Button>
        )}
        <Button
          variant="outline"
          disabled={!dirty || save.isPending || newer}
          onClick={() => void saveDraft(base)}
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <RunButton
          workflow={workflow.id}
          disabled={save.isPending || newer}
          revision={async () =>
            dirty ? (await saveDraft(base))?.revision : base
          }
        />
        <Button
          disabled={live || save.isPending || publish.isPending || newer}
          onClick={() => void publishDraft()}
        >
          {publish.isPending ? "Publishing…" : live ? "Published" : "Publish"}
        </Button>
      </div>
      <RunBar moved={(revision) => dirty || revision !== base} />

      <Dialog
        open={refused && !dismissed}
        onOpenChange={(open) => {
          if (!open) setDismissed(true);
        }}
      >
        <DialogContent className="nokey">
          <DialogHeader>
            <DialogTitle>A newer revision was saved</DialogTitle>
            <DialogDescription>
              This workflow was saved somewhere else after you opened it,
              perhaps in another tab, so your changes here can&apos;t be saved
              over it. Load the newer revision to go on; your unsaved changes
              are dropped.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDismissed(true)}>
              Not now
            </Button>
            <Button onClick={onReload}>Load newer revision</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={blocker.state === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
      >
        <DialogContent className="nokey">
          <DialogHeader>
            <DialogTitle>Leave without saving?</DialogTitle>
            <DialogDescription>
              Your unsaved changes here will be lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => blocker.reset?.()}>
              Stay
            </Button>
            <Button variant="destructive" onClick={() => blocker.proceed?.()}>
              Leave
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
