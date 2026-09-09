<script lang="ts">
  import { router } from './router.svelte.js';
  import MenuPage from './MenuPage.svelte';
  import PlayPage from './PlayPage.svelte';

  const playCampaignId = $derived(/^\/play\/([^/]+)$/.exec(router.path)?.[1]);
</script>

{#if playCampaignId}
  {#key playCampaignId}
    <PlayPage campaignId={playCampaignId} />
  {/key}
{:else}
  <MenuPage />
{/if}

<style>
  :global(html, body) {
    margin: 0;
    height: 100%;
  }
</style>
