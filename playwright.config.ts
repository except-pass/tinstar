import { defineConfig } from '@playwright/test'
import { cpus } from 'node:os'

export default defineConfig({
  testDir: './e2e',
  workers: process.env.TEST_WORKERS ? parseInt(process.env.TEST_WORKERS) : cpus().length,
  fullyParallel: true,
  retries: 1,
  timeout: 30000,
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    trace: 'on-first-retry',
  },
})
