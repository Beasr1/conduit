import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

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
    proxy: {
      // Same shape as nginx (docker/web/nginx/conf.d/default.conf): /api/*
      // reaches the server with the prefix stripped.
      "/api": {
        target: "http://127.0.0.1:8080",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/console.ts"],
  },
});
