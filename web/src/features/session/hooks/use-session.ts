import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { api, call } from "@/lib/api";
import { routes } from "@/router";

// useSignIn trades the API token for the session cookie. The page keeps
// neither: the cookie is out of its reach.
export function useSignIn() {
  return useMutation({
    mutationFn: (token: string) =>
      call((signal) => api.POST("/v1/session", { body: { token }, signal })),
    // The form says what went wrong.
    meta: { quiet: true },
  });
}

// useSignOut clears the cookie, then everything this session fetched.
export function useSignOut() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => call((signal) => api.DELETE("/v1/session", { signal })),
    onSettled: () => {
      queryClient.clear();
      void navigate(routes.signIn(), { replace: true });
    },
  });
}
