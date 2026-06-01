import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
/// <reference types="vitest" />

function devTitle(): import('vite').Plugin {
  return {
    name: 'dev-title',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace('<title>Tinstar', '<title>[DEV] Tinstar')
    },
  }
}

const backendPort = process.env.TINSTAR_BACKEND_PORT ?? '5281'
const frontendPort = parseInt(process.env.TINSTAR_FRONTEND_PORT ?? '5280')

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    // Backend tests are pure Node (filesystem, child_process, NATS) and have no
    // business booting jsdom. Running them under the `node` environment is both
    // faster and avoids jsdom's dependency chain (html-encoding-sniffer →
    // @exodus/bytes), which is ESM-only and unrequireable on Node < 22.12.
    // Anything that genuinely needs the DOM stays on the default jsdom env.
    environmentMatchGlobs: [
      ['src/server/**', 'node'],
      ['tests/server/**', 'node'],
    ],
    setupFiles: ['./tests/setup.ts'],
  },
  plugins: [react(), devTitle()],
  resolve: {
    alias: {
      '@tinstar/plugin-api': fileURLToPath(new URL('./packages/plugin-api/src/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist/client',
  },
  define: {
    // Expose backend port so the SSE EventSource can connect directly,
    // bypassing the Vite proxy (which blocks other requests while SSE is active)
    '__TINSTAR_BACKEND_PORT__': JSON.stringify(backendPort),
  },
  server: {
    port: frontendPort,
    host: true,
    allowedHosts: true,
    proxy: {
      '/api/': {
        target: `http://localhost:${backendPort}`,
      },
      '/s/': {
        target: `http://localhost:${backendPort}`,
        ws: true,
      },
    },
  },
})
