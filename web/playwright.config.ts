import { defineConfig, devices } from "@playwright/test";

import { stack } from "./e2e/stack";

// The database the server keeps workflows and runs in: one `just e2e` makes
// afresh and migrates each time, as the test expects nothing in it.
const database = process.env.CONDUIT_E2E_DATABASE_URL;
if (!database)
  throw new Error(
    "CONDUIT_E2E_DATABASE_URL isn't set: run the browser test with just e2e",
  );

const hostOf = (url: string) => new URL(url).host;

// The browser test drives the app as built, in Chromium, against the
// server, its database and the test upstream, as plan 04's Done says.
// Playwright starts each piece, waits for it to answer, and stops it after.
export default defineConfig({
  testDir: "e2e",
  // The tests share the server and its database.
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  timeout: 60_000,
  use: { baseURL: stack.app, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `go run ./cmd/testupstream -addr ${hostOf(stack.upstream)}`,
      cwd: "../server",
      url: `${stack.upstream}/status/200`,
    },
    {
      command: "go run ./cmd/conduit",
      cwd: "../server",
      url: `${stack.server}/healthz`,
      env: {
        CONDUIT_DATABASE_URL: database,
        CONDUIT_API_TOKEN: stack.token,
        CONDUIT_CONSTANTS_KEY: stack.constantsKey,
        CONDUIT_HTTP_ADDR: hostOf(stack.server),
        // Its runs call the test upstream, on loopback.
        CONDUIT_ALLOW_PRIVATE_NETWORKS: "true",
        CONDUIT_UPSTREAM_PORTS: new URL(stack.upstream).port,
        CONDUIT_LOG_FORMAT: "text",
      },
    },
    {
      command: `corepack pnpm exec vite preview --host 127.0.0.1 --port ${new URL(stack.app).port} --strictPort`,
      url: stack.app,
      env: { CONDUIT_API_ORIGIN: stack.server },
    },
  ],
});
