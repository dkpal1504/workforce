import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, "../.."), "");
  const apiTarget = env.VITE_API_URL || `http://localhost:${env.API_PORT || "4000"}`;

  return {
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
        // Proxy only /api/* — never steal SPA routes like /timesheet or /summary.
        "/api": {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
