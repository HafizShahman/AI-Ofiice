import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const api = `http://127.0.0.1:${process.env.PORT ?? 3334}`;
// 5273 so a local run doesn't collide with other Vite projects on 5173.
const port = Number(process.env.VITE_PORT ?? 5273);

/** Dev only: lets the ?helper layout editors save src/scene/props.json (2D) and room3d.overrides.json (3D). Not part of the built app. */
function helperSave(): Plugin {
  const files: Record<string, { file: string; valid: (d: Record<string, unknown>) => boolean }> = {
    '/__helper/props': {
      file: fileURLToPath(new URL('./src/scene/props.json', import.meta.url)),
      valid: (d) => Array.isArray(d.props) && !!(d.nav as { areas?: unknown } | undefined)?.areas && !!d.room,
    },
    '/__helper/room3d': {
      file: fileURLToPath(new URL('./src/scene/room3d.overrides.json', import.meta.url)),
      valid: (d) => typeof d.spots === 'object' && d.spots !== null && !Array.isArray(d.spots),
    },
  };
  return {
    name: 'ai-office-helper-save',
    apply: 'serve',
    configureServer(server) {
      for (const [url, { file, valid }] of Object.entries(files)) {
        server.middlewares.use(url, (req, res) => {
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
              if (!valid(JSON.parse(body))) throw new Error('not a layout file');
              writeFileSync(file, body);
              res.statusCode = 204;
            } catch {
              res.statusCode = 400;
            }
            res.end();
          });
        });
      }
    },
  };
}

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
