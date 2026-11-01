import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { outputOf } from "@/features/editor/flow";
import { PAUSE_MS, useStill } from "@/features/editor/hooks/use-still";
import { useEditor } from "@/features/editor/store";
import type { components } from "@/gen/schema";
import { api, call } from "@/lib/api";

type Definition = components["schemas"]["Definition"];
type PreviewRequest = components["schemas"]["PreviewRequest"];

export const previewKeys = {
  all: ["preview"] as const,
  of: (draft: Definition, target: string) =>
    [...previewKeys.all, target, draft] as const,
};

// A way into a step: the step it comes from, and the output it leaves.
export interface WayFrom {
  from: string;
  on: number | undefined;
}

// usePreview asks the server what a step would read and do, or whether a
// run would take a connection, each by its place in the draft, or what the
// workflow's output would be with neither, simulated over the samples, once
// the draft has stood still for a moment. A step goes by its id in the draft
// previewed, so a rename can't ask for an id that draft lacks, and in a run
// that comes by way, when there's one, found there by its ends. The last
// preview stays while the next is on its way.
export function usePreview(
  of?: { step: number; way?: WayFrom } | { edge: number },
) {
  const draft = useEditor((s) => s.draft);
  const still = useStill(draft, PAUSE_MS);
  let target: Omit<PreviewRequest, "definition"> | undefined = {};
  if (of && "step" in of) {
    const node = still.nodes[of.step]?.id;
    const by = of.way;
    const way = by
      ? (still.edges ?? []).findIndex(
          (e) => e.to === node && e.from === by.from && outputOf(e) === by.on,
        )
      : -1;
    // A step with no id can't be named, so it can't be previewed.
    target = node ? { node, ...(way >= 0 ? { way } : {}) } : undefined;
  } else if (of) {
    target =
      of.edge < (still.edges?.length ?? 0) ? { edge: of.edge } : undefined;
  }
  return useQuery({
    queryKey: previewKeys.of(
      still,
      target?.node === undefined
        ? target?.edge === undefined
          ? ""
          : `#${target.edge}`
        : target.way === undefined
          ? target.node
          : `${target.node}@${target.way}`,
    ),
    queryFn: async ({ signal }) => ({
      of: still,
      preview: await call(
        (signal) =>
          api.POST("/v1/preview", {
            body: { definition: still, ...target },
            signal,
          }),
        signal,
      ),
    }),
    enabled: target !== undefined,
    placeholderData: keepPreviousData,
    // A preview of one draft never changes.
    staleTime: Infinity,
    // The preview says when it fails; a toast every pause would nag.
    meta: { quiet: true },
  });
}
