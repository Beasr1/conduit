import { useQuery } from "@tanstack/react-query";

import { fetchHealth, healthKeys } from "@/lib/health";

export function HealthBadge() {
  const { data, isPending, isError } = useQuery({
    queryKey: healthKeys.all,
    queryFn: fetchHealth,
    refetchInterval: 10_000,
  });

  if (isPending) return <span className="badge">checking…</span>;
  if (isError)
    return <span className="badge badge-down">server unreachable</span>;
  return <span className="badge badge-up">server {data.status}</span>;
}
