import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * MindStone fresh-install journey UAT (MindStone-Agent #106). Normally started
 * by run-journey.sh, which installs everything and sets the UAT_* variables;
 * see README.md. No webServer: the Console under test is a real
 * `docker compose` deployment, and the admin is created by its README's
 * create-user line, not by the e2e seed.
 *
 * No html reporter, no traces, no videos: they record action titles and
 * arguments (an html report keeps them in a base64 zip), and the journey types
 * the admin password and, with UAT_PROVIDER=ollama-cloud, an API key. Secrets
 * are typed with fillSecret (lib/journey.ts), whose steps carry no value, and
 * run-journey.sh fails the run if any secret is found anywhere in the evidence.
 * Evidence is the screenshots and log excerpts the spec writes, plus the list
 * and json reports.
 */
const evidence = process.env.UAT_EVIDENCE_DIR ?? path.resolve(__dirname, 'evidence', 'manual');

export default defineConfig({
  testDir: __dirname,
  testMatch: /journey\.spec\.ts$/,
  outputDir: path.join(evidence, 'playwright', 'test-results'),
  globalSetup: path.join(__dirname, 'lib', 'global-setup.ts'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 8 * 60_000,
  expect: { timeout: 20_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(evidence, 'playwright', 'results.json') }],
    [path.join(__dirname, 'lib', 'summary-reporter.ts')],
  ],
  use: {
    baseURL: process.env.UAT_CONSOLE_URL ?? 'http://localhost:3080',
    headless: true,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    viewport: { width: 1366, height: 900 },
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } } }],
});
