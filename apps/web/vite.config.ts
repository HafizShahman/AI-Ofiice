import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const api = `http://127.0.0.1:${process.env.PORT ?? 3334}`;
// 5173 belongs to DDEV's router (see .ddev/config.yaml, which sets VITE_PORT=5173), so a local run uses 5273.
const port = Number(process.env.VITE_PORT ?? 5273);

/** Dev only: lets the ?helper layout editor save src/scene/props.json. Not part of the built app. */
function helperSave(): Plugin {
  const file = fileURLToPath(new URL('./src/scene/props.json', import.meta.url));
  return {
    name: 'ai-office-helper-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__helper/props', (req, res) => {
        const sameOrigin = !req.headers.origin || new URL(req.headers.origin).host === req.headers.host;
        if (req.method !== 'POST' || !sameOrigin) {
          res.statusCode = 405;
          return res.end();
        }
        let body = '';
        req.on('data', (c: Buffer) => {
          body += c;
          if (body.length > 500_000) req.destroy();
        });
        req.on('end', () => {
          try {
            const d = JSON.parse(body);
            if (!Array.isArray(d.props) || !d.nav?.areas || !d.room) throw new Error('not a props.json');
            writeFileSync(file, body);
            res.statusCode = 204;
          } catch {
            res.statusCode = 400;
          }
          res.end();
        });
      });
    },
  };
}

// Inside DDEV set VITE_HOST=0.0.0.0 and VITE_HMR_HOST=ai-office.ddev.site (see .ddev/config.yaml).
export default defineConfig({
  plugins: [react(), tailwindcss(), helperSave()],
  build: { chunkSizeWarningLimit: 1000 }, // three.js is most of it; PLAN §14 budget is 450 KB gzipped
  server: {
    host: process.env.VITE_HOST ?? '127.0.0.1',
    port,
    strictPort: true,
    hmr: process.env.VITE_HMR_HOST ? { host: process.env.VITE_HMR_HOST, clientPort: port } : undefined,
    proxy: {
      '/api': { target: api, changeOrigin: false }, // keep Host = the page's host: the server's same-origin check compares them
      '/ws': { target: api.replace('http', 'ws'), ws: true },
    },
  },
});
