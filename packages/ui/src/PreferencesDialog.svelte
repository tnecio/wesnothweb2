<script lang="ts">
  /**
   * Preferences (`gui2::dialogs::preferences_dialog`): upstream's tab strip, each tab with the preferences
   * of upstream's own page the port has something to apply to (Phase 24; see `displayPrefs.ts` for each one
   * and its upstream name). General: scroll speed, Skip AI moves, Accelerated speed and its factor,
   * automatic moves, Turn prompt, the end-of-scenario saves and the auto-save limit. Hotkeys:
   * `HotkeysPanel`. Display: the accessibility settings (font size, orb colours; the port's), the tip of
   * the day (on the title screen), damage labels, team colour ellipses, the grid and map and water
   * animation. Sound: the audio settings. Advanced: the entries of `advanced_preferences.cfg` the port has,
   * in that file's order. Language keeps its own dialog, as upstream's does (a button on the title screen,
   * a menu entry in a game). Left out: the window, pixel scale and theme settings (the browser's),
   * standing and idle unit animations (units are drawn still between actions), planning mode, and the
   * multiplayer, add-on, editor, cache and logging settings.
   */
  import Modal from './Modal.svelte';
  import AccessibilityPanel from './AccessibilityPanel.svelte';
  import AudioPanel from './AudioPanel.svelte';
  import HotkeysPanel from './HotkeysPanel.svelte';
  import { menuPrefs } from './menu/menuPrefs.js';
  import { displayPrefs, TURBO_SPEEDS, type DisplayPrefs } from './displayPrefs.js';
  import { readSetting, writeSetting } from './persistence.js';
  import { DEFAULT_AUTO_SAVE_MAX, INFINITE_AUTO_SAVES } from './save/naming.js';
  import { t, tw } from './i18n/locale.js';
  import type { AudioSettings } from './audio/settings.js';

  type PreferencesTab = 'general' | 'hotkeys' | 'display' | 'sound' | 'advanced';

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
    { id: 'general', label: () => t('General') },
    { id: 'hotkeys', label: () => t('Hotkeys') },
    { id: 'display', label: () => t('Display') },
    { id: 'sound', label: () => t('Sound') },
    { id: 'advanced', label: () => t('Advanced') },
  ];

  let tab = $state<PreferencesTab>(initialTab);

  type BoolPref = { [K in keyof DisplayPrefs]: DisplayPrefs[K] extends boolean ? K : never }[keyof DisplayPrefs];

  /** `auto_save_max`, kept with the saves (Phase 26); read when the dialog opens. */
  let autoSaveMax = $state(DEFAULT_AUTO_SAVE_MAX);
  void readSetting('autoSaveMax', DEFAULT_AUTO_SAVE_MAX).then((v) => (autoSaveMax = v)).catch(() => {});
  function setAutoSaveMax(v: number): void {
    autoSaveMax = v;
    void writeSetting('autoSaveMax', v).catch(() => {});
  }

  function onTabKey(e: KeyboardEvent): void {
    const at = tabs.findIndex((x) => x.id === tab);
    const to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    tab = tabs[(to + tabs.length) % tabs.length]!.id;
    queueMicrotask(() => document.getElementById(`prefs-tab-${tab}`)?.focus());
  }
</script>

{#snippet check(key: BoolPref, label: string, title?: string, disabled = false)}
  <label class="check" {title}>
    <input
      type="checkbox"
      checked={displayPrefs.value[key]}
      {disabled}
      onchange={(e) => displayPrefs.update({ [key]: e.currentTarget.checked })}
      data-testid={`prefs-${key}`}
    />
    <span>{label}</span>
  </label>
{/snippet}

<Modal title={t('Preferences')} {onClose} width="36rem">
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
      {#if tab === 'general'}
        <label class="slider" title={t('Change the speed of scrolling around the map')}>
          <span>{t('Scroll speed:')}</span>
          <input
            type="range"
            min="1"
            max="100"
            step="1"
            value={displayPrefs.value.scrollSpeed}
            oninput={(e) => displayPrefs.update({ scrollSpeed: Number(e.currentTarget.value) })}
            data-testid="prefs-scroll-speed"
          />
          <span class="value">{displayPrefs.value.scrollSpeed}</span>
        </label>
        {@render check('skipAiMoves', t('Skip AI moves'), t('Do not animate AI units moving'))}
        {@render check('turbo', t('Accelerated speed'), t('Make units move and fight faster'))}
        <label class="slider indent" title={t('Speed at which unit moves and animations play when ‘Accelerated speed’ is enabled or when Shift is held down in-game')}>
          <span>{t('Acceleration factor:')}</span>
          <input
            type="range"
            min="0"
            max={TURBO_SPEEDS.length - 1}
            step="1"
            value={Math.max(0, TURBO_SPEEDS.indexOf(displayPrefs.value.turboSpeed))}
            oninput={(e) => displayPrefs.update({ turboSpeed: TURBO_SPEEDS[Number(e.currentTarget.value)] ?? 2 })}
            data-testid="prefs-turbo-speed"
          />
          <span class="value">{displayPrefs.value.turboSpeed}</span>
        </label>
        {@render check('disableAutoMoves', t('Disable automatic moves'), t('Do not allow automatic movements at the beginning of a turn'))}
        {@render check('turnDialog', t('Turn prompt'), t('Display a prompt at the beginning of your turn'))}
        {@render check('saveReplays', t('Save replays at the end of scenarios'), t('Save replays of games on victory in all modes and defeat in multiplayer'))}
        {@render check('deleteSaves', t('Delete auto-saves at the end of scenarios'), t('Delete previous auto-saves on victory in all modes and defeat in multiplayer'))}
        <label class="slider" title={t('Set maximum number of automatic saves to be retained')}>
          <span>{t('Maximum auto-saves:')}</span>
          <input
            type="range"
            min="0"
            max={INFINITE_AUTO_SAVES}
            step="1"
            value={autoSaveMax}
            oninput={(e) => setAutoSaveMax(Number(e.currentTarget.value))}
            data-testid="prefs-auto-save-max"
          />
          <span class="value">{autoSaveMax === INFINITE_AUTO_SAVES ? t('∞') : autoSaveMax}</span>
        </label>
      {:else if tab === 'hotkeys'}
        <HotkeysPanel />
      {:else if tab === 'display'}
        <AccessibilityPanel />
        {#if showTipsToggle}
          <label class="check" title={t('Show gameplay tips on the main menu')}>
            <input type="checkbox" checked={menuPrefs.showTips} onchange={(e) => menuPrefs.setShowTips(e.currentTarget.checked)} data-testid="prefs-show-tips" />
            <span>{t('Show tip of the day')}</span>
          </label>
        {/if}
        {@render check('floatingLabels', t('Combat damage indicators'), t('Show amount of damage inflicted or healed as fading labels above units'))}
        {@render check('showSideColors', t('Team color indicators'), t('Show a colored circle around the base of each unit to show which side it is on'))}
        {@render check('grid', t('Grid overlay'), t('Overlay a grid over the map'))}
        {@render check('animateMap', t('Animate map'), t('Display animated terrain graphics'))}
        {@render check('animateWater', t('Animate water'), t('Display animated water graphics (can be slow)'), !displayPrefs.value.animateMap)}
      {:else if tab === 'sound'}
        <AudioPanel settings={audioSettings} onChange={onAudioChange} />
      {:else}
        <!-- `advanced_preferences.cfg`, in its order: those the port has something to apply to. -->
        {@render check('askDelete', tw('Confirm deleting saves'))}
        {@render check('mouseScrolling', tw('Mouse scrolling'))}
        {@render check('showCombat', tw('Show combat'))}
        {@render check('scrollToAction', tw('Follow unit actions'), tw('Choose whether the map view should scroll to a unit when an action or move is animated'))}
        {@render check(
          'monteCarlo',
          tw('Allow damage calculation with Monte Carlo simulation'),
          tw('Allow the damage calculation window to simulate fights instead of using exact probability calculations'),
        )}
        {@render check('showAttackMissIndicator', tw('Show missed attack indicator'), tw('Display a visual indicator above a defender when an attack misses.'))}
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
  .slider {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.9rem;
  }
  .slider input {
    flex: 1 1 auto;
  }
  .slider.indent {
    margin-left: 1.6rem;
  }
  .slider .value {
    width: 2.5rem;
    text-align: right;
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
