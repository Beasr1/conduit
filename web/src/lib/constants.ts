import { useQuery } from "@tanstack/react-query";

import type { components } from "@/gen/schema";
import { api, call } from "@/lib/api";
import { constantKeys } from "@/lib/query-keys";

// The constants (plan 06), which two features read: the constants page
// lists and changes them, and the editor offers each to an expression as
// $const.name.

export type Constant = components["schemas"]["Constant"];

// useConstants is the constants in use, or those archived, by name, a secret
// one without its value.
export function useConstants(archived = false) {
  return useQuery({
    queryKey: constantKeys.list(archived),
    queryFn: ({ signal }) =>
      call(
        (signal) =>
          api.GET("/v1/constants", {
            params: { query: archived ? { archived } : {} },
            signal,
          }),
        signal,
      ),
  });
}
