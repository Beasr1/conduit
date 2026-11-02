// Query keys for what more than one feature reads or updates, one factory
// per resource.
export const workflowKeys = {
  all: ["workflows"] as const,
  list: () => [...workflowKeys.all, "list"] as const,
  detail: (id: string) => [...workflowKeys.all, "detail", id] as const,
};

// The upstream library (plan 07). A version never changes, so it's cached
// for good.
export const upstreamKeys = {
  all: ["upstreams"] as const,
  list: () => [...upstreamKeys.all, "list"] as const,
  detail: (id: string) => [...upstreamKeys.all, "detail", id] as const,
  version: (id: string, version: number) =>
    [...upstreamKeys.all, "version", id, version] as const,
  users: (id: string) => [...upstreamKeys.all, "users", id] as const,
};
