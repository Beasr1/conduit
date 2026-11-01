import { CSPProvider } from "@base-ui/react/csp-provider";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { z } from "zod";

import { Toaster } from "@/components/ui/toast";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter, sendToSignIn } from "@/router";
import "@/index.css";

// The page's CSP allows no eval and no inline styles (nginx's
// 10-security.conf). zod would probe for eval to speed its checks up, which
// the browser reports as a violation even though zod catches the refusal.
// Base UI would add inline <style> elements; index.css carries their rules
// instead.
z.config({ jitless: true });

const router = createAppRouter();
const queryClient = createQueryClient(() => sendToSignIn(router));

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <CSPProvider disableStyleElements>
      <QueryClientProvider client={queryClient}>
        <Toaster>
          <RouterProvider router={router} />
        </Toaster>
      </QueryClientProvider>
    </CSPProvider>
  </StrictMode>,
);
