<script lang="ts">
  /**
   * The `/` route: the main menu. Everything it offers -- starting a campaign at a chosen difficulty, loading a
   * save, preferences, credits -- lives in `packages/ui`'s `MainMenu`; this page only turns its choices into
   * navigation. It preloads nothing of a campaign (no scenario snapshot, unit art, terrain data or WML): a
   * campaign's own files are fetched only once one is chosen and `PlayPage` mounts.
   */
  import { MainMenu, type Campaign } from '@wesnothweb2/ui';
  import { router } from './router.svelte.js';

  function play(campaign: Campaign, difficulty: string | undefined): void {
    router.navigate(`/play/${campaign.id}${difficulty ? `?difficulty=${encodeURIComponent(difficulty)}` : ''}`);
  }

  function resume(campaignId: string, saveName: string, replay: boolean): void {
    router.navigate(`/play/${campaignId}?save=${encodeURIComponent(saveName)}${replay ? '&replay=1' : ''}`);
  }
</script>

<MainMenu onPlay={play} onResume={resume} />
