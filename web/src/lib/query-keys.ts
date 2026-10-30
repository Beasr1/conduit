// Query keys for what more than one feature reads or updates, one factory
// per resource.
export const workflowKeys = {
  all: ["workflows"] as const,
  list: () => [...workflowKeys.all, "list"] as const,
  detail: (id: string) => [...workflowKeys.all, "detail", id] as const,
};
