import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: 1,
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:5273',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5273',
    reuseExistingServer: true,
    timeout: 15000,
    env: {
      TINSTAR_FAST_SIM: '1',
    },
  },
})
