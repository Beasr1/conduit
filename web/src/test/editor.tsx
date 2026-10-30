import { http, HttpResponse } from "msw";

import { Editor } from "@/features/editor/components/editor";
import type { components } from "@/gen/schema";
import { workflowRevision } from "@/test/fixtures";
import { renderAt } from "@/test/render";
import { server } from "@/test/server";

type Definition = components["schemas"]["Definition"];
type Preview = components["schemas"]["Preview"];
type ProblemError = components["schemas"]["ProblemError"];
type Validation = components["schemas"]["Validation"];

// answerEditor has the server answer what the editor asks as it's used:
// unless a test says otherwise, it finds nothing wrong with a draft, and a
// preview reads no data.
export function answerEditor() {
  server.use(
    http.post("/api/v1/validate", () =>
      HttpResponse.json<Validation>({ problems: [] }),
    ),
    http.post("/api/v1/preview", () =>
      HttpResponse.json<Preview>({
        reads: { input: null, nodes: {} },
        skipped: false,
        problems: [],
      }),
    ),
  );
}

// renderEditor opens the editor on definition, as revision 1 of an
// unpublished workflow, the way the workflow's page does, with the problems
// the server found in it.
export function renderEditor(
  definition: Definition,
  problems: ProblemError[] = [],
) {
  answerEditor();
  const { workflow, revision } = workflowRevision(
    "wf-1",
    "Spec example",
    definition,
  );
  return renderAt(
    <Editor
      workflow={workflow}
      revision={{ ...revision, problems }}
      onReload={() => {}}
    />,
  );
}
