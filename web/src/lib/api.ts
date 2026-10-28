// The one way the app talks to the server: openapi-fetch, typed from
// schema/openapi.yaml through src/gen. Requests go to /api, which nginx (and
// Vite's dev proxy) forward to the server with the prefix stripped.
import createClient from "openapi-fetch";

import type { components, paths } from "@/gen/schema";

export type Problem = components["schemas"]["Problem"];

export type ApiErrorKind =
  "offline" | "timeout" | "unauthorized" | "client" | "server";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  // The server's problem details, when it sent them.
  readonly problem: Problem | undefined;

  constructor(
    kind: ApiErrorKind,
    message: string,
    status?: number,
    problem?: Problem,
  ) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.problem = problem;
  }
}

const TIMEOUT_MS = 10_000;

// An absolute base URL, because Node's fetch, which the tests run on, rejects
// relative ones.
export const api = createClient<paths>({
  baseUrl: new URL("/api", window.location.origin).href,
  // Looked up on each request: createClient would keep the fetch there was
  // when this module loaded, and miss one swapped in later, as MSW does in
  // tests.
  fetch: (request) => globalThis.fetch(request),
});

type Sent<T> = Promise<{ data?: T; error?: unknown; response: Response }>;

// call sends one request with a timeout and returns its data, or throws an
// ApiError saying what went wrong:
//
//	call((signal) => api.GET("/v1/workflows", { signal }), signal)
export async function call<T>(
  send: (signal: AbortSignal) => Sent<T>,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let sent: Awaited<Sent<T>>;
  try {
    sent = await send(combined);
  } catch (err) {
    if (signal?.aborted) throw err; // the caller cancelled; not an API failure
    if (timeout.aborted)
      throw new ApiError("timeout", `No answer after ${TIMEOUT_MS / 1000} s.`);
    throw new ApiError("offline", "Couldn't reach the server.");
  }

  const { data, error, response } = sent;
  if (response.ok) return data as T; // undefined for 204, as T says
  // Every error the server sends is problem details (RFC 9457), by contract.
  const problem =
    typeof error === "object" && error !== null
      ? (error as Problem)
      : undefined;
  const kind =
    response.status === 401
      ? "unauthorized"
      : response.status >= 500
        ? "server"
        : "client";
  throw new ApiError(
    kind,
    problem?.detail ?? `HTTP ${response.status}`,
    response.status,
    problem,
  );
}
