import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import type { Check } from "@/features/editor/problems";
import type { components } from "@/gen/schema";
import { api, call } from "@/lib/api";

type Definition = components["schemas"]["Definition"];

// How long the draft stands still before it's checked: one check a pause,
// not one a key.
const PAUSE_MS = 500;

export const checkKeys = {
  all: ["check"] as const,
  of: (draft: Definition) => [...checkKeys.all, draft] as const,
};

// useCheck asks the server what's wrong with the draft once it has stood
// still for a moment, as saving it would find (plan 04, answer 6). The last
// check that came back stands until a newer one does, starting with the
// revision the editor opened.
export function useCheck(draft: Definition, opened: Check) {
  const [still, setStill] = useState(draft);
  useEffect(() => {
    const wait = setTimeout(() => setStill(draft), PAUSE_MS);
    return () => clearTimeout(wait);
  }, [draft]);
  const query = useQuery({
    queryKey: checkKeys.of(still),
    queryFn: ({ signal }) => check(still, signal),
    initialData: still === opened.of ? opened : undefined,
    // What's wrong with a draft never changes.
    staleTime: Infinity,
    // The editor says when checking fails; a toast every pause would nag.
    meta: { quiet: true },
  });
  const [last, setLast] = useState(opened);
  if (query.data !== undefined && query.data !== last) setLast(query.data);
  return {
    check: last,
    checking: still !== draft || query.isFetching,
    failed: query.isError,
  };
}

async function check(draft: Definition, signal: AbortSignal): Promise<Check> {
  const { problems } = await call(
    (signal) => api.POST("/v1/validate", { body: draft, signal }),
    signal,
  );
  return { of: draft, problems };
}
