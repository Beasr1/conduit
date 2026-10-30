import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import type { components } from "@/gen/schema";
import { api, call } from "@/lib/api";
import { workflowKeys } from "@/lib/query-keys";

export type Workflow = components["schemas"]["Workflow"];
export type CreateWorkflow = components["schemas"]["CreateWorkflow"];

// useWorkflows pages through the list, newest first, a page at a time.
export function useWorkflows() {
  return useInfiniteQuery({
    queryKey: workflowKeys.list(),
    queryFn: ({ pageParam, signal }) =>
      call(
        (signal) =>
          api.GET("/v1/workflows", {
            params: { query: pageParam ? { before: pageParam } : {} },
            signal,
          }),
        signal,
      ),
    initialPageParam: "",
    getNextPageParam: (page) => page.next || undefined,
  });
}

// useWorkflow is one workflow with its latest revision.
export function useWorkflow(id: string) {
  return useQuery({
    queryKey: workflowKeys.detail(id),
    queryFn: ({ signal }) =>
      call(
        (signal) =>
          api.GET("/v1/workflows/{id}", { params: { path: { id } }, signal }),
        signal,
      ),
  });
}

export function useCreateWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWorkflow) =>
      call((signal) => api.POST("/v1/workflows", { body, signal })),
    // The form shows what went wrong, on its fields.
    meta: { quiet: true },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workflowKeys.list() }),
  });
}
