import { fireEvent, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import { WorkflowList } from "@/features/workflows/components/workflow-list";
import type { components } from "@/gen/schema";
import { workflow } from "@/test/fixtures";
import { renderAt } from "@/test/render";
import { server } from "@/test/server";

type WorkflowList = components["schemas"]["WorkflowList"];

test("lists workflows, each linking to its page", async () => {
  server.use(
    http.get("/api/v1/workflows", () =>
      HttpResponse.json<WorkflowList>({
        workflows: [workflow("wf-1", "Send to CRM")],
      }),
    ),
  );
  renderAt(<WorkflowList />, { path: "/workflows" });

  const link = await screen.findByRole("link", { name: "Send to CRM" });
  expect(link.getAttribute("href")).toBe("/workflows/wf-1");
  expect(screen.getByText("send-to-crm")).toBeTruthy();
});

test("shows more while there's a next page", async () => {
  server.use(
    http.get("/api/v1/workflows", ({ request }) => {
      const before = new URL(request.url).searchParams.get("before");
      return HttpResponse.json<WorkflowList>(
        before === "wf-2"
          ? { workflows: [workflow("wf-1", "Older")] }
          : { workflows: [workflow("wf-2", "Newer")], next: "wf-2" },
      );
    }),
  );
  renderAt(<WorkflowList />, { path: "/workflows" });

  await screen.findByText("Newer");
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  await screen.findByText("Older");
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
});

test("says when there are none", async () => {
  server.use(
    http.get("/api/v1/workflows", () =>
      HttpResponse.json<WorkflowList>({ workflows: [] }),
    ),
  );
  renderAt(<WorkflowList />, { path: "/workflows" });
  expect(await screen.findByText(/No workflows yet/)).toBeTruthy();
});
