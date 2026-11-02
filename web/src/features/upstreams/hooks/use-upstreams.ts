import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { versionKey } from "@/features/editor/upstreams";
import type { components } from "@/gen/schema";
import { api, call } from "@/lib/api";
import { upstreamKeys } from "@/lib/query-keys";

type Definition = components["schemas"]["Definition"];
type Upstream = components["schemas"]["Upstream"];
type Uses = components["schemas"]["Uses"];
export type UpstreamVersion = components["schemas"]["UpstreamVersion"];
export type CreateUpstream = components["schemas"]["CreateUpstream"];

// A version as an entity tag, the way the API sends them: "3".
const etag = (version: number) => `"${version}"`;

// useUpstreams pages through the library, newest first.
export function useUpstreams() {
  return useInfiniteQuery({
    queryKey: upstreamKeys.list(),
    queryFn: ({ pageParam, signal }) =>
      call(
        (signal) =>
          api.GET("/v1/upstreams", {
            params: { query: pageParam ? { before: pageParam } : {} },
            signal,
          }),
        signal,
      ),
    initialPageParam: "",
    getNextPageParam: (page) => page.next || undefined,
  });
}

// useUpstream is an upstream at its latest version.
export function useUpstream(id: string) {
  return useQuery({
    queryKey: upstreamKeys.detail(id),
    queryFn: ({ signal }) =>
      call(
        (signal) =>
          api.GET("/v1/upstreams/{id}", { params: { path: { id } }, signal }),
        signal,
      ),
  });
}

function versionQuery(uses: Uses) {
  return {
    queryKey: upstreamKeys.version(uses.upstream, uses.version),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      call(
        (signal) =>
          api.GET("/v1/upstreams/{id}/versions/{version}", {
            params: { path: { id: uses.upstream, version: uses.version } },
            signal,
          }),
        signal,
      ),
    staleTime: Infinity,
    // The step that uses it says what's wrong; a toast would only repeat it.
    meta: { quiet: true },
  };
}

// fetchVersion gets one version, from the cache when it's there.
export function fetchVersion(
  client: QueryClient,
  uses: Uses,
): Promise<UpstreamVersion> {
  return client.fetchQuery(versionQuery(uses));
}

// useVersionsOf fetches every version a definition's steps use, keyed by
// versionKey, and says whether any is still on its way. One that fails is
// left out: the step that uses it says so.
export function useVersionsOf(d: Definition | undefined): {
  versions: Record<string, Upstream>;
  pending: boolean;
} {
  const uses = (d?.nodes ?? []).flatMap((n) => (n.uses ? [n.uses] : []));
  return useQueries({
    queries: uses.map(versionQuery),
    combine: (results) => ({
      versions: Object.fromEntries(
        results.flatMap((r, k) =>
          r.data ? [[versionKey(uses[k]!), r.data.definition]] : [],
        ),
      ),
      pending: results.some((r) => r.isPending && r.fetchStatus !== "idle"),
    }),
  });
}

// useUpstreamUsers is the workflows whose latest revision uses an upstream.
export function useUpstreamUsers(id: string) {
  return useQuery({
    queryKey: upstreamKeys.users(id),
    queryFn: ({ signal }) =>
      call(
        (signal) =>
          api.GET("/v1/upstreams/{id}/users", {
            params: { path: { id } },
            signal,
          }),
        signal,
      ),
  });
}

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
      void queryClient.invalidateQueries({ queryKey: upstreamKeys.list() });
    },
  });
}

// useSaveUpstream saves the next version, on base, the latest, sent as
// If-Match, so nothing is saved over a version saved elsewhere.
export function useSaveUpstream() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      base,
      upstream,
    }: {
      id: string;
      base: number;
      upstream: Upstream;
    }) =>
      call((signal) =>
        api.PUT("/v1/upstreams/{id}", {
          params: { path: { id }, header: { "If-Match": etag(base) } },
          body: upstream,
          signal,
        }),
      ),
    meta: { quiet: true },
    onSuccess: (saved) => {
      const id = saved.upstream.id;
      queryClient.setQueryData(upstreamKeys.version(id, saved.version), saved);
      queryClient.setQueryData(upstreamKeys.detail(id), saved);
      void queryClient.invalidateQueries({ queryKey: upstreamKeys.list() });
    },
  });
}

// fetchLatest gets an upstream at its latest version.
export function fetchLatest(
  client: QueryClient,
  id: string,
): Promise<UpstreamVersion> {
  return client.fetchQuery({
    queryKey: upstreamKeys.detail(id),
    queryFn: ({ signal }) =>
      call(
        (signal) =>
          api.GET("/v1/upstreams/{id}", { params: { path: { id } }, signal }),
        signal,
      ),
  });
}
