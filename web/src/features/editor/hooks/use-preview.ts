import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { PAUSE_MS, useStill } from "@/features/editor/hooks/use-still";
import { useEditor } from "@/features/editor/store";
import { strip, upstreamOf } from "@/features/editor/upstreams";
import type { components } from "@/gen/schema";
import { api, call } from "@/lib/api";

type Definition = components["schemas"]["Definition"];
type PreviewRequest = components["schemas"]["PreviewRequest"];

export const previewKeys = {
  all: ["preview"] as const,
  of: (draft: Definition, target: string) =>
    [...previewKeys.all, target, draft] as const,
};

// usePreview asks the server what a step would read and do, or whether a
// run would take a connection, each by its place in the draft, or what the
// workflow's output would be with neither, simulated over the samples, once
// the draft has stood still for a moment. A step goes by its id in the draft
// previewed, so a rename can't ask for an id that draft lacks. The last
// preview stays while the next is on its way.
export function usePreview(of?: { step: number } | { edge: number }) {
  const draft = useEditor((s) => s.draft);
  const editing = useEditor((s) => s.upstreamEdit);
  const still = useStill(draft, PAUSE_MS);
  // An upstream being edited in place goes with the draft, so the preview
  // shows what the edit would do (plan 07).
  const node = editing && still.nodes.find((n) => n.id === editing.node);
  const upstreams = node
    ? { [node.id]: upstreamOf(node, editing.parameters) }
    : undefined;
  let target: Omit<PreviewRequest, "definition"> | undefined = {};
  if (of && "step" in of) {
    const node = still.nodes[of.step]?.id;
    // A step with no id can't be named, so it can't be previewed.
    target = node ? { node } : undefined;
  } else if (of) {
    target =
      of.edge < (still.edges?.length ?? 0) ? { edge: of.edge } : undefined;
  }
  return useQuery({
    queryKey: [
      ...previewKeys.of(
        still,
        target?.node ?? (target?.edge === undefined ? "" : `#${target.edge}`),
      ),
      editing?.parameters,
    ],
    queryFn: async ({ signal }) => ({
      of: still,
      preview: await call(
        (signal) =>
          api.POST("/v1/preview", {
            body: { definition: strip(still), upstreams, ...target },
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
