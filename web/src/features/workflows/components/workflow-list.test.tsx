import { fireEvent, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import { WorkflowList } from "@/features/workflows/components/workflow-list";
import type { components } from "@/gen/schema";
import { Component as WorkflowsPage } from "@/routes/workflows";
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

// The Archived tab lists what's archived, asked for by name, with when it
// was (plan 15).
test("the archived ones are asked for, and say when", async () => {
  const asked: (string | null)[] = [];
  server.use(
    http.get("/api/v1/workflows", ({ request }) => {
      asked.push(new URL(request.url).searchParams.get("archived"));
      return HttpResponse.json<WorkflowList>({
        workflows: [
          {
            ...workflow("wf-1", "Retired"),
            archived_at: "2026-11-06T09:00:00Z",
          },
        ],
      });
    }),
  );
  renderAt(<WorkflowList archived />, { path: "/workflows" });
  expect(await screen.findByRole("link", { name: "Retired" })).toBeTruthy();
  expect(asked).toEqual(["true"]);
  expect(screen.getByRole("columnheader", { name: "Archived" })).toBeTruthy();
  expect(screen.queryByRole("columnheader", { name: "Created" })).toBeNull();
  // When it was archived, not when it was made.
  const when = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  expect(
    screen.getByText(when.format(new Date("2026-11-06T09:00:00Z"))),
  ).toBeTruthy();
});

test("says when nothing's archived", async () => {
  server.use(
    http.get("/api/v1/workflows", () =>
      HttpResponse.json<WorkflowList>({ workflows: [] }),
    ),
  );
  renderAt(<WorkflowList archived />, { path: "/workflows" });
  expect(await screen.findByText(/Nothing archived/)).toBeTruthy();
});

// The page has the two lists on tabs, what's archived asked for only when
// it's opened.
test("the page lists what's in use, with what's archived on a tab", async () => {
  const asked: (string | null)[] = [];
  server.use(
    http.get("/api/v1/workflows", ({ request }) => {
      const archived = new URL(request.url).searchParams.get("archived");
      asked.push(archived);
      return HttpResponse.json<WorkflowList>({
        workflows: [workflow("wf-1", archived ? "Retired" : "Live")],
      });
    }),
  );
  renderAt(<WorkflowsPage />, { path: "/workflows" });
  expect(await screen.findByRole("link", { name: "Live" })).toBeTruthy();
  expect(asked).toEqual([null]);
  fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
  // Not even for a moment does it show what's in use.
  expect(screen.queryByRole("link", { name: "Live" })).toBeNull();
  expect(await screen.findByRole("link", { name: "Retired" })).toBeTruthy();
  expect(asked).toEqual([null, "true"]);
});
