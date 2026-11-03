import { http, HttpResponse } from "msw";

import { Editor } from "@/features/editor/components/editor";
import { type Called, fill } from "@/features/editor/upstreams";
import type { components } from "@/gen/schema";
import { workflowRevision } from "@/test/fixtures";
import { renderAt } from "@/test/render";
import { server } from "@/test/server";

type Definition = components["schemas"]["Definition"];
type Upstream = components["schemas"]["Upstream"];
type Preview = components["schemas"]["Preview"];
type ProblemError = components["schemas"]["ProblemError"];
type Validation = components["schemas"]["Validation"];
type UpstreamList = components["schemas"]["UpstreamList"];
type WorkflowList = components["schemas"]["WorkflowList"];

// answerEditor has the server answer what the editor asks as it's used:
// unless a test says otherwise, it finds nothing wrong with a draft, and a
// preview reads no data.
export function answerEditor() {
  server.use(
    http.post("/api/v1/validate", () =>
      HttpResponse.json<Validation>({ problems: [] }),
    ),
    // The library is empty unless a test says otherwise (plan 07).
    http.get("/api/v1/upstreams", () =>
      HttpResponse.json<UpstreamList>({ upstreams: [] }),
    ),
    // So are the workflows a step can use.
    http.get("/api/v1/workflows", () =>
      HttpResponse.json<WorkflowList>({ workflows: [] }),
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
// the server found in it, its steps that use upstreams filled from versions,
// and those that use workflows from called (plan 07).
export function renderEditor(
  definition: Definition,
  problems: ProblemError[] = [],
  versions: Record<string, Upstream> = {},
  called: Record<string, Called> = {},
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
      revision={{
        ...revision,
        definition: fill(revision.definition, versions, called),
        problems,
      }}
      versions={versions}
      called={called}
      onReload={() => {}}
    />,
  );
}
