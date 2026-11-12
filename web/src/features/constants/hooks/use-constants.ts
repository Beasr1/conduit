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
      void queryClient.invalidateQueries({ queryKey: constantKeys.lists() }),
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
      void queryClient.invalidateQueries({ queryKey: constantKeys.lists() }),
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
      void queryClient.invalidateQueries({ queryKey: constantKeys.lists() }),
  });
}

// useArchiveConstant takes a constant out of use, which the server refuses
// while something live reads it: the dialog says what (plan 15).
export function useArchiveConstant(name: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      call((signal) =>
        api.POST("/v1/constants/{name}/archive", {
          params: { path: { name } },
          signal,
        }),
      ),
    meta: { quiet: true },
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: constantKeys.lists() }),
  });
}

// useRestoreConstant brings an archived constant back.
export function useRestoreConstant(name: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      call((signal) =>
        api.POST("/v1/constants/{name}/restore", {
          params: { path: { name } },
          signal,
        }),
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: constantKeys.lists() }),
  });
}

// useConstantUsers is what reads a constant now, what archiving it is
// refused for (plan 15): the latest and published revisions of workflows,
// directly or through what they pin, and upstreams' latest versions.
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
