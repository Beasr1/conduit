import type { components } from "@/gen/schema";
import { getJSON } from "@/lib/api";

export type Health = components["schemas"]["Health"];

export const healthKeys = {
  all: ["health"] as const,
};

export function fetchHealth({
  signal,
}: {
  signal: AbortSignal;
}): Promise<Health> {
  return getJSON<Health>("/healthz", signal);
}
