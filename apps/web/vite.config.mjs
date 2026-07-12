import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@project-conversation/client-sdk": fileURLToPath(
        new URL("../../packages/client-sdk/src/index.ts", import.meta.url),
      ),
      "@project-conversation/db-bindings": fileURLToPath(
        new URL("../../packages/db-bindings/src/index.ts", import.meta.url),
      ),
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.js"],
  },
});
