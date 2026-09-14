import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
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
