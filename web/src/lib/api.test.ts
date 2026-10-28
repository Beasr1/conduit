import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import { api, ApiError, call } from "@/lib/api";
import { server } from "@/test/server";

const list = () => call((signal) => api.GET("/v1/workflows", { signal }));

test("returns a 2xx answer's data", async () => {
  server.use(
    http.get("/api/v1/workflows", () => HttpResponse.json({ workflows: [] })),
  );
  await expect(list()).resolves.toEqual({ workflows: [] });
});

test.each([
  [401, "unauthorized"],
  [404, "client"],
  [422, "client"],
  [500, "server"],
  [503, "server"],
] as const)("a %i is a %s error, with the problem", async (status, kind) => {
  server.use(
    http.get("/api/v1/workflows", () =>
      HttpResponse.json(
        { status, code: "said_so", detail: "Said the server." },
        { status, headers: { "Content-Type": "application/problem+json" } },
      ),
    ),
  );
  const err = await list().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({
    kind,
    status,
    message: "Said the server.",
    problem: { code: "said_so" },
  });
});

test("a connection that fails is offline", async () => {
  server.use(http.get("/api/v1/workflows", () => HttpResponse.error()));
  await expect(list()).rejects.toMatchObject({ kind: "offline" });
});

test("a cancel by the caller isn't turned into an API error", async () => {
  server.use(
    http.get("/api/v1/workflows", () => HttpResponse.json({ workflows: [] })),
  );
  const cancelled = AbortSignal.abort();
  const err = await call(
    (signal) => api.GET("/v1/workflows", { signal }),
    cancelled,
  ).catch((e: unknown) => e);
  expect(err).not.toBeInstanceOf(ApiError);
});
