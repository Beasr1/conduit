import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { fetchHealth, healthKeys } from "@/lib/health";

export function HealthBadge() {
  const { data, isPending, isError } = useQuery({
    queryKey: healthKeys.all,
    queryFn: fetchHealth,
    refetchInterval: 10_000,
    // The badge is the message; a toast every 10 s would be noise.
    meta: { quiet: true },
  });

  if (isPending) return <Badge variant="outline">checking…</Badge>;
  if (isError) return <Badge variant="destructive">server unreachable</Badge>;
  return <Badge variant="secondary">server {data.status}</Badge>;
}
