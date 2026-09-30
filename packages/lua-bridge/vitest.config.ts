import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Phase 29: a test that boots the Lua kernel and the AI's Lua (ai_helper.lua and friends) takes a few seconds
    // on fengari, more while other suites run alongside.
    testTimeout: 60_000,
  },
});
