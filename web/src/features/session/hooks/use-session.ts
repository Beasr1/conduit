import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import { api, call } from "@/lib/api";
import { routes } from "@/router";

// useSignOut ends the session, on the server too, then drops everything it
// fetched. Signing in is SignInForm's (components/sign-in-form.tsx). A sign-out
// that fails leaves the session live, so the app stays, and the toast says
// why.
export function useSignOut() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => call((signal) => api.DELETE("/v1/session", { signal })),
    onSuccess: () => {
      queryClient.clear();
      void navigate(routes.signIn(), { replace: true });
    },
  });
}
