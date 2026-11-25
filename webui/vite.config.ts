import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:5174", ws: true },
      // Bridge HTTP endpoints (edit preview) ride the same dev proxy.
      "/api": { target: "http://127.0.0.1:5174" },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
