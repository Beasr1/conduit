import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";

import { Toaster } from "@/components/ui/toast";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter, routes } from "@/router";
import "@/index.css";

const router = createAppRouter();
// A 401 means the session ran out, or there never was one: sign in, then
// carry on where you were.
const queryClient = createQueryClient(() => {
  const { pathname, search } = router.state.location;
  if (pathname !== routes.signIn())
    void router.navigate(routes.signIn(pathname + search));
});

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Toaster>
        <RouterProvider router={router} />
      </Toaster>
    </QueryClientProvider>
  </StrictMode>,
);
