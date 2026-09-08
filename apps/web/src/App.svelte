<script lang="ts">
  import type { GameBoardSnapshot } from '@wesnothweb2/engine';
  import { GameShell } from '@wesnothweb2/ui';

  let status = $state<'loading' | 'ready' | 'error'>('loading');
  let errorMessage = $state('');
  let snapshot = $state<GameBoardSnapshot | null>(null);

  $effect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch('/scenario-snapshot.json');
      if (!res.ok) throw new Error(`fetch scenario-snapshot.json: ${res.status}`);
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
