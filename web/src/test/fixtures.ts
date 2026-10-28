import type { components } from "@/gen/schema";

type Workflow = components["schemas"]["Workflow"];
type WorkflowRevision = components["schemas"]["WorkflowRevision"];

// workflow is a workflow as the API returns it.
export function workflow(id: string, name: string): Workflow {
  return {
    id,
    slug: name.toLowerCase().replaceAll(" ", "-"),
    name,
    latest_revision: 1,
    created_at: "2026-10-28T09:00:00Z",
  };
}

export function workflowRevision(id: string, name: string): WorkflowRevision {
  return {
    workflow: workflow(id, name),
    revision: {
      workflow_id: id,
      revision: 1,
      definition: { nodes: [] },
      problems: [],
      provenance: { actor: "token" },
      created_at: "2026-10-28T09:00:00Z",
    },
  };
}
