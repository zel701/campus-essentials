import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5174", trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      use: {
        actionTimeout: 15000,
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: {
    command: "node ../scripts/dev-web.cjs",
    url: "http://127.0.0.1:5174",
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      LOCAL_TEST_MODE: "1",
      LOCAL_TABLE_NAME: "campus-essentials-local-browser-tests",
      DYNAMODB_LOCAL_PORT: "8766",
      API_PORT: "3002",
      WEB_PORT: "5174",
    },
  },
});
