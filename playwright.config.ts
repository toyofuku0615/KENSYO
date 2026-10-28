import { defineConfig } from "@playwright/test";
export default defineConfig({
  expect: { timeout: 15000 },
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
    headless: true,
    screenshot: "off",
    trace: "off",
    video: "off",
    actionTimeout: 15000,
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    },
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:3000",
    // Never run destructive demo-account tests against someone's development DB.
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      KENSHO_MODE: "demo",
      APP_ORIGIN: "http://127.0.0.1:3000",
      KENSHO_DB_PATH: ".data/e2e.sqlite",
      TEST_FORM_ORIGIN: "http://127.0.0.1:3000",
    },
  },
});
