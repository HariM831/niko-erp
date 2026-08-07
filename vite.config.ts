import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  root: "client",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client/src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // changeOrigin stays false so the Host header remains the browser's
      // origin host and the API's same-origin check passes in dev.
      "/api": { target: "http://localhost:3000", changeOrigin: false },
    },
  },
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
});
