import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: ['reconciliation-mcp.spec.ts', 'reconciliation-floor.spec.ts', 'cockpit-regression.spec.ts', 'cockpit-filter-link.spec.ts', 'cockpit-desk.spec.ts', 'cockpit-mate-badge.spec.ts', 'cockpit-quota.spec.ts', 'cockpit-terminal-scroll.spec.ts', 'cockpit-shell.spec.ts', 'cockpit-composer.spec.ts'],
  workers: 1,
  retries: 0,
  timeout: 120_000,
  use: { trace: 'retain-on-failure' },
})
