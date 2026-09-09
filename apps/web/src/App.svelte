<script lang="ts">
  import type { GameBoardSnapshot } from '@wesnothweb2/engine';
  import { GameShell } from '@wesnothweb2/ui';

  let status = $state<'loading' | 'ready' | 'error'>('loading');
  let errorMessage = $state('');
  let snapshot = $state<GameBoardSnapshot | null>(null);

  $effect(() => {
    let cancelled = false;
    (async () => {
      // The initial, entry-point scenario -- hardcoded since there's no real
      // campaign/scenario picker yet (future Phase 6 work, out of scope for
      // scenario chaining). Once loaded, GameShell's own "Continue to next
      // scenario" flow fetches whichever scenario a finished one's real
      // `next_scenario=` names, generically (see GameShell.svelte).
      const res = await fetch('/scenarios/01_Invasion.json');
      if (!res.ok) throw new Error(`fetch scenarios/01_Invasion.json: ${res.status}`);
      const data: GameBoardSnapshot = await res.json();
      if (cancelled) return;
      snapshot = data;
      status = 'ready';
    })().catch((err) => {
      if (cancelled) return;
      console.error(err);
      errorMessage = err instanceof Error ? err.message : String(err);
      status = 'error';
    });
    return () => {
      cancelled = true;
    };
  });
</script>

<main>
  {#if status === 'loading'}
    <p class="loading">Loading scenario...</p>
  {:else if status === 'error'}
    <p class="loading">Failed to load: {errorMessage}</p>
  {:else if snapshot}
    <GameShell {snapshot} />
  {/if}
</main>

<style>
  :global(html, body) {
    margin: 0;
    height: 100%;
  }
  main {
    font-family: sans-serif;
    color: #eee;
    background: #181818;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .loading {
    padding: 1rem;
  }
</style>
