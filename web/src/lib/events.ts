// A run's events, read as a server-sent event stream with fetch() rather
// than EventSource, which hides a failed connection's status (D9). The
// stream is parsed as the WHATWG HTML spec's "Parsing an event stream" says,
// and followed until the run ends.
import { ApiError, type Problem } from "@/lib/api";
import type { components } from "@/gen/schema";

type NodeEvent = components["schemas"]["NodeEvent"];
type Run = components["schemas"]["Run"];

// StreamEvent is one event of a stream: its type, "message" unless the
// stream names one; its data; and the id it carried, or the last before it.
export interface StreamEvent {
  type: string;
  data: string;
  id: string;
}

// createParser parses an event stream fed to it as text, in pieces cut
// anywhere, and calls onEvent for each event as the spec dispatches it. A
// byte order mark is TextDecoder's to drop. lastEventId starts as the one a
// connection resumed from.
export function createParser(
  onEvent: (event: StreamEvent) => void,
  lastEventId = "",
) {
  let pending = ""; // text not yet ended by a line end
  let skipLF = false; // a piece ended in CR, so an LF opening the next ends that line
  let type = "";
  let data = "";
  let id = lastEventId;
  let last = lastEventId;
  let retry: number | undefined;

  function line(text: string) {
    if (text === "") return dispatch();
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") type = value;
    else if (field === "data") data += value + "\n";
    else if (field === "id" && !value.includes("\0")) id = value;
    else if (field === "retry" && /^[0-9]+$/.test(value)) retry = Number(value);
  }

  // An id counts once its event is dispatched, even one with no data.
  function dispatch() {
    last = id;
    if (data !== "")
      onEvent({ type: type || "message", data: data.slice(0, -1), id });
    data = "";
    type = "";
  }

  return {
    feed(piece: string) {
      let text = piece;
      if (skipLF && text !== "") {
        if (text.startsWith("\n")) text = text.slice(1);
        skipLF = false;
      }
      pending += text;
      let start = 0;
      for (let i = 0; i < pending.length; i++) {
        const c = pending[i];
        if (c !== "\r" && c !== "\n") continue;
        line(pending.slice(start, i));
        if (c === "\r" && i + 1 === pending.length) skipLF = true;
        else if (c === "\r" && pending[i + 1] === "\n") i++;
        start = i + 1;
      }
      pending = pending.slice(start);
    },
    get lastEventId() {
      return last;
    },
    get retry() {
      return retry;
    },
  };
}

// How long to wait before connecting again when the server doesn't say.
const RETRY_MS = 1000;

// followRun follows a run's events to its end: onNode for each node event,
// and the run, as its last event has it, once it ends. A connection that
// drops is made again with the id of the last event, so none is missed or
// repeated. It's undefined when the run ended before, so the server has
// nothing more to send (204). It stops early when signal aborts.
export async function followRun(
  id: string,
  onNode: (event: NodeEvent) => void,
  signal: AbortSignal,
): Promise<Run | undefined> {
  const url = new URL(`/api/v1/runs/${id}/events`, window.location.origin);
  let lastEventId = "";
  let wait = RETRY_MS;
  for (;;) {
    let ended: Run | undefined;
    // The data is the server's, typed by schema/openapi.yaml.
    const parser = createParser((e) => {
      if (e.type === "node") onNode(JSON.parse(e.data) as NodeEvent);
      else if (e.type === "run") ended = JSON.parse(e.data) as Run;
    }, lastEventId);
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "text/event-stream",
          ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
        },
        signal,
      });
      if (response.status === 204) return undefined;
      if (response.status === 503) {
        wait = 1000 * Number(response.headers.get("Retry-After") ?? 5);
      } else if (!response.ok || !response.body) {
        throw await refused(response);
      } else {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
          if (ended) {
            await reader.cancel();
            return ended;
          }
        }
        wait = parser.retry ?? wait;
      }
    } catch (err) {
      if (signal.aborted || err instanceof ApiError) throw err;
      // The connection dropped, or couldn't be made: try again.
    }
    lastEventId = parser.lastEventId;
    await sleep(wait, signal);
  }
}

// refused is the error for a stream the server refused, worded as call()
// words any request's.
async function refused(response: Response): Promise<ApiError> {
  const problem = (await response.json().catch(() => undefined)) as
    Problem | undefined; // the server's problem details (RFC 9457), by contract
  const kind =
    response.status === 401
      ? "unauthorized"
      : response.status >= 500
        ? "server"
        : "client";
  return new ApiError(
    kind,
    problem?.detail ?? `HTTP ${response.status}`,
    response.status,
    problem,
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
