import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Phase 29: sessions in tests get the data directory's Lua from disk, as the browser gets its bundle.
    setupFiles: ['./test-setup.ts'],
  },
});
