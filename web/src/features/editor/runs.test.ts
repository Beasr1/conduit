import { expect, test } from "vitest";

import { UNHANDLED } from "@/features/editor/flow";
import {
  runSaid,
  said,
  type StepRun,
  stepRunOf,
  takenOf,
  took,
  tookLine,
  wayOf,
} from "@/features/editor/runs";
import type { components } from "@/gen/schema";

type NodeEvent = components["schemas"]["NodeEvent"];
type NodeRun = components["schemas"]["NodeRun"];

const at = "2026-10-30T20:00:00.000Z";
const event = (e: Partial<NodeEvent>): NodeEvent => ({
  node: "user",
  kind: "started",
  attempt: 1,
  at,
  ...e,
});
const ended = (n: Partial<NodeRun>): NodeRun => ({
  node: "user",
  status: "succeeded",
  attempts: 1,
  started_at: at,
  ended_at: "2026-10-30T20:00:00.082Z",
  ...n,
});

test("what the server recorded wins over what the stream said", () => {
  expect(
    stepRunOf(
      ended({ response: { status: 404, body: null } }),
      event({ kind: "started" }),
      "succeeded",
    ),
  ).toEqual({ state: "succeeded", status: 404, attempts: 1, ms: 82 });
});

test("a step the server hasn't recorded goes by its last event", () => {
  expect(stepRunOf(undefined, event({ kind: "started" }), "running")).toEqual({
    state: "running",
    attempts: 1,
  });
  expect(
    stepRunOf(undefined, event({ kind: "retrying", attempt: 2 }), "running"),
  ).toEqual({ state: "retrying", attempts: 2 });
  expect(
    stepRunOf(
      undefined,
      event({ kind: "succeeded", http_status: 201 }),
      "running",
    ),
  ).toEqual({ state: "succeeded", status: 201, attempts: 1 });
});

test("a step says which lines its answer took, recorded or streamed", () => {
  const lines = [{ to: "fallback", on: 400 }, { to: "log" }];
  expect(
    stepRunOf(ended({ attempts: 0, took: lines }), undefined, "succeeded"),
  ).toEqual({ state: "succeeded", attempts: 0, ms: 82, took: lines });
  expect(
    stepRunOf(
      undefined,
      event({ kind: "succeeded", attempt: 0, took: lines }),
      "running",
    ),
  ).toEqual({ state: "succeeded", attempts: 0, took: lines });
});

test("a line into a step is taken when the step it leaves says its answer took it", () => {
  const prefs: StepRun = {
    state: "succeeded",
    status: 400,
    attempts: 1,
    took: [
      { to: "fallback", on: 400 },
      { to: "log", unhandled: true },
    ],
  };
  expect(tookLine(400, prefs, "fallback")).toBe(true);
  // The same steps, from another of prefs' outputs.
  expect(tookLine(undefined, prefs, "fallback")).toBe(false);
  expect(tookLine(400, prefs, "crm")).toBe(false);
  expect(tookLine(UNHANDLED, prefs, "log")).toBe(true);
  // Unknown until the step has ended; one that took none took none.
  expect(tookLine(400, { ...prefs, state: "running" }, "fallback")).toBe(
    undefined,
  );
  expect(tookLine(undefined, { state: "skipped" }, "fallback")).toBe(false);
});

test("a step with no event yet waits, and one a run ended without didn't run", () => {
  expect(stepRunOf(undefined, undefined, "running")).toEqual({
    state: "waiting",
  });
  expect(stepRunOf(undefined, undefined, "failed")).toEqual({
    state: "not run",
  });
});

test.each([
  [{ state: "succeeded", status: 201, attempts: 1, ms: 140 }, "201, 140 ms"],
  [{ state: "succeeded", attempts: 0, ms: 3 }, "done, 3 ms"],
  [
    {
      state: "failed",
      attempts: 3,
      error: { code: "timeout", detail: "x" },
    },
    "failed: timeout, after 3 attempts",
  ],
  [{ state: "failed", status: 502, attempts: 1 }, "failed: 502"],
  [{ state: "retrying", attempts: 2 }, "retrying, attempt 2"],
  [{ state: "running", attempts: 1 }, "running"],
  [{ state: "skipped" }, "skipped"],
  [{ state: "waiting" }, "waiting"],
  [{ state: "not run" }, "not run"],
] as const)("%j says %j", (run, words) => {
  expect(said(run)).toBe(words);
});

test("a line into an answer is taken when its step answered its way and the run answered with it", () => {
  const ok = { state: "succeeded", status: 200, attempts: 1 } as const;
  const gone = { state: "succeeded", status: 404, attempts: 1 } as const;
  const ran = { state: "succeeded", attempts: 1 } as const;
  const skipped = { state: "skipped" } as const;
  // On 2xx, which a line with no response leaves on.
  expect(takenOf(undefined, ok, ran)).toBe(true);
  expect(takenOf(undefined, gone, ran)).toBe(false);
  expect(takenOf(404, gone, ran)).toBe(true);
  expect(takenOf(404, ok, ran)).toBe(false);
  // The next step skipped: its condition didn't hold.
  expect(takenOf(undefined, ok, skipped)).toBe(false);
  // A transform answers with no status, on its one way out.
  expect(takenOf(undefined, ran, ran)).toBe(true);
  // Unknown until the step has ended, and the next has too.
  expect(takenOf(undefined, { state: "running", attempts: 1 }, ran)).toBe(
    undefined,
  );
  expect(takenOf(undefined, ok, { state: "waiting" })).toBe(undefined);
  // A failed step takes no line.
  expect(takenOf(undefined, { state: "failed", attempts: 1 }, skipped)).toBe(
    false,
  );
  // A transform with cases exits by the status of the case that held, a
  // 2xx one among them, not by 2xx.
  expect(takenOf(200, ok, ran, true)).toBe(true);
  expect(takenOf(201, ok, ran, true)).toBe(false);
  expect(takenOf(undefined, ok, ran, true)).toBe(false);
  expect(wayOf(ok, true)).toBe(200);
  expect(wayOf(ok)).toBe(0);
});

test.each([
  [82, "82 ms"],
  [1234, "1.2 s"],
])("%d ms is %j", (ms, words) => {
  expect(took(ms)).toBe(words);
});

test("a run says how it went", () => {
  const run = {
    id: "r-1",
    workflow_id: "wf-1",
    revision: 3,
    trigger: "editor",
    started_at: "2026-10-30T20:00:00.000Z",
  } as const;
  expect(runSaid({ ...run, status: "running" })).toBe("running");
  expect(
    runSaid({
      ...run,
      status: "succeeded",
      ended_at: "2026-10-30T20:00:01.234Z",
    }),
  ).toBe("succeeded in 1.2 s");
  expect(
    runSaid({
      ...run,
      status: "succeeded",
      answered: 404,
      ended_at: "2026-10-30T20:00:00.082Z",
    }),
  ).toBe("succeeded in 82 ms, answered 404");
  expect(
    runSaid({
      ...run,
      status: "failed",
      ended_at: "2026-10-30T20:00:00.500Z",
      error: { code: "upstream_failed", detail: "user answered 503" },
    }),
  ).toBe("failed in 500 ms: user answered 503");
  expect(
    runSaid({
      ...run,
      status: "failed",
      answered: 502,
      ended_at: "2026-10-30T20:00:00.500Z",
      error: { code: "upstream_failed", detail: "user answered 503" },
    }),
  ).toBe("failed in 500 ms: user answered 503; Unhandled answered 502");
});

test("a step whose Unhandled took its failure answered through it", () => {
  const failed: StepRun = {
    state: "failed",
    status: 500,
    attempts: 2,
    error: { code: "upstream_failed", detail: "status 500", caught: true },
  };
  expect(wayOf(failed)).toBe(UNHANDLED);
  expect(said(failed)).toBe("Unhandled: 500, after 2 attempts");
  expect(
    said({
      state: "failed",
      error: { code: "timeout", detail: "", caught: true },
    }),
  ).toBe("Unhandled: timeout");
  const ran: StepRun = { state: "succeeded" };
  expect(takenOf(UNHANDLED, failed, ran)).toBe(true);
  expect(takenOf(undefined, failed, ran)).toBe(false);
  // A failure no line took answered nothing.
  expect(
    wayOf({ ...failed, error: { code: "upstream_failed", detail: "" } }),
  ).toBeUndefined();
  expect(wayOf({ state: "succeeded", status: 404 })).toBe(404);
  expect(wayOf({ state: "succeeded" })).toBe(0);
});
