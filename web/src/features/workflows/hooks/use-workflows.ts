import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { components } from "@/gen/schema";
import { api, call } from "@/lib/api";
import { workflowKeys } from "@/lib/query-keys";

export type CreateWorkflow = components["schemas"]["CreateWorkflow"];

export function useCreateWorkflow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWorkflow) =>
      call((signal) => api.POST("/v1/workflows", { body, signal })),
    // The form shows what went wrong, on its fields.
    meta: { quiet: true },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: workflowKeys.lists() }),
  });
}
