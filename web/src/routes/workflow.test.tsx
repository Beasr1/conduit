import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import type { components } from "@/gen/schema";
import { Component as WorkflowPage } from "@/routes/workflow";
import { specExample, workflowRevision } from "@/test/fixtures";
import { shimReactFlow } from "@/test/react-flow";
import { renderAt } from "@/test/render";
import { server } from "@/test/server";

type WorkflowRevision = components["schemas"]["WorkflowRevision"];

shimReactFlow();

test("opens a workflow on its canvas, every node and edge drawn", async () => {
  server.use(
    http.get("/api/v1/workflows/wf-1", () =>
      HttpResponse.json<WorkflowRevision>(
        workflowRevision("wf-1", "Send to CRM", specExample),
      ),
    ),
  );
  renderAt(<WorkflowPage />, {
    path: "/workflows/:id",
    at: "/workflows/wf-1",
  });

  expect(
    await screen.findByRole("heading", { name: "Send to CRM" }),
  ).toBeTruthy();
  for (const id of ["user", "orders", "prefs", "crm"])
    expect(await screen.findByText(id)).toBeTruthy();
  expect(
    screen.getByText("POST https://crm.example.com/v1/contacts"),
  ).toBeTruthy();
  // Edges are drawn once React Flow has measured the nodes.
  await waitFor(() =>
    expect(document.querySelectorAll(".react-flow__edge")).toHaveLength(4),
  );
});
