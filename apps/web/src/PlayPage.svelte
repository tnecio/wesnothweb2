<script lang="ts">
  /**
   * The `/play/<campaignId>` route: resolves `campaignId` to its first
   * scenario (via `campaigns.json`) and fetches THAT scenario's snapshot,
   * plus its story assets (`/story/<id>.json`: story WML and the rooted,
   * right-sized image table -- see `apps/web/scripts/build-story-assets.mjs`)
   * in parallel. Mounts `GameShell`, which owns everything from here on
   * (including scenario-to-scenario continuation within this campaign --
   * see `GameShell.svelte`'s `continueToNextScenario`; that's a
   * within-campaign concern, not a page/URL change).
   */
  import type { GameBoardSnapshot } from '@wesnothweb2/engine';
  import { GameShell, fetchStoryAssets, loadGame, tx, type StoryAssets, type SaveGameData } from '@wesnothweb2/ui';
  import { fetchCampaigns, type Campaign } from './campaigns.js';
  import { router } from './router.svelte.js';

  let { campaignId }: { campaignId: string } = $props();

  let status = $state<'loading' | 'ready' | 'error'>('loading');
  let errorMessage = $state('');
  let snapshot = $state<GameBoardSnapshot | null>(null);
  let storyAssets = $state<StoryAssets | null>(null);
  /** Passed to `GameShell` so saves record which campaign they belong to (Phase 26). */
  let campaign = $state<Campaign | null>(null);
  /** The save being resumed, when the URL carries `?save=<name>` (Phase 26). */
  let initialSave = $state<SaveGameData | null>(null);
  /** Every campaign, so the in-game load dialog can name the campaign any save belongs to. */
  let allCampaigns = $state<Campaign[]>([]);

  /**
   * Put `saveName` (of `campaignId`) in the URL. A different campaign is a
   * real route change -- `App` keys this page on the campaign id, so the
   * page remounts and the game reopens with the right campaign, which is
   * what stops the next save being filed under the old one. The same
   * campaign just updates the address bar; the game has already been
   * loaded in place.
   */
  function openSave(campaignId: string, saveName: string): void {
    const target = campaignId || campaignInfoId();
    if (!target) return;
    router.navigate(`/play/${target}?save=${encodeURIComponent(saveName)}`);
  }

  function campaignInfoId(): string {
    return campaign?.id ?? campaignId;
  }

  $effect(() => {
    let cancelled = false;
    status = 'loading';
    errorMessage = '';
    snapshot = null;
    storyAssets = null;
    campaign = null;
    initialSave = null;
    (async () => {
      const campaigns = await fetchCampaigns();
      const found = campaigns.find((c) => c.id === campaignId);
      if (!found) throw new Error(`Unknown campaign "${campaignId}".`);
      const campaignInfo = found;
      const params = new URLSearchParams(window.location.search);
      // `?save=<name>` resumes a save (Phase 26): the scenario to fetch is
      // whichever one the save was taken in, not the campaign's first.
      const saveName = params.get('save');
      const save = saveName ? ((await loadGame<SaveGameData>(saveName))?.data ?? null) : null;
      if (saveName && !save) throw new Error(`No save called "${saveName}".`);
      // `?scenario=<id>` starts the campaign at a later scenario (debugging/verification, e.g. an epilogue's outro).
      const scenarioId = save?.scenarioId || params.get('scenario') || campaignInfo.firstScenario;
      const [data, assets] = await Promise.all([
        (async () => {
          const res = await fetch(`/scenarios/${scenarioId}.json`);
          if (!res.ok) throw new Error(`fetch scenarios/${scenarioId}.json: ${res.status}`);
          return (await res.json()) as GameBoardSnapshot;
        })(),
        fetchStoryAssets(scenarioId),
      ]);
      if (cancelled) return;
      snapshot = data;
      storyAssets = assets;
      campaign = campaignInfo;
      allCampaigns = campaigns;
      initialSave = save;
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
    <p class="loading">{tx('Loading scenario...')}</p>
  {:else if status === 'error'}
    <div class="loading">
      <p>{tx('Failed to load:')} {errorMessage}</p>
      <button onclick={() => router.navigate('/')}>{tx('Back to menu')}</button>
    </div>
  {:else if snapshot}
    <!-- No {#key} needed here: App.svelte already keys PlayPage itself on
         campaignId, so a campaign change always tears down this whole
         component (and GameShell inside it) from scratch. -->
    <GameShell {snapshot} {storyAssets} {campaign} {initialSave} campaigns={allCampaigns} onOpenSave={openSave} />
  {/if}
</main>

<style>
  main {
    font-family: var(--font-ui);
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
