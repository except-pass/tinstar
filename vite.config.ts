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

export default defineConfig({
  plugins: [react(), devTitle()],
  server: {
    port: 5280,
    host: true,
    allowedHosts: true,
    proxy: {
      '/api/': {
        target: 'http://localhost:5281',
      },
      '/s/': {
        target: 'http://localhost:5281',
        ws: true,
      },
    },
  },
})
