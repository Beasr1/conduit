import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";

import { stepRunOf, type StepRun } from "@/features/editor/runs";
import { useEditor } from "@/features/editor/store";
import type { components } from "@/gen/schema";
import { api, call } from "@/lib/api";
import { followRun } from "@/lib/events";

type NodeEvent = components["schemas"]["NodeEvent"];
type Run = components["schemas"]["Run"];

// The runs' query keys. Only the editor reads runs yet; the factory moves to
// lib/query-keys.ts once another feature does.
export const runKeys = {
  all: ["runs"] as const,
  list: (workflow: string) => [...runKeys.all, "list", workflow] as const,
  detail: (id: string) => [...runKeys.all, "detail", id] as const,
  // Each step's last event in a run, as its stream told it.
  live: (id: string) => [...runKeys.all, "live", id] as const,
  stream: (id: string) => [...runKeys.all, "stream", id] as const,
};

type Live = Record<string, NodeEvent>;

// useStartRun runs one of a workflow's revisions with an input. The run it
// answers with is the server's: going, and with no step done yet.
export function useStartRun(workflow: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ revision, input }: { revision: number; input: unknown }) =>
      call((signal) =>
        api.POST("/v1/workflows/{id}/runs", {
          params: { path: { id: workflow } },
          body: { revision, input },
          signal,
        }),
      ),
    // The dialog says what went wrong, under the input.
    meta: { quiet: true },
    onSuccess: (run) => {
      queryClient.setQueryData(runKeys.detail(run.id), run);
      void queryClient.invalidateQueries({ queryKey: runKeys.list(workflow) });
    },
  });
}

// useRun is a run as the server last told it, with what each step did. It
// doesn't change once it has ended, and one still going is fetched again
// when its stream ends, so it's never stale before then.
export function useRun<T = Run>(
  id: string | undefined,
  select?: (run: Run) => T,
) {
  return useQuery({
    queryKey: runKeys.detail(id ?? ""),
    queryFn: id
      ? ({ signal }) =>
          call(
            (s) =>
              api.GET("/v1/runs/{id}", { params: { path: { id } }, signal: s }),
            signal,
          )
      : skipToken,
    select,
    staleTime: Infinity,
  });
}

// useFollowRun follows a run while it goes on, keeping each step's last
// event, and fetches the run again once it has ended. Following stops when
// nothing shows the run any more.
export function useFollowRun(id: string | undefined, going: boolean) {
  const queryClient = useQueryClient();
  useQuery({
    queryKey: runKeys.stream(id ?? ""),
    queryFn:
      id && going
        ? async ({ signal }) => {
            const ended = await followRun(
              id,
              (e) =>
                queryClient.setQueryData<Live>(runKeys.live(id), (old) => ({
                  ...old,
                  [e.node]: e,
                })),
              signal,
            );
            await queryClient.invalidateQueries({
              queryKey: runKeys.detail(id),
            });
            return ended ?? null;
          }
        : skipToken,
    // followRun reconnects by itself, and a stream is never stale: it ends.
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

// useRuns is a workflow's latest runs, newest first: the editor's and its
// callers' alike.
export function useRuns(workflow: string) {
  return useQuery({
    queryKey: runKeys.list(workflow),
    queryFn: ({ signal }) =>
      call(
        (s) =>
          api.GET("/v1/runs", {
            params: { query: { workflow_id: workflow, limit: 50 } },
            signal: s,
          }),
        signal,
      ),
  });
}

// useStepRun is how one step went in the run shown, if one is: the step's
// part of the run, and its last event, so a step redraws only when its own
// part changes.
export function useStepRun(step: string): StepRun | undefined {
  const id = useEditor((s) => s.run);
  const recorded = useRun(id, (run) => ({
    status: run.status,
    node: run.nodes?.find((n) => n.node === step),
  })).data;
  const last = useQuery<Live, Error, NodeEvent | undefined>({
    queryKey: runKeys.live(id ?? ""),
    queryFn: skipToken,
    select: (live) => live[step],
  }).data;
  if (!id || !recorded) return undefined;
  return stepRunOf(recorded.node, last, recorded.status);
}

// useRunSteps tells how any step went in the run shown, for what reads more
// than one step, as the canvas's lines do. It's the same function until the
// run or its events change, so what it's a dependency of isn't redrawn on
// every frame of a drag.
export function useRunSteps(): ((step: string) => StepRun) | undefined {
  const id = useEditor((s) => s.run);
  const run = useRun(id).data;
  const live = useQuery<Live>({
    queryKey: runKeys.live(id ?? ""),
    queryFn: skipToken,
  }).data;
  return useMemo(
    () =>
      id && run
        ? (step: string) =>
            stepRunOf(
              run.nodes?.find((n) => n.node === step),
              live?.[step],
              run.status,
            )
        : undefined,
    [id, run, live],
  );
}
