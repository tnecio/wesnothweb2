<script lang="ts">
  /**
   * Preferences (`gui2::dialogs::preferences_dialog`), the interim form (Phase 21): upstream's tab strip with
   * the tabs that have content today. Display holds the accessibility settings (font size, orb colours) and,
   * on the title screen, whether the tip of the day shows; Sound holds the audio settings. Phase 24 adds the
   * remaining tabs (general, hotkeys, advanced, ...) to this same dialog. Language keeps its own dialog, as
   * upstream's does (a button on the title screen, a menu entry in a game).
   */
  import Modal from './Modal.svelte';
  import AccessibilityPanel from './AccessibilityPanel.svelte';
  import AudioPanel from './AudioPanel.svelte';
  import { menuPrefs } from './menu/menuPrefs.js';
  import { t, tx } from './i18n/locale.js';
  import type { AudioSettings } from './audio/settings.js';

  type PreferencesTab = 'display' | 'sound';

  let {
    audioSettings,
    onAudioChange,
    onClose,
    initialTab = 'display',
    showTipsToggle = false,
  }: {
    audioSettings: Readonly<AudioSettings>;
    onAudioChange: (patch: Partial<AudioSettings>) => void;
    onClose: () => void;
    initialTab?: PreferencesTab;
    /** The title screen's tip panel is the only thing this controls, so a game leaves it out. */
    showTipsToggle?: boolean;
  } = $props();

  const tabs: ReadonlyArray<{ id: PreferencesTab; label: () => string }> = [
    { id: 'display', label: () => t('Display') },
    { id: 'sound', label: () => t('Sound') },
  ];

  let tab = $state<PreferencesTab>(initialTab);

  function onTabKey(e: KeyboardEvent): void {
    const at = tabs.findIndex((x) => x.id === tab);
    const to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    tab = tabs[(to + tabs.length) % tabs.length]!.id;
    queueMicrotask(() => document.getElementById(`prefs-tab-${tab}`)?.focus());
  }
</script>

<Modal title={t('Preferences')} {onClose} width="34rem">
  {#snippet children()}
    <div class="tabs" role="tablist" aria-label={t('Preferences')} tabindex="-1" onkeydown={onTabKey}>
      {#each tabs as x (x.id)}
        <button
          id={`prefs-tab-${x.id}`}
          role="tab"
          aria-selected={tab === x.id}
          aria-controls={`prefs-panel-${x.id}`}
          tabindex={tab === x.id ? 0 : -1}
          class:on={tab === x.id}
          data-autofocus={tab === x.id ? '' : undefined}
          data-testid={`prefs-tab-${x.id}`}
          onclick={() => (tab = x.id)}
        >{x.label()}</button>
      {/each}
    </div>

    <div class="panel" id={`prefs-panel-${tab}`} role="tabpanel" aria-labelledby={`prefs-tab-${tab}`}>
      {#if tab === 'display'}
        <AccessibilityPanel />
        {#if showTipsToggle}
          <label class="check">
            <input type="checkbox" checked={menuPrefs.showTips} onchange={(e) => menuPrefs.setShowTips(e.currentTarget.checked)} data-testid="prefs-show-tips" />
            <span>{tx('Show the tip of the day')}</span>
          </label>
        {/if}
      {:else}
        <AudioPanel settings={audioSettings} onChange={onAudioChange} />
      {/if}
    </div>

    <div class="footer">
      <div class="spacer"></div>
      <button class="primary" onclick={onClose} data-testid="prefs-close">{t('Close')}</button>
    </div>
  {/snippet}
</Modal>

<style>
  .tabs {
    display: flex;
    gap: 0.25rem;
    border-bottom: 1px solid #4a3d1e;
  }
  .tabs button {
    font: inherit;
    padding: 0.35rem 1.1rem;
    border: 1px solid transparent;
    border-bottom: 0;
    border-radius: 4px 4px 0 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .tabs button.on {
    border-color: #4a3d1e;
    background: #1a1712;
    color: #e4c860;
  }
  .panel {
    padding-top: 0.4rem;
    min-height: 14rem;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin-top: 0.9rem;
  }
  .footer {
    display: flex;
    margin-top: 0.4rem;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .footer button {
    font: inherit;
    padding: 0.4rem 1.1rem;
    border-radius: 4px;
    border: 1px solid #2f5a7a;
    background: #1a3350;
    color: #d7e8f5;
    cursor: pointer;
  }
  .footer button.primary {
    background: #2a5a86;
    border-color: #4a8ab8;
  }
</style>
