export function generatePlaywrightConfig(testDir: string): string {
    return /* ts */ `import { defineConfig, devices } from '@playwright/test';
import 'dotenv/config';

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './${testDir}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  reporter: '@testla/screenplay-playwright/reporter/html',

  use: {
    baseURL: process.env.BASE_URL,
    trace: 'on-first-retry',
    headless: !(process.env.HEADLESS === 'false'),
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
`;
}
