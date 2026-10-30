import { http, HttpResponse } from "msw";

import { Editor } from "@/features/editor/components/editor";
import type { components } from "@/gen/schema";
import { workflowRevision } from "@/test/fixtures";
import { renderAt } from "@/test/render";
import { server } from "@/test/server";

type Definition = components["schemas"]["Definition"];
type ProblemError = components["schemas"]["ProblemError"];
type Validation = components["schemas"]["Validation"];

// renderEditor opens the editor on definition, as revision 1 of an
// unpublished workflow, the way the workflow's page does, with the problems
// the server found in it. The server finds nothing wrong with any other
// draft, unless a test says otherwise.
export function renderEditor(
  definition: Definition,
  problems: ProblemError[] = [],
) {
  server.use(
    http.post("/api/v1/validate", () =>
      HttpResponse.json<Validation>({ problems: [] }),
    ),
  );
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
