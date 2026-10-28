import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

import { toast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";

declare module "@tanstack/react-query" {
  interface Register {
    // quiet: the caller shows this error itself, such as a form putting a
    // problem on its fields, so there's no toast as well.
    queryMeta: { quiet?: boolean };
    mutationMeta: { quiet?: boolean };
  }
}

// createQueryClient handles every failed request in one place: a 401 calls
// onUnauthorized, anything else shows a toast unless the request is quiet.
export function createQueryClient(onUnauthorized: () => void): QueryClient {
  const failed = (err: unknown, quiet: boolean | undefined) => {
    if (err instanceof ApiError && err.kind === "unauthorized") {
      onUnauthorized();
      return;
    }
    if (quiet) return;
    const message =
      err instanceof Error ? err.message : "Something went wrong.";
    // One toast per message: the same failure twice updates it in place.
    toast.add({
      id: message,
      title: "Request failed",
      description: message,
      type: "error",
    });
  };
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (err, query) => failed(err, query.meta?.quiet),
    }),
    mutationCache: new MutationCache({
      onError: (err, _vars, _context, mutation) =>
        failed(err, mutation.meta?.quiet),
    }),
    defaultOptions: {
      queries: {
        // A retry can fix a dropped connection or a busy server, never a
        // request the server refused.
        retry: (failures, err) =>
          failures < 2 &&
          err instanceof ApiError &&
          ["offline", "timeout", "server"].includes(err.kind),
      },
    },
  });
}
