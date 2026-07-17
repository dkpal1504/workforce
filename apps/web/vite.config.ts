import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@workforce/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      // Proxy only /api/* — never steal SPA routes like /timesheet or /summary
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
