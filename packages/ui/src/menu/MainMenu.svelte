<script lang="ts">
  /**
   * The main menu (Phase 21): the title screen and the dialogs it opens -- Campaigns (with the difficulty
   * choice), Load, Preferences, Credits and Language -- plus the title music. Starting a campaign and loading
   * a save are only reachable from here; it reports the choice and the host (`apps/web`) navigates.
   *
   * It fetches the campaign list, the tips and the saves' metadata; a campaign's own scenario snapshot (and
   * everything that pulls in) is not fetched until the host opens it.
   */
  import { onMount } from 'svelte';
  import { playStoryMusic } from '@wesnothweb2/engine';
  import { getAudioEngine } from '../audio/audioEngine.js';
  import type { AudioSettings } from '../audio/settings.js';
  import { installUiSounds } from '../audio/uiSounds.js';
  import { fetchCampaigns, type Campaign } from '../campaigns.js';
  import LanguageDialog from '../LanguageDialog.svelte';
  import LoadGameDialog from '../LoadGameDialog.svelte';
  import PreferencesDialog from '../PreferencesDialog.svelte';
  import { locale, t, ts, tx } from '../i18n/locale.js';
  import { deleteSave, listSaves, renameSave, type SaveMeta } from '../persistence.js';
  import { downloadSave, importSaveFile } from '../save/saveManager.js';
  import { WESNOTH_CONTENT_VERSION } from '../save/wesnothSave.js';
  import CampaignSelectionDialog from './CampaignSelectionDialog.svelte';
  import CreditsScreen from './CreditsScreen.svelte';
  import { loadCompletedCampaigns } from './completedStore.js';
  import type { CompletedCampaigns } from './completion.js';
  import { menuPrefs } from './menuPrefs.js';
  import TitleScreen from './TitleScreen.svelte';
  import { fetchTips, shuffled, type Tip } from './tips.js';

  let {
    onPlay,
    onResume,
  }: {
    /** Start `campaign` at `difficulty` (undefined for a campaign with none). */
    onPlay: (campaign: Campaign, difficulty: string | undefined) => void;
    /** Resume save `saveName`, which belongs to `campaignId`. */
    onResume: (campaignId: string, saveName: string) => void;
  } = $props();

  type Dialog = 'campaigns' | 'load' | 'preferences' | 'credits' | 'language' | null;

  const audio = getAudioEngine();

  let dialog = $state<Dialog>(null);
  let campaigns = $state<Campaign[]>([]);
  let tips = $state<Tip[]>([]);
  let completed = $state<CompletedCampaigns>({});
  let saves = $state<SaveMeta[]>([]);
  let saveBusy = $state(false);
  let notice = $state('');
  let loadError = $state('');
  let audioSettings = $state<Readonly<AudioSettings>>(audio.settings);

  function changeAudio(patch: Partial<AudioSettings>): void {
    audio.updateSettings(patch);
    audioSettings = audio.settings;
  }

  onMount(() => {
    let cancelled = false;
    void fetchCampaigns()
      .then((list) => {
        if (cancelled) return;
        campaigns = list;
        // The campaigns' own names and descriptions live in their textdomains.
        const domains = new Set<string>();
        for (const c of list) for (const part of [...c.nameT.parts, ...c.descriptionT.parts]) if (typeof part !== 'string') domains.add(part.domain);
        void locale.useDomains([...domains]);
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) loadError = err instanceof Error ? err.message : String(err);
      });
    void fetchTips().then((list) => {
      if (!cancelled) tips = shuffled(list);
    });
    void loadCompletedCampaigns().then((done) => {
      if (!cancelled) completed = done;
    });
    void refreshSaves();

    // Title music (`title_music`): starts with the first gesture, as browsers require, and ends when a game opens.
    const unlock = (): void => audio.unlock();
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    const stopUiSounds = installUiSounds(audio);
    audio.setBoardReady();
    playStoryMusic(audio.music, 'return_to_wesnoth.ogg');
    return () => {
      cancelled = true;
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      stopUiSounds();
      audio.stopMusic();
    };
  });

  async function refreshSaves(): Promise<void> {
    try {
      saves = await listSaves();
    } catch (err) {
      console.error('[menu] could not list saves:', err);
    }
  }

  /** Opens the campaign dialog. A campaign chosen there is started by the host. */
  function play(campaign: Campaign, difficulty: string | undefined): void {
    dialog = null;
    onPlay(campaign, difficulty);
  }

  /**
   * Resumes a save. The campaign comes from the save itself; a save from before campaigns were recorded (or of
   * a scenario opened directly) falls back to whichever campaign ships that scenario.
   */
  function resume(name: string): void {
    const save = saves.find((s) => s.name === name);
    if (!save) return;
    const campaignId = save.campaignId ?? campaigns.find((c) => c.firstScenario === save.scenarioId)?.id ?? campaigns[0]?.id;
    if (!campaignId) return;
    dialog = null;
    onResume(campaignId, name);
  }

  async function guarded(work: () => Promise<void>, failure: string): Promise<void> {
    saveBusy = true;
    notice = '';
    try {
      await work();
    } catch (err) {
      notice = `${failure} ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      saveBusy = false;
      await refreshSaves();
    }
  }

  const campaignNames = $derived(Object.fromEntries(campaigns.map((c) => [c.id, ts(c.nameT)])));
</script>

{#if loadError}
  <p class="error" role="alert">{tx('Failed to load campaigns:')} {loadError}</p>
{/if}

<TitleScreen
  version={WESNOTH_CONTENT_VERSION}
  {tips}
  showTips={menuPrefs.showTips}
  blocked={dialog !== null}
  onCampaigns={() => (dialog = 'campaigns')}
  onLoad={() => (dialog = 'load')}
  onPreferences={() => (dialog = 'preferences')}
  onCredits={() => (dialog = 'credits')}
  onLanguage={() => (dialog = 'language')}
/>

{#if dialog === 'campaigns'}
  <CampaignSelectionDialog {campaigns} {completed} onPlay={play} onCancel={() => (dialog = null)} />
{:else if dialog === 'load'}
  <LoadGameDialog
    {saves}
    {campaignNames}
    busy={saveBusy}
    allowReplay={false}
    onLoad={(name) => resume(name)}
    onDelete={(name) => void guarded(() => deleteSave(name), tx('Delete failed:'))}
    onRename={(from, to) => void guarded(() => renameSave(from, to), tx('Rename failed:'))}
    onDownload={(name) => void guarded(async () => void (await downloadSave(name, campaigns)), tx('Download failed:'))}
    onUpload={(file) => void guarded(async () => void (await importSaveFile(file)), tx('Upload failed:'))}
    onCancel={() => (dialog = null)}
  />
{:else if dialog === 'preferences'}
  <PreferencesDialog {audioSettings} onAudioChange={changeAudio} showTipsToggle onClose={() => (dialog = null)} />
{:else if dialog === 'credits'}
  <CreditsScreen onClose={() => (dialog = null)} />
{:else if dialog === 'language'}
  <LanguageDialog onClose={() => (dialog = null)} />
{/if}

{#if notice}
  <div class="notice" role="status" data-testid="menu-notice">{notice}</div>
{/if}

<style>
  .error {
    position: fixed;
    top: 0.5rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 300;
    margin: 0;
    padding: 0.4rem 1rem;
    border-radius: 4px;
    background: rgba(60, 10, 10, 0.9);
    color: #ffb0b0;
    font-family: var(--font-ui);
  }
  .notice {
    position: fixed;
    bottom: 3rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 300;
    padding: 0.4rem 1rem;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.85);
    border: 1px solid #8a6a2e;
    color: #f1e6c8;
    font-family: var(--font-ui);
  }
</style>
