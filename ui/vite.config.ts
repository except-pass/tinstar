import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        test: 'test-page.html'
      }
    }
  },
  server: {
    port: 3000,
    proxy: {
      '/filelist': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
  }
});