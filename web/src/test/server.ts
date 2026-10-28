import { cleanup } from "@testing-library/react";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

// One MSW server per test file that imports this. A request with no handler
// fails the test instead of reaching the network. (MSW 3 renamed the option
// from onUnhandledRequest, and the old name is ignored.)
export const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());
