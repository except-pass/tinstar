import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // All tests share a single simulator instance — parallel workers cause resets
  // to wipe state mid-assertion in other workers. Use 1 worker for reliability.
  workers: 1,
  fullyParallel: false,
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
