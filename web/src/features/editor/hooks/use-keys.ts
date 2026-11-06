import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { components } from "@/gen/schema";
import { api, call } from "@/lib/api";

type RotateKey = components["schemas"]["RotateKey"];

// The caller keys' query keys (plan 07). Only the editor reads keys; the
// factory moves to lib/query-keys.ts once another feature does.
export const callerKeys = {
  all: ["caller-keys"] as const,
  list: (workflow: string) => [...callerKeys.all, "list", workflow] as const,
};

// useKeys is every caller key the workflow has had, newest first.
export function useKeys(workflow: string) {
  return useQuery({
    queryKey: callerKeys.list(workflow),
    queryFn: ({ signal }) =>
      call(
        (s) =>
          api.GET("/v1/workflows/{id}/keys", {
            params: { path: { id: workflow } },
            signal: s,
          }),
        signal,
      ),
  });
}

// Each change answers with what it made or changed, the key's value too,
// the only time it's sent; the list is asked again.

// useCreateKey makes a key for a caller.
export function useCreateKey(workflow: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      call((signal) =>
        api.POST("/v1/workflows/{id}/keys", {
          params: { path: { id: workflow } },
          body: { name },
          signal,
        }),
      ),
    // The form says what went wrong, under the name.
    meta: { quiet: true },
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: callerKeys.list(workflow),
      }),
  });
}

// useRotateKey gives a key's caller a new key, and the old one an expiry.
export function useRotateKey(workflow: string, key: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (expires: RotateKey["old_expires_in"]) =>
      call((signal) =>
        api.POST("/v1/workflows/{id}/keys/{key}/rotate", {
          params: { path: { id: workflow, key } },
          body: { old_expires_in: expires },
          signal,
        }),
      ),
    // The dialog says what went wrong.
    meta: { quiet: true },
    // Refused too, as it was rotated or revoked elsewhere.
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: callerKeys.list(workflow),
      }),
  });
}

// useRevokeKey stops a key at once.
export function useRevokeKey(workflow: string, key: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      call((signal) =>
        api.POST("/v1/workflows/{id}/keys/{key}/revoke", {
          params: { path: { id: workflow, key } },
          signal,
        }),
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: callerKeys.list(workflow),
      }),
  });
}
