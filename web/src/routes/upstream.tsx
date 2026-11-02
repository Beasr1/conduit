import { useParams } from "react-router";

import { UpstreamPage } from "@/features/upstreams/components/upstream-page";
import { useUpstream } from "@/features/upstreams/hooks/use-upstreams";

// An upstream's page, opened on its latest version (plan 07).
export function Component() {
  const { id = "" } = useParams();
  const { data, isPending } = useUpstream(id);
  if (isPending)
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!data)
    return <p className="text-sm text-destructive">Couldn&apos;t load it.</p>;
  // A new version opens afresh, as what was edited is now saved.
  return <UpstreamPage key={`${id}@${data.version}`} version={data} />;
}
