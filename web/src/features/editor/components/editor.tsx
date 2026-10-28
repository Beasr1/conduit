import { useState } from "react";

import { Canvas } from "@/features/editor/components/canvas";
import { StepPanel } from "@/features/editor/components/step-panel";
import { createEditorStore, EditorContext } from "@/features/editor/store";
import type { components } from "@/gen/schema";

type Definition = components["schemas"]["Definition"];

// Editor edits one workflow. Its store is made once, from the definition it
// opened with, so render it with a key per workflow: opening another one
// starts afresh, and a refetch of this one changes nothing.
export function Editor({ definition }: { definition: Definition }) {
  const [store] = useState(() => createEditorStore(definition));
  return (
    <EditorContext value={store}>
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border">
          <Canvas />
        </div>
        <StepPanel />
      </div>
    </EditorContext>
  );
}
