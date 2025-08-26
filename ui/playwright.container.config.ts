import { defineConfig, devices } from @playwright/test;

export default defineConfig({
  testDir: ./tests,
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  reporter: [[line]],
  use: {
    baseURL: http://localhost:8080,
    headless: true,
    trace: off
  },
  projects: [
    {
      name: chromium,
      use: { ...devices[Desktop
