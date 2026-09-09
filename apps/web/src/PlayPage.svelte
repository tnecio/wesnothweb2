<script lang="ts">
  /**
   * The `/play/<campaignId>` route: resolves `campaignId` to its first
   * scenario (via `campaigns.json`) and fetches THAT scenario's snapshot --
   * the one and only network fetch this page needs beyond the manifest
   * itself. Mounts `GameShell`, which owns everything from here on
   * (including scenario-to-scenario continuation within this campaign --
   * see `GameShell.svelte`'s `continueToNextScenario`; that's a
   * within-campaign concern, not a page/URL change).
   */
  import type { GameBoardSnapshot } from '@wesnothweb2/engine';
  import { GameShell } from '@wesnothweb2/ui';
  import { fetchCampaigns } from './campaigns.js';
  import { router } from './router.svelte.js';

  let { campaignId }: { campaignId: string } = $props();

  let status = $state<'loading' | 'ready' | 'error'>('loading');
  let errorMessage = $state('');
  let snapshot = $state<GameBoardSnapshot | null>(null);

  $effect(() => {
    let cancelled = false;
    status = 'loading';
    errorMessage = '';
    snapshot = null;
    (async () => {
      const campaigns = await fetchCampaigns();
      const campaign = campaigns.find((c) => c.id === campaignId);
      if (!campaign) throw new Error(`Unknown campaign "${campaignId}".`);
      const res = await fetch(`/scenarios/${campaign.firstScenario}.json`);
      if (!res.ok) throw new Error(`fetch scenarios/${campaign.firstScenario}.json: ${res.status}`);
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
    <div class="loading">
      <p>Failed to load: {errorMessage}</p>
      <button onclick={() => router.navigate('/')}>Back to menu</button>
    </div>
  {:else if snapshot}
    <!-- No {#key} needed here: App.svelte already keys PlayPage itself on
         campaignId, so a campaign change always tears down this whole
         component (and GameShell inside it) from scratch. -->
    <GameShell {snapshot} />
  {/if}
</main>

<style>
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
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    align-items: flex-start;
  }
  .loading button {
    font: inherit;
    padding: 0.35rem 0.9rem;
    border-radius: 4px;
    border: 1px solid #4a4432;
    background: #2c2820;
    color: #eee;
    cursor: pointer;
  }
</style>
