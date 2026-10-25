// The one way the app talks to the server. Requests go to /api, which nginx
// (and Vite's dev proxy) forward to the server with the prefix stripped.

export type ApiErrorKind = "offline" | "timeout" | "client" | "server";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;

  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

const BASE = "/api";
const TIMEOUT_MS = 10_000;

export async function getJSON<T>(
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let res: Response;
  try {
    // An absolute URL, because Node's fetch, which the tests run on, rejects
    // relative ones.
    res = await fetch(new URL(`${BASE}${path}`, window.location.origin), {
      signal: combined,
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    if (signal?.aborted) throw err; // the caller cancelled; not an API failure
    if (timeout.aborted)
      throw new ApiError("timeout", `${path} timed out after ${TIMEOUT_MS} ms`);
    throw new ApiError(
      "offline",
      `${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const kind = res.status >= 500 ? "server" : "client";
    throw new ApiError(kind, `${path}: HTTP ${res.status}`, res.status);
  }
  // The caller passes a type generated from schema/openapi.yaml; nothing
  // checks the body against it at run time.
  return (await res.json()) as T;
}
