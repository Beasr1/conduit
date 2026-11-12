import { useMutation, useQueryClient } from "@tanstack/react-query";

import { callerKeys } from "@/features/editor/hooks/use-keys";
import { strip } from "@/features/editor/upstreams";
import type { components } from "@/gen/schema";
import { api, ApiError, call } from "@/lib/api";
import { workflowKeys } from "@/lib/query-keys";

type Definition = components["schemas"]["Definition"];
type WorkflowRevision = components["schemas"]["WorkflowRevision"];

// A revision as an entity tag, the way the API sends them: "3".
const etag = (revision: number) => `"${revision}"`;

// useSaveDraft saves a draft as the workflow's next revision. It builds on
// base, sent as If-Match, so nothing is saved over a revision saved
// elsewhere: the server refuses it with 412, and the workflow is fetched
// again to learn which revision is newest.
export function useSaveDraft(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ draft, base }: { draft: Definition; base: number }) =>
      call((signal) =>
        api.PUT("/v1/workflows/{id}/draft", {
          params: { path: { id }, header: { "If-Match": etag(base) } },
          // What fill gave a step that uses an upstream is its version's.
          body: strip(draft),
          signal,
        }),
      ),
    // The editor says what went wrong: a newer revision in a dialog, the
    // rest beside the buttons.
    meta: { quiet: true },
    onSuccess: (revision) => {
      queryClient.setQueryData<WorkflowRevision>(
        workflowKeys.detail(id),
        (old) =>
          old && {
            workflow: { ...old.workflow, latest_revision: revision.revision },
            revision,
          },
      );
      void queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 412)
        void queryClient.invalidateQueries({
          queryKey: workflowKeys.detail(id),
        });
    },
  });
}

// usePublish makes a revision the one the workflow serves.
export function usePublish(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (revision: number) =>
      call((signal) =>
        api.POST("/v1/workflows/{id}/publish", {
          params: { path: { id } },
          body: { revision },
          signal,
        }),
      ),
    // Problems open the problems list; the rest show beside the buttons.
    meta: { quiet: true },
    onSuccess: (workflow) => {
      queryClient.setQueryData<WorkflowRevision>(
        workflowKeys.detail(id),
        (old) => old && { ...old, workflow },
      );
      void queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
    },
  });
}

// useSetArchived is archiving a workflow or restoring it (plan 15), as the
// answer is the workflow as it now stands. The editor stays open on it.
function useSetArchived(
  id: string,
  path: "/v1/workflows/{id}/archive" | "/v1/workflows/{id}/restore",
  quiet: boolean,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      call((signal) => api.POST(path, { params: { path: { id } }, signal })),
    meta: { quiet },
    onSuccess: (workflow) => {
      queryClient.setQueryData<WorkflowRevision>(
        workflowKeys.detail(id),
        (old) => old && { ...old, workflow },
      );
      void queryClient.invalidateQueries({ queryKey: workflowKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: callerKeys.list(id) });
    },
  });
}

// useArchiveWorkflow takes a workflow out of use, which the server refuses
// while something live uses it: the dialog says what.
export function useArchiveWorkflow(id: string) {
  return useSetArchived(id, "/v1/workflows/{id}/archive", true);
}

// useRestoreWorkflow brings an archived workflow back, without keys.
export function useRestoreWorkflow(id: string) {
  return useSetArchived(id, "/v1/workflows/{id}/restore", false);
}
