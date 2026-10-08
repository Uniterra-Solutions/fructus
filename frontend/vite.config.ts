import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Dev proxy (D14): the frontend always talks same-origin paths —
 *   /api/*  → the fructus server (prefix stripped),  /ws → the server socket,
 *   /rpc/*  → the Solana RPC (validator in the demo). A production reverse
 * proxy (Caddy) maps the same three paths; see README.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
      "/rpc": {
        target: "http://127.0.0.1:8899",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/rpc/, "/"),
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    globals: true,
    restoreMocks: true,
  },
});
