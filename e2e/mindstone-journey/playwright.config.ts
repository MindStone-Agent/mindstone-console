import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * MindStone fresh-install journey UAT (MindStone-Agent #106). Normally started
 * by run-journey.sh, which installs everything and sets the UAT_* variables;
 * see README.md. No webServer and no global setup: the Console under test is a
 * real `docker compose` deployment, and the admin is created by its README's
 * create-user line, not by the e2e seed.
 *
 * Traces and videos stay off: the provider step types an API key when
 * UAT_PROVIDER=ollama-cloud, and a trace would record it. Evidence is the
 * screenshots the spec takes at each checkpoint, plus the log excerpts.
 */
const evidence = process.env.UAT_EVIDENCE_DIR ?? path.resolve(__dirname, 'evidence', 'manual');

export default defineConfig({
  testDir: __dirname,
  testMatch: /journey\.spec\.ts$/,
  outputDir: path.join(evidence, 'playwright', 'test-results'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 8 * 60_000,
  expect: { timeout: 20_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(evidence, 'playwright', 'report'), open: 'never' }],
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
