import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

// The server /api and /serve reach: just dev's, unless the browser test
// points them at its own (web/playwright.config.ts).
const api = process.env.CONDUIT_API_ORIGIN ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // The browser's errors and warnings print in this terminal too. Vite's
    // default does that only when it detects an AI agent running it.
    forwardConsole: true,
    // vite preview, which the browser test serves the built app with,
    // proxies the same way.
    proxy: {
      // Same shape as nginx (docker/web/nginx/conf.d/default.conf): /api/*
      // reaches the server with the prefix stripped.
      "/api": {
        target: api,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      // Served workflows, at the address the editor shows once published.
      "/serve": { target: api },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/console.ts", "src/test/tour.ts"],
    // Playwright runs those, in a browser.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
