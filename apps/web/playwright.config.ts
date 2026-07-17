import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npm run dev -w @workforce/api",
      url: "http://localhost:4000/health",
      reuseExistingServer: true,
      timeout: 120_000,
      cwd: "../..",
    },
    {
      command: "npm run dev -w @workforce/web",
      url: "http://localhost:5173",
      reuseExistingServer: true,
      timeout: 120_000,
      cwd: "../..",
    },
  ],
});
