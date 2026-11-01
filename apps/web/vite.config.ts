import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const api = `http://127.0.0.1:${process.env.PORT ?? 3334}`;

// Inside DDEV set VITE_HOST=0.0.0.0 and VITE_HMR_HOST=ai-office.ddev.site (see .ddev/config.yaml).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: process.env.VITE_HOST ?? '127.0.0.1',
    port: 5173,
    strictPort: true,
    hmr: process.env.VITE_HMR_HOST ? { host: process.env.VITE_HMR_HOST, clientPort: 5173 } : undefined,
    proxy: {
      '/api': api,
      '/ws': { target: api.replace('http', 'ws'), ws: true },
    },
  },
});
