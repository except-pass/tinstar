import { defineConfig } from 'vite'

// Stable preview server — serves last built dist/, proxies all backend
// traffic to the dev server running on port 5273.
// Start with: vite preview --config vite.preview.config.ts
export default defineConfig({
  preview: {
    port: 5274,
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://localhost:5273', ws: true },
      '/s/':  { target: 'http://localhost:5273', ws: true },
      '/terminal-wrapper.html': { target: 'http://localhost:5273' },
    },
  },
})
