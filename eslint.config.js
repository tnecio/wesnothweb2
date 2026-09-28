// Phase 28 S2: correctness lint for the whole repo (docs/PHASE28_PLAN.md). Formatting is left alone on purpose.
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.wrangler/**',
      'wesnoth/**',
      'apps/web/public/**',
      'packages/lua-bridge/vendor-lua-patches/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    // Directives for rules this config does not enable (no-bitwise, no-console) are harmless notes.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // TypeScript already reports undefined names (and knows DOM types such as CanvasImageSource).
      'no-undef': 'off',
      // Flows (GameSession's generator-driven interactions) may finish without asking anything.
      'require-yield': 'off',
      '@typescript-eslint/triple-slash-reference': 'off',
      // Style, not correctness -- and the flagged Maps and Sets are deliberately non-reactive caches.
      'svelte/no-unused-svelte-ignore': 'off',
      'svelte/no-useless-children-snippet': 'off',
      'svelte/prefer-svelte-reactivity': 'off',
      'svelte/require-each-key': 'off',
    },
  },
  {
    // Phase 28a: the image compositor and the terrain layout run in workers and must stay PixiJS-free.
    files: [
      'packages/renderer/src/images/compositor.ts',
      'packages/renderer/src/images/compositor.worker.ts',
      'packages/renderer/src/terrain/terrainLayout.worker.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', { paths: [{ name: 'pixi.js', message: 'Worker-side modules must not import PixiJS (Phase 28a).' }] }],
    },
  },
);
