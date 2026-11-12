import { type ReactNode, useMemo, useState } from "react";

import { ReadOnly } from "@/components/read-only";
import { Canvas } from "@/features/editor/components/canvas";
import { EditorHeader } from "@/features/editor/components/editor-header";
import { SidePanel } from "@/features/editor/components/side-panel";
import { useCheck } from "@/features/editor/hooks/use-check";
import {
  CheckContext,
  CheckingContext,
} from "@/features/editor/hooks/use-problems";
import type { Check } from "@/features/editor/problems";
import {
  createEditorStore,
  EditorContext,
  useEditor,
} from "@/features/editor/store";
import type { Called } from "@/features/editor/upstreams";
import type { components } from "@/gen/schema";

type Revision = components["schemas"]["Revision"];
type Upstream = components["schemas"]["Upstream"];
type Workflow = components["schemas"]["Workflow"];

// Editor edits one workflow, from the revision it opened with. Its store is
// made once, so render it with a key per workflow: opening another one starts
// afresh, and a refetch of this one changes nothing. onReload opens the
// newest revision afresh, for when another tab saved first. An archived
// workflow opens read-only (plan 15).
export function Editor({
  workflow,
  revision,
  versions,
  called,
  onReload,
}: {
  workflow: Workflow;
  // Filled from versions and called, the upstreams and workflows its steps
  // use (plan 07).
  revision: Revision;
  versions: Record<string, Upstream>;
  called: Record<string, Called>;
  onReload: () => void;
}) {
  const [opened] = useState(revision);
  const [store] = useState(() =>
    createEditorStore(opened.definition, versions, undefined, called),
  );
  const [first] = useState<Check>(() => ({
    of: opened.definition,
    problems: opened.problems,
  }));
  return (
    <EditorContext value={store}>
      <ReadOnly value={workflow.archived_at !== undefined}>
        <Checked first={first}>
          <EditorHeader
            workflow={workflow}
            opened={opened}
            onReload={onReload}
          />
          <div className="flex min-h-0 flex-1 gap-4">
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border">
              <Canvas workflow={workflow.id} />
            </div>
            <SidePanel workflow={workflow.id} />
          </div>
        </Checked>
      </ReadOnly>
    </EditorContext>
  );
}

// Checked checks the draft as it changes, and tells everything inside it
// what the last check found, starting with the opened revision's problems.
function Checked({ first, children }: { first: Check; children: ReactNode }) {
  const draft = useEditor((s) => s.draft);
  const { check, checking, failed } = useCheck(draft, first);
  const status = useMemo(() => ({ checking, failed }), [checking, failed]);
  return (
    <CheckContext value={check}>
      <CheckingContext value={status}>{children}</CheckingContext>
    </CheckContext>
  );
}
