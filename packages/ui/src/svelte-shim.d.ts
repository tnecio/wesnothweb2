// Ambient module declaration for `.svelte` imports/re-exports under plain
// `tsc` (svelte-check already understands `.svelte` files natively via its
// own compiler integration; this is only needed so `npx tsc --noEmit -p
// packages/ui` -- part of this project's standard verification pair, see
// docs/PROGRESS.md's note on `.svelte` file typechecking -- doesn't fail on
// `./GameShell.svelte`-style specifiers. `apps/web` gets this for free from
// `vite`'s own ambient types (a devDependency there); `packages/ui` is a
// plain library package with no Vite dependency, so it needs its own copy.
declare module '*.svelte' {
  import type { Component } from 'svelte';
  const component: Component<Record<string, unknown>>;
  export default component;
}
