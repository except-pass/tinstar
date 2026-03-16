import { defineConfig } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const frontendPort = process.env.TINSTAR_FRONTEND_PORT ?? '5280'
const backendPort = process.env.TINSTAR_BACKEND_PORT ?? '5281'
const baseURL = process.env.BASE_URL ?? `http://localhost:${frontendPort}`
const testDataDir = process.env.TINSTAR_DATA_DIR ?? join(tmpdir(), `tinstar-test-${Date.now()}`)

export default defineConfig({
  testDir: './e2e',
  // All tests share a single simulator instance — parallel workers cause resets
  // to wipe state mid-assertion in other workers. Use 1 worker for reliability.
  workers: 1,
  fullyParallel: false,
  retries: 1,
  timeout: 30000,
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 15000,
    env: {
      TINSTAR_FAST_SIM: '1',
      TINSTAR_NO_SESSIONS: '1',
      TINSTAR_DATA_DIR: testDataDir,
      TINSTAR_BACKEND_PORT: backendPort,
      TINSTAR_FRONTEND_PORT: frontendPort,
    },
  },
})
