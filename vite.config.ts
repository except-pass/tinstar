import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { tinstarBackend } from './src/server/index'

export default defineConfig({
  plugins: [react(), tinstarBackend()],
  server: {
    port: 5273,
    host: true,
    allowedHosts: true,
    proxy: {
      // Proxy session terminal paths through Caddy reverse proxy
      '/s/': {
        target: 'http://localhost:8088',
        ws: true,
      },
    },
  },
})
