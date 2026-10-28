import type { components } from "@/gen/schema";
import { api, call } from "@/lib/api";

export type Health = components["schemas"]["Health"];

export const healthKeys = {
  all: ["health"] as const,
};

export function fetchHealth({
  signal,
}: {
  signal: AbortSignal;
}): Promise<Health> {
  return call((signal) => api.GET("/healthz", { signal }), signal);
}
