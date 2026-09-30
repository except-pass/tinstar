import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: ['cockpit-regression.spec.ts', 'cockpit-inbox.spec.ts', 'cockpit-filter-link.spec.ts', 'cockpit-dismiss.spec.ts', 'cockpit-mate-status.spec.ts', 'cockpit-group-by.spec.ts', 'cockpit-mate-badge.spec.ts', 'cockpit-unknown-state.spec.ts', 'cockpit-quota.spec.ts', 'cockpit-terminal-scroll.spec.ts', 'cockpit-shell.spec.ts', 'cockpit-composer.spec.ts'],
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: { trace: 'retain-on-failure' },
})
