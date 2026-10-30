import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";

import type { components } from "@/gen/schema";
import { ApiError } from "@/lib/api";
import { createParser, followRun, type StreamEvent } from "@/lib/events";
import { server } from "@/test/server";

type NodeEvent = components["schemas"]["NodeEvent"];
type Run = components["schemas"]["Run"];

// parse feeds a parser the pieces given, as a stream might cut them, and
// gives the events it dispatched.
function parse(...pieces: string[]): StreamEvent[] {
  const events: StreamEvent[] = [];
  const parser = createParser((e) => events.push(e));
  for (const p of pieces) parser.feed(p);
  return events;
}

test("an event ends at a blank line, its type named or message", () => {
  expect(parse("event: node\ndata: 1\n\ndata: 2\n\n")).toEqual([
    { type: "node", data: "1", id: "" },
    { type: "message", data: "2", id: "" },
  ]);
});

// Two data lines, so a line end read as two would end the event early.
test.each([
  ["LF", "data: a\ndata: b\n\n"],
  ["CRLF", "data: a\r\ndata: b\r\n\r\n"],
  ["CR", "data: a\rdata: b\r\r"],
])("lines end at %s", (_name, stream) => {
  expect(parse(stream)).toEqual([{ type: "message", data: "a\nb", id: "" }]);
});

test("a line end cut between two pieces counts once", () => {
  expect(parse("data: a\r", "\n\r", "\ndata: b\r", "\r")).toEqual([
    { type: "message", data: "a", id: "" },
    { type: "message", data: "b", id: "" },
  ]);
});

test("data lines join with a line feed, and a value keeps its colons", () => {
  expect(parse('data: {"a":\ndata:  1}\n\n')).toEqual([
    { type: "message", data: '{"a":\n 1}', id: "" },
  ]);
});

test("comments, unknown fields and events with no data dispatch nothing", () => {
  expect(parse(": keep-alive\n\nevent: node\n\nfoo: bar\n\n")).toEqual([]);
});

test("a field with no colon has an empty value", () => {
  expect(parse("data\n\n")).toEqual([{ type: "message", data: "", id: "" }]);
});

test("an id counts once its event is dispatched, and stays for the next", () => {
  const events: StreamEvent[] = [];
  const parser = createParser((e) => events.push(e));
  parser.feed("id: 1\ndata: a\n\ndata: b\n\nid: 2\ndata: c\n");
  expect(events.map((e) => e.id)).toEqual(["1", "1"]);
  expect(parser.lastEventId).toBe("1");
  parser.feed("\n");
  expect(parser.lastEventId).toBe("2");
});

test("an id with a null in it is ignored, and retry takes digits only", () => {
  const parser = createParser(() => {});
  parser.feed("id: a\0b\nretry: 1s\nretry: 250\ndata: x\n\n");
  expect(parser.lastEventId).toBe("");
  expect(parser.retry).toBe(250);
});

test("a parser picks up from the id it's given", () => {
  const events: StreamEvent[] = [];
  createParser((e) => events.push(e), "7").feed("data: a\n\n");
  expect(events[0]?.id).toBe("7");
});

// stream answers with an event stream sent in the pieces given.
function stream(...pieces: string[]) {
  const encoder = new TextEncoder();
  return new HttpResponse(
    new ReadableStream({
      start(controller) {
        for (const p of pieces) controller.enqueue(encoder.encode(p));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

const started: NodeEvent = {
  node: "user",
  kind: "started",
  attempt: 1,
  at: "2026-10-30T20:00:00Z",
};
const succeeded: NodeEvent = {
  ...started,
  kind: "succeeded",
  http_status: 404,
};
const ended: Run = {
  id: "r-1",
  workflow_id: "wf-1",
  revision: 3,
  trigger: "editor",
  status: "succeeded",
  started_at: "2026-10-30T20:00:00Z",
  ended_at: "2026-10-30T20:00:01Z",
  input: null,
};

test("a run is followed to its end, resuming after a dropped connection", async () => {
  const asked: (string | null)[] = [];
  server.use(
    http.get("/api/v1/runs/r-1/events", ({ request }) => {
      const last = request.headers.get("Last-Event-ID");
      asked.push(last);
      return last === null
        ? // The connection drops after the first event.
          stream(
            "retry: 10\n",
            `event: node\nid: 1\ndata: ${JSON.stringify(started)}\n\n`,
          )
        : stream(
            `event: node\nid: 2\ndata: ${JSON.stringify(succeeded)}\n\n`,
            `event: run\nid: end\ndata: ${JSON.stringify(ended)}\n\n`,
          );
    }),
  );
  const nodes: NodeEvent[] = [];
  const run = await followRun(
    "r-1",
    (e) => nodes.push(e),
    new AbortController().signal,
  );
  expect(nodes).toEqual([started, succeeded]);
  expect(run).toEqual(ended);
  expect(asked).toEqual([null, "1"]);
});

test("a 204 means the run ended before, and there's nothing to follow", async () => {
  server.use(
    http.get(
      "/api/v1/runs/r-1/events",
      () => new HttpResponse(null, { status: 204 }),
    ),
  );
  expect(
    await followRun("r-1", () => {}, new AbortController().signal),
  ).toBeUndefined();
});

test("a refusal says why, as any request's does", async () => {
  server.use(
    http.get("/api/v1/runs/r-1/events", () =>
      HttpResponse.json(
        { code: "not_found", detail: "No run has that id." },
        { status: 404 },
      ),
    ),
  );
  const err = await followRun(
    "r-1",
    () => {},
    new AbortController().signal,
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ kind: "client", status: 404 });
});
