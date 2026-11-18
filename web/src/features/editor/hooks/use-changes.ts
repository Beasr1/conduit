import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, call } from "@/lib/api";
import { workflowKeys } from "@/lib/query-keys";

// A workflow's changes list (plan 16). Only the editor reads it; the factory
// moves to lib/query-keys.ts once another feature does.
export const changeKeys = {
  all: ["changes"] as const,
  of: (workflow: string) => [...changeKeys.all, workflow] as const,
  list: (workflow: string, history: boolean) =>
    [...changeKeys.of(workflow), history] as const,
};

// useChanges is a workflow's latest changes, newest first: its active ones,
// or with history, the rest.
export function useChanges(workflow: string, history: boolean) {
  return useQuery({
    queryKey: changeKeys.list(workflow, history),
    queryFn: ({ signal }) =>
      call(
        (s) =>
          api.GET("/v1/workflows/{id}/changes", {
            params: {
              path: { id: workflow },
              query: history ? { history } : {},
            },
            signal: s,
          }),
        signal,
      ),
  });
}

// useDismiss moves an active change to the workflow's history. Both lists
// are asked again, and the workflow, whose count it changes.
export function useDismiss(workflow: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (change: string) =>
      call((signal) =>
        api.POST("/v1/workflows/{id}/changes/{change}/dismiss", {
          params: { path: { id: workflow, change } },
          signal,
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: changeKeys.of(workflow) });
      void queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
    },
  });
}
