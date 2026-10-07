import { defineConfig } from '@playwright/test';
import path from 'node:path';

if (!process.env.EROS_E2E_DIRECTORY) throw new Error('Run npm run test:e2e (the orchestrator supplies an isolated fixture).');
const directory = path.resolve(process.env.EROS_E2E_DIRECTORY);
export default defineConfig({
  testDir: './e2e/specs', workers: 1, fullyParallel: false, retries: 0,
  timeout: 300_000, expect: { timeout: 45_000 },
  outputDir: path.join(directory, 'browser-results'),
  reporter: [['list'], ['json', { outputFile: path.join(directory, 'browser-report.json') }],
    ['html', { outputFolder: path.join(directory, 'browser-report'), open: 'never' }]],
  use: { baseURL: process.env.EROS_E2E_BASE_URL, viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure' },
});
