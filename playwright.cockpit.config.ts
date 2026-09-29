import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: ['cockpit-regression.spec.ts', 'cockpit-inbox.spec.ts', 'cockpit-dismiss.spec.ts', 'cockpit-mate-status.spec.ts', 'cockpit-group-by.spec.ts'],
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: { trace: 'retain-on-failure' },
})
