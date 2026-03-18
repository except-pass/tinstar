import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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
  plugins: [react(), devTitle()],
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
