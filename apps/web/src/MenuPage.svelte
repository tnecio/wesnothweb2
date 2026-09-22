<script lang="ts">
  /**
   * Campaign picker -- the `/` route. Only fetches `campaigns.json` (a few
   * hundred bytes); a campaign's own scenario snapshot (and everything
   * that pulls in -- unit art, terrain data, WML) is NOT fetched here, only
   * once the user actually picks one and `PlayPage` mounts. That's the
   * "only load assets needed for a given campaign once it's chosen"
   * requirement -- this component structurally can't preload anything.
   */
  import { listSaves, type SaveMeta } from '@wesnothweb2/ui';
  import { fetchCampaigns, type Campaign } from './campaigns.js';
  import { router } from './router.svelte.js';

  let status = $state<'loading' | 'ready' | 'error'>('loading');
  let errorMessage = $state('');
  let campaigns = $state<Campaign[]>([]);
  /**
   * Saved games, so a session can be resumed straight from the menu
   * rather than only from inside the scenario it was taken in (Phase 26).
   * Listing is metadata-only -- no scenario snapshot is fetched until a
   * save is actually picked, keeping this component's "preloads nothing"
   * property intact.
   */
  let saves = $state<SaveMeta[]>([]);

  $effect(() => {
    let cancelled = false;
    fetchCampaigns()
      .then((data) => {
        if (cancelled) return;
        campaigns = data;
        status = 'ready';
      })
      .catch((err) => {
        if (cancelled) return;
        console.error(err);
        errorMessage = err instanceof Error ? err.message : String(err);
        status = 'error';
      });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    let cancelled = false;
    listSaves()
      .then((found) => {
        if (!cancelled) saves = found;
      })
      .catch((err) => console.error('[menu] could not list saves:', err));
    return () => {
      cancelled = true;
    };
  });

  function pick(campaign: Campaign): void {
    router.navigate(`/play/${campaign.id}`);
  }

  /**
   * Resumes a save. The campaign comes from the save itself; a save from
   * before campaigns were recorded (or of a scenario opened directly)
   * falls back to whichever campaign ships that scenario.
   */
  function resume(save: SaveMeta): void {
    const campaignId =
      save.campaignId ?? campaigns.find((c) => c.firstScenario === save.scenarioId)?.id ?? campaigns[0]?.id;
    if (!campaignId) return;
    router.navigate(`/play/${campaignId}?save=${encodeURIComponent(save.name)}`);
  }

  function when(savedAt: number): string {
    const d = new Date(savedAt);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
</script>

<div class="menu">
  <h1>wesnothweb2</h1>
  {#if status === 'loading'}
    <p class="hint">Loading campaigns...</p>
  {:else if status === 'error'}
    <p class="hint error">Failed to load campaigns: {errorMessage}</p>
  {:else}
    <ul class="campaign-list">
      {#each campaigns as campaign (campaign.id)}
        <li>
          <button class="campaign" onclick={() => pick(campaign)}>
            <span class="name">{campaign.name}</span>
            <span class="description">{campaign.description}</span>
          </button>
        </li>
      {/each}
    </ul>

    {#if saves.length > 0}
      <h2>Saved games</h2>
      <ul class="save-list">
        {#each saves.slice(0, 12) as save (save.name)}
          <li>
            <button class="save" onclick={() => resume(save)}>
              <span class="name">{save.name}</span>
              <span class="description">
                {save.scenarioName ?? save.scenarioId}
                {#if save.turnNumber}&middot; turn {save.turnNumber}{/if}
                &middot; {when(save.savedAt)}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<style>
  .menu {
    max-width: 40rem;
    margin: 3rem auto;
    padding: 0 1rem;
    font-family: sans-serif;
    color: #eee;
  }
  h1 {
    font-size: 1.5rem;
    color: #f1e6c8;
  }
  .hint {
    opacity: 0.75;
  }
  .hint.error {
    color: #e87a7a;
  }
  h2 {
    font-size: 1.1rem;
    color: #f1e6c8;
    margin-top: 2rem;
  }
  .save-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .save {
    width: 100%;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    font: inherit;
    padding: 0.4rem 0.7rem;
    border-radius: 4px;
    border: 1px solid #4a4432;
    background: #23201a;
    color: #eee;
    cursor: pointer;
  }
  .save:hover {
    background: #2c2820;
  }
  .campaign-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .campaign {
    width: 100%;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font: inherit;
    padding: 0.75rem 1rem;
    border-radius: 6px;
    border: 1px solid #4a4432;
    background: #23201a;
    color: #eee;
    cursor: pointer;
  }
  .campaign:hover {
    border-color: #8a6a2e;
    background: #2c2820;
  }
  .campaign .name {
    font-weight: 700;
    color: #f1e6c8;
  }
  .campaign .description {
    font-size: 0.85rem;
    opacity: 0.8;
  }
</style>
