import {
  type QueryClient,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { type Called, versionKey } from "@/features/editor/upstreams";
import type { components } from "@/gen/schema";
import { api, call } from "@/lib/api";
import { upstreamKeys, workflowKeys } from "@/lib/query-keys";
import type { UpstreamVersion } from "@/lib/upstreams";
import { workflowQuery } from "@/lib/workflows";

type Definition = components["schemas"]["Definition"];
type Upstream = components["schemas"]["Upstream"];
type Uses = components["schemas"]["Uses"];

// A version as an entity tag, the way the API sends them: "3".
const etag = (version: number) => `"${version}"`;

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
  const id = uses.upstream ?? "";
  const version = uses.version ?? 0;
  return {
    queryKey: upstreamKeys.version(id, version),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      call(
        (signal) =>
          api.GET("/v1/upstreams/{id}/versions/{version}", {
            params: { path: { id, version } },
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

// useVersion is one version of an upstream, as fetchVersion gets it.
export function useVersion(uses: Uses) {
  return useQuery(versionQuery(uses));
}

// revisionQuery is a revision of a workflow a step uses (plan 07), which
// never changes.
function revisionQuery(uses: Uses) {
  const id = uses.workflow ?? "";
  const revision = uses.revision ?? 0;
  return {
    queryKey: workflowKeys.revision(id, revision),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      call(
        (signal) =>
          api.GET("/v1/workflows/{id}/revisions/{revision}", {
            params: { path: { id, revision } },
            signal,
          }),
        signal,
      ),
    staleTime: Infinity,
    // The step that uses it says what's wrong; a toast would only repeat it.
    meta: { quiet: true },
  };
}

// used is a workflow a step uses (plan 07): the step says what's wrong
// with it, and a toast would only repeat it.
const used = (id: string) => ({ ...workflowQuery(id), meta: { quiet: true } });

// useUsedWorkflow is a workflow a step uses, as it is now.
export function useUsedWorkflow(id: string) {
  return useQuery(used(id));
}

// fetchCalled gets a revision of a workflow a step uses, with the
// workflow's name and the revision it serves.
export async function fetchCalled(
  client: QueryClient,
  uses: Uses,
): Promise<Called> {
  const [r, w] = await Promise.all([
    client.fetchQuery(revisionQuery(uses)),
    client.fetchQuery(used(uses.workflow ?? "")),
  ]);
  return {
    name: w.workflow.name,
    published: w.workflow.published_revision,
    definition: r.definition,
  };
}

// fetchServed gets the revision a workflow serves now, for a step that's to
// use it, with what fill needs.
export async function fetchServed(
  client: QueryClient,
  workflow: string,
): Promise<{ uses: Uses; called: Called }> {
  const w = await client.fetchQuery({ ...used(workflow), staleTime: 0 });
  const revision = w.workflow.published_revision;
  if (revision === undefined)
    throw new Error(`${w.workflow.name} serves no revision`);
  const uses = { workflow, revision };
  const r = await client.fetchQuery(revisionQuery(uses));
  return {
    uses,
    called: {
      name: w.workflow.name,
      published: revision,
      definition: r.definition,
    },
  };
}

// pendingOf says whether any of results is still on its way.
const pendingOf = (results: { isPending: boolean; fetchStatus: string }[]) =>
  results.some((r) => r.isPending && r.fetchStatus !== "idle");

// useVersionsOf fetches what a definition's steps use, keyed by
// versionKey: the upstream versions, and the workflow revisions, each with
// its workflow's name and the revision it serves (plan 07). It says
// whether any is still on its way. One that fails is left out: the step
// that uses it says so.
export function useVersionsOf(d: Definition | undefined): {
  versions: Record<string, Upstream>;
  called: Record<string, Called>;
  pending: boolean;
} {
  const uses = (d?.nodes ?? []).flatMap((n) => (n.uses ? [n.uses] : []));
  const upstreams = uses.filter((u) => u.workflow === undefined);
  const revisions = uses.filter((u) => u.workflow !== undefined);
  const ids = [...new Set(revisions.map((u) => u.workflow ?? ""))];
  const versions = useQueries({
    queries: upstreams.map(versionQuery),
    combine: (results) => ({
      got: Object.fromEntries(
        results.flatMap((r, k) =>
          r.data ? [[versionKey(upstreams[k]!), r.data.definition]] : [],
        ),
      ),
      pending: pendingOf(results),
    }),
  });
  const definitions = useQueries({
    queries: revisions.map(revisionQuery),
    combine: (results) => ({
      got: results.map((r) => r.data?.definition),
      pending: pendingOf(results),
    }),
  });
  const workflows = useQueries({
    queries: ids.map(used),
    combine: (results) => ({
      got: new Map(
        results.flatMap((r) =>
          r.data ? [[r.data.workflow.id, r.data.workflow] as const] : [],
        ),
      ),
      pending: pendingOf(results),
    }),
  });
  const called: Record<string, Called> = {};
  revisions.forEach((u, k) => {
    const definition = definitions.got[k];
    const w = workflows.got.get(u.workflow ?? "");
    if (definition && w)
      called[versionKey(u)] = {
        name: w.name,
        published: w.published_revision,
        definition,
      };
  });
  return {
    versions: versions.got,
    called,
    pending: versions.pending || definitions.pending || workflows.pending,
  };
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

// useDeleteUpstream deletes an upstream with every version, which the
// server refuses while a saved revision pins one (plan 07).
export function useDeleteUpstream() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      call((signal) =>
        api.DELETE("/v1/upstreams/{id}", {
          params: { path: { id } },
          signal,
        }),
      ),
    // The page says why it couldn't.
    meta: { quiet: true },
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: upstreamKeys.detail(id) });
      queryClient.removeQueries({ queryKey: upstreamKeys.users(id) });
      queryClient.removeQueries({
        queryKey: [...upstreamKeys.all, "version", id],
      });
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
