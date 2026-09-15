import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [
    svelte(),
    {
      // Phase 28a: image bundles (public/atlases/**/<name>.<hash>.png) are content-hashed, so they can be
      // cached forever. Beyond saving revalidations, a cacheable response lets the browser's HTTP cache make
      // concurrent requests for the same bundle -- one per compositor worker -- wait for a single download
      // instead of each going to the network. Production hosting must send the same header for these files.
      name: 'immutable-image-bundles',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url && /^\/atlases\/.+\.[0-9a-f]{12}\.png(\?|$)/.test(req.url)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
          next();
        });
      },
    },
  ],
  // Module workers (packages/renderer's image compositor pool) are emitted as ES modules.
  worker: { format: 'es' },
  server: {
    port: 5173,
    host: true,
    fs: {
      // allow serving Wesnoth assets (images/audio/WML) from the submodule,
      // which lives outside apps/web
      // plus workspace packages' own static assets (e.g. packages/ui's story font)
      allow: ['..', '../../wesnoth', '../../packages'],
    },
  },
  resolve: {
    // work with workspace packages' TS sources directly, no separate build step
    preserveSymlinks: false,
  },
});
