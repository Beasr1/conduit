import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { components } from "@/gen/schema";
import { api, call } from "@/lib/api";
import { constantKeys } from "@/lib/query-keys";

type CreateConstant = components["schemas"]["CreateConstant"];
type SetConstant = components["schemas"]["SetConstant"];

// Each change answers the constant as it is now; the list is asked again,
// as every row may show it.

// useCreateConstant makes a constant.
export function useCreateConstant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateConstant) =>
      call((signal) => api.POST("/v1/constants", { body, signal })),
    // The form says what went wrong, on its fields.
    meta: { quiet: true },
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: constantKeys.list() }),
  });
}

// useSetConstant changes a constant's value, keeping the one before.
export function useSetConstant(name: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SetConstant) =>
      call((signal) =>
        api.PUT("/v1/constants/{name}", {
          params: { path: { name } },
          body,
          signal,
        }),
      ),
    meta: { quiet: true },
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: constantKeys.list() }),
  });
}

// useUndoConstant puts a constant's previous value back.
export function useUndoConstant(name: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      call((signal) =>
        api.POST("/v1/constants/{name}/undo", {
          params: { path: { name } },
          signal,
        }),
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: constantKeys.list() }),
  });
}

// useDeleteConstant deletes a constant, which the server refuses while a
// saved revision or an upstream version reads it (plan 06).
export function useDeleteConstant(name: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      call((signal) =>
        api.DELETE("/v1/constants/{name}", {
          params: { path: { name } },
          signal,
        }),
      ),
    // The dialog says why it couldn't.
    meta: { quiet: true },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: constantKeys.users(name) });
      void queryClient.invalidateQueries({ queryKey: constantKeys.list() });
    },
  });
}

// useConstantUsers is what reads a constant now: the workflows' latest
// revisions and the upstreams' latest versions.
export function useConstantUsers(name: string) {
  return useQuery({
    queryKey: constantKeys.users(name),
    queryFn: ({ signal }) =>
      call(
        (signal) =>
          api.GET("/v1/constants/{name}/users", {
            params: { path: { name } },
            signal,
          }),
        signal,
      ),
  });
}
