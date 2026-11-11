import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: ['search-initiative-filter.spec.ts', 'review-routing.spec.ts', 'global-desk.spec.ts', 'pr-operations.spec.ts', 'reconciliation-mcp.spec.ts', 'reconciliation-floor.spec.ts', 'cockpit-regression.spec.ts', 'cockpit-filter-link.spec.ts', 'cockpit-desk.spec.ts', 'cockpit-mate-badge.spec.ts', 'cockpit-quota.spec.ts', 'cockpit-terminal-scroll.spec.ts', 'cockpit-shell.spec.ts', 'cockpit-composer.spec.ts'],
  workers: 1,
  retries: 0,
  timeout: 120_000,
  // CI writes the HTML report the browser-suite job uploads with failure traces.
  // open: 'never' so a local run with CI set does not start a report server.
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
})
