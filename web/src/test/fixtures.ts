import type { components } from "@/gen/schema";

type Definition = components["schemas"]["Definition"];
type Workflow = components["schemas"]["Workflow"];
type WorkflowRevision = components["schemas"]["WorkflowRevision"];

// specExample is the roadmap's example: user, then orders and prefs side by
// side, then crm.
export const specExample: Definition = {
  nodes: [
    {
      id: "user",
      kind: "http",
      request: { method: "GET", url: "https://users.example.com/v1/users" },
    },
    {
      id: "orders",
      kind: "http",
      request: { method: "GET", url: "https://orders.example.com/v1/orders" },
    },
    {
      id: "prefs",
      kind: "http",
      request: { method: "GET", url: "https://prefs.example.com/v1/prefs" },
    },
    {
      id: "crm",
      kind: "http",
      request: { method: "POST", url: "https://crm.example.com/v1/contacts" },
    },
  ],
  edges: [
    { from: "user", to: "orders" },
    { from: "user", to: "prefs" },
    { from: "orders", to: "crm" },
    { from: "prefs", to: "crm" },
  ],
};

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

export function workflowRevision(
  id: string,
  name: string,
  definition: Definition = { nodes: [] },
): WorkflowRevision {
  return {
    workflow: workflow(id, name),
    revision: {
      workflow_id: id,
      revision: 1,
      definition,
      problems: [],
      provenance: { actor: "token" },
      created_at: "2026-10-28T09:00:00Z",
    },
  };
}
