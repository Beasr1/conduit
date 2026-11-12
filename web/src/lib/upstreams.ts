import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

import type { components } from "@/gen/schema";
import { api, call } from "@/lib/api";
import { upstreamKeys } from "@/lib/query-keys";

// The library's queries two features use (plan 07): the library lists and
// makes upstreams, and the editor's steps pick and make them.

export type UpstreamVersion = components["schemas"]["UpstreamVersion"];
export type CreateUpstream = components["schemas"]["CreateUpstream"];

// useUpstreams pages through the library, what's in use or what's archived,
// newest first.
export function useUpstreams(archived = false) {
  return useInfiniteQuery({
    queryKey: upstreamKeys.list(archived),
    queryFn: ({ pageParam, signal }) =>
      call(
        (signal) =>
          api.GET("/v1/upstreams", {
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

// useCreateUpstream makes an upstream, at version 1.
export function useCreateUpstream() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateUpstream) =>
      call((signal) => api.POST("/v1/upstreams", { body, signal })),
    // The form shows what went wrong, on its fields.
    meta: { quiet: true },
    onSuccess: (made) => {
      queryClient.setQueryData(
        upstreamKeys.version(made.upstream.id, made.version),
        made,
      );
      void queryClient.invalidateQueries({ queryKey: upstreamKeys.lists() });
    },
  });
}
