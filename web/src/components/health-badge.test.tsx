import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import { HealthBadge } from "@/components/health-badge";
import { renderAt } from "@/test/render";
import { server } from "@/test/server";

test("shows the server as up when /api/healthz answers", async () => {
  server.use(
    http.get("/api/healthz", () => HttpResponse.json({ status: "ok" })),
  );
  renderAt(<HealthBadge />);
  expect(await screen.findByText("server ok")).toBeTruthy();
});

test("shows the server as unreachable when /api/healthz fails", async () => {
  server.use(http.get("/api/healthz", () => HttpResponse.error()));
  renderAt(<HealthBadge />);
  expect(await screen.findByText("server unreachable")).toBeTruthy();
});
