import { defineConfig, devices } from '@playwright/test';

const target = process.env.SERFING_E2E_URL;
const local = 'http://127.0.0.1:5179';

export default defineConfig({
  testDir: './src',
  testMatch: '**/*.e2e.ts',
  use: { baseURL: target ?? local },
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
  webServer: target ? undefined : {
    command: 'npm run dev -- --host 127.0.0.1 --port 5179 --strictPort',
    url: local,
  },
});
