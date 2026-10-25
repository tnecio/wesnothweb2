import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig(({ command }) => ({
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
          // Phase 19: music and sound files are not content-hashed, but they never change under a
          // running version; a day's cache stops replayed scenarios refetching several MB of music.
          if (req.url && /^\/game-images\/.+\/(music|sounds)\//.test(req.url)) {
            res.setHeader('Cache-Control', 'public, max-age=86400');
          }
          next();
        });
      },
    },
  ],
  // Fengari (packages/lua-bridge's Lua VM) reads `process.env.FENGARICONF` at load time; its
  // README has bundlers define it. Build only: in dev, Vite would materialize a `process.env.*`
  // define as a runtime global `process`, which flips fengari into its Node code paths -- the
  // dev server's dep prebundle gets the static replacement below instead.
  define: command === 'build' ? { 'process.env.FENGARICONF': 'undefined' } : {},
  optimizeDeps: { esbuildOptions: { define: { 'process.env.FENGARICONF': 'undefined' } } },
  // Phase 28: public/ holds symlinks into the wesnoth submodule (~600 MB of game media, which production
  // serves from its own bucket), so a build copies only what the app itself needs: scripts/stage-dist.mjs.
  build: { copyPublicDir: false },
  // Module workers (packages/renderer's image compositor pool) are emitted as ES modules.
  worker: { format: 'es' },
  server: {
    port: 5173,
    host: true,
    // Phase 32, development only: `STATS_PROXY=http://localhost:8787 VITE_STATS_URL=/__stats` sends the
    // statistics and bug reports through this server to a local `wrangler dev` (apps/stats), so a browser that
    // reaches the game through one forwarded port reaches the stats Worker too. The request is same-origin
    // here; its Origin header is dropped so the Worker's CORS check (for the real deployment) lets it in.
    ...(process.env['STATS_PROXY']
      ? {
          proxy: {
            '/__stats': {
              target: process.env['STATS_PROXY'],
              rewrite: (path: string) => path.replace(/^\/__stats/, ''),
              configure: (proxy: { on(event: 'proxyReq', handler: (req: { removeHeader(name: string): void }) => void): void }) =>
                proxy.on('proxyReq', (req) => req.removeHeader('origin')),
            },
          },
        }
      : {}),
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
}));
