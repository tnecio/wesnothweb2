<script lang="ts">
  /**
   * The `/` route: the main menu. Everything it offers -- starting a campaign at a chosen difficulty, loading a
   * save, preferences, credits -- lives in `packages/ui`'s `MainMenu`; this page only turns its choices into
   * navigation. It preloads nothing of a campaign (no scenario snapshot, unit art, terrain data or WML): a
   * campaign's own files are fetched only once one is chosen and `PlayPage` mounts.
   */
  import { MainMenu, randomModeParam, type Campaign } from '@wesnothweb2/ui';
  import type { RandomMode } from '@wesnothweb2/engine';
  import { router } from './router.svelte.js';

  function play(campaign: Campaign, difficulty: string | undefined, randomMode: RandomMode): void {
    const params = new URLSearchParams();
    if (difficulty) params.set('difficulty', difficulty);
    // Phase 30: `?rng=predictable|reduced` (Default RNG needs none).
    if (randomMode !== 'per_action') params.set('rng', randomModeParam(randomMode));
    const query = params.toString();
    router.navigate(`/play/${campaign.id}${query ? `?${query}` : ''}`);
  }

  function resume(campaignId: string, saveName: string, replay: boolean): void {
    router.navigate(`/play/${campaignId}?save=${encodeURIComponent(saveName)}${replay ? '&replay=1' : ''}`);
  }
</script>

<MainMenu onPlay={play} onResume={resume} />
