import { getJSON } from "@/lib/api";

export interface Health {
  status: string;
}

export const healthKeys = {
  all: ["health"] as const,
};

export function fetchHealth({ signal }: { signal: AbortSignal }): Promise<Health> {
  return getJSON<Health>("/healthz", signal);
}
