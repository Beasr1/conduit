import { fireEvent, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import { CreateWorkflowDialog } from "@/features/workflows/components/create-workflow-dialog";
import type { components } from "@/gen/schema";
import { workflowRevision } from "@/test/fixtures";
import { renderAt } from "@/test/render";
import { server } from "@/test/server";

type Problem = components["schemas"]["Problem"];

async function create(name: string, slug: string) {
  fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
  fireEvent.change(await screen.findByLabelText("Name"), {
    target: { value: name },
  });
  fireEvent.change(screen.getByLabelText("Slug"), { target: { value: slug } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
}

function problem(status: number, body: Problem) {
  return HttpResponse.json(body, {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

test("creates an empty workflow and opens it", async () => {
  let sent: unknown;
  server.use(
    http.post("/api/v1/workflows", async ({ request }) => {
      sent = await request.json();
      return HttpResponse.json(workflowRevision("wf-1", "Send to CRM"), {
        status: 201,
      });
    }),
  );
  const { router } = renderAt(<CreateWorkflowDialog />, {
    path: "/workflows",
    routes: ["/workflows/:id"],
  });

  await create("Send to CRM", "send-to-crm");
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/workflows/wf-1"),
  );
  expect(sent).toEqual({
    name: "Send to CRM",
    slug: "send-to-crm",
    definition: { nodes: [] },
  });
});

test("puts a taken slug on the slug field", async () => {
  server.use(
    http.post("/api/v1/workflows", () =>
      problem(409, {
        status: 409,
        code: "conflict",
        detail: "That slug is taken.",
      }),
    ),
  );
  renderAt(<CreateWorkflowDialog />, { path: "/workflows" });

  await create("Send to CRM", "send-to-crm");
  expect(await screen.findByText("That slug is taken.")).toBeTruthy();
  expect(screen.getByLabelText("Slug").getAttribute("aria-invalid")).toBe(
    "true",
  );
});

test("puts the server's problems on their fields", async () => {
  server.use(
    http.post("/api/v1/workflows", () =>
      problem(422, {
        status: 422,
        code: "invalid_request",
        detail: "The request has problems; nothing was saved.",
        errors: [
          {
            pointer: "/name",
            code: "invalid_name",
            detail: "the server says no",
          },
        ],
      }),
    ),
  );
  renderAt(<CreateWorkflowDialog />, { path: "/workflows" });

  await create("Send to CRM", "send-to-crm");
  expect(await screen.findByText("the server says no")).toBeTruthy();
  expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBe(
    "true",
  );
});

// No handler: a request would fail the test, so this proves none was sent.
test("checks the slug before sending", async () => {
  renderAt(<CreateWorkflowDialog />, { path: "/workflows" });

  await create("Send to CRM", "Not A Slug");
  expect(
    await screen.findByText(/lowercase letters, digits and hyphens/),
  ).toBeTruthy();
});
