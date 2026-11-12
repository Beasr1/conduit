import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import type { components } from "@/gen/schema";
import { api, call } from "@/lib/api";
import { workflowKeys } from "@/lib/query-keys";

// The workflow queries two features use: the list, a workflow's page, and
// the editor's steps that use a workflow (plan 07).

export type Workflow = components["schemas"]["Workflow"];

// useWorkflows pages through those in use, or those archived, newest first,
// a page at a time.
export function useWorkflows(archived = false) {
  return useInfiniteQuery({
    queryKey: workflowKeys.list(archived),
    queryFn: ({ pageParam, signal }) =>
      call(
        (signal) =>
          api.GET("/v1/workflows", {
            params: {
              query: {
                ...(pageParam ? { before: pageParam } : {}),
                ...(archived ? { archived } : {}),
              },
            },
            signal,
          }),
        signal,
      ),
    initialPageParam: "",
    getNextPageParam: (page) => page.next || undefined,
  });
}

// workflowQuery is one workflow with its latest revision: the workflow's
// page opens it, and a step that uses it reads its name and the revision
// it serves.
export function workflowQuery(id: string) {
  return {
    queryKey: workflowKeys.detail(id),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      call(
        (signal) =>
          api.GET("/v1/workflows/{id}", { params: { path: { id } }, signal }),
        signal,
      ),
  };
}

// useWorkflow is one workflow with its latest revision.
export function useWorkflow(id: string) {
  return useQuery(workflowQuery(id));
}
