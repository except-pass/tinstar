import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { tinstarBackend } from './src/server/index'

export default defineConfig({
  plugins: [react(), tinstarBackend()],
  server: {
    port: 5273,
    host: true,
  },
})
