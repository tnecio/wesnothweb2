<script lang="ts">
  import { router } from './router.svelte.js';
  import MenuPage from './MenuPage.svelte';
  import PlayPage from './PlayPage.svelte';
  import { BugReportDialog, ErrorScreen, bugReportDialog, reportError } from '@wesnothweb2/ui';

  const playCampaignId = $derived(/^\/play\/([^/]+)$/.exec(router.path)?.[1]);
</script>

<!-- Phase 28 S6: a render error reaches the error screen instead of leaving a half-drawn page. -->
<svelte:boundary onerror={(error) => reportError(error, 'render')}>
  {#if playCampaignId}
    {#key playCampaignId}
      <PlayPage campaignId={playCampaignId} />
    {/key}
  {:else}
    <MenuPage />
  {/if}
  {#snippet failed()}
    <div class="failed"></div>
  {/snippet}
</svelte:boundary>
<ErrorScreen />
<!-- Phase 30: "Report a bug", over whatever opened it (the game menu, the title screen, the error screen). -->
{#if bugReportDialog.open}
  <BugReportDialog />
{/if}

<style>
  .failed {
    height: 100%;
    background: #111;
  }
  :global(html, body) {
    margin: 0;
    height: 100%;
  }
</style>
