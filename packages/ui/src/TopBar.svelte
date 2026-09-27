<script lang="ts">
  /**
   * Phase 14: real Wesnoth's top menu bar + status bar
   * (`data/themes/default.cfg`'s `[menu]`/`[status]` sections), replacing
   * the old plain-text `TurnBanner.svelte`. Two real, always-visible
   * dropdown menus (Menu: Save/Load; Actions: Recruit/Recall/Objectives/
   * End Turn -- the same actions `SidePanel.svelte`'s buttons and Phase 13's
   * dialogs already expose, now ALSO reachable from here, per the plan's
   * "every core action reachable from the menu bar" milestone) plus the
   * real status figures (turn, gold, villages, units, upkeep, income, time
   * of day) in one row.
   *
   * Now a real consumer of the shared `commands.ts` registry (see that
   * module's own doc comment): both dropdowns just render whatever
   * `Command[]` `GameShell.svelte` hands them, the same way
   * `ContextMenu.svelte`'s right-click menu does.
   */
  import { imageUrl } from '@wesnothweb2/renderer';
  import type { TimeOfDayEntry } from '@wesnothweb2/engine';
  import type { EconomyInfo } from './gameSession.js';
  import { formatHotkey, type Command } from './commands.js';
  import { fmt, t, tw, tx } from './i18n/locale.js';

  let {
    scenarioName,
    turnNumber = 1,
    activeSide,
    scenarioTurnsLimit = null,
    timeOfDay = null,
    gold,
    economyInfo,
    menuCommands,
    actionCommands,
    muted = false,
    onToggleMute,
  }: {
    scenarioName: string;
    turnNumber?: number;
    activeSide?: number;
    scenarioTurnsLimit?: number | null;
    timeOfDay?: TimeOfDayEntry | null;
    /**
     * The active side's LIVE current gold -- real, reported bug (bugs4.md
     * #6/#8): the status bar used to show `economyInfo.startGold` instead,
     * which is `Team.startGold` -- the side's gold AT SCENARIO START,
     * deliberately never updated afterward (see `EconomyInfo.startGold`'s
     * own doc comment) -- so recruiting/recalling/income never visibly
     * changed the number shown here at all, even though the real
     * underlying `team.gold` was correct the whole time (confirmed by
     * recruit validation, which reads `team.gold` directly and rejects a
     * recruit the stale display claimed was affordable).
     */
    gold: number;
    economyInfo: EconomyInfo;
    /** The "Menu" dropdown's commands (Save/Load, ...). */
    menuCommands: readonly Command[];
    /** The "Actions" dropdown's commands (Recruit/Recall/Objectives/End Turn, ...). */
    actionCommands: readonly Command[];
    /** Phase 19: whether all audio is muted, and the switch. */
    muted?: boolean;
    onToggleMute?: () => void;
  } = $props();

  let openMenu = $state<'menu' | 'actions' | null>(null);
  let barEl: HTMLElement | undefined = $state();

  function toggle(which: 'menu' | 'actions'): void {
    openMenu = openMenu === which ? null : which;
  }
  function run(action: () => void): void {
    action();
    openMenu = null;
  }

  function handleWindowClick(e: MouseEvent): void {
    if (openMenu && barEl && !barEl.contains(e.target as Node)) openMenu = null;
  }
  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') openMenu = null;
  }
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleKeydown} />

<header class="top-bar" bind:this={barEl}>
  <nav class="menus">
    <div class="menu-group">
      <button class="menu-button" class:open={openMenu === 'menu'} aria-haspopup="menu" aria-expanded={openMenu === 'menu'} onclick={() => toggle('menu')}>{tw('Menu')}</button>
      {#if openMenu === 'menu'}
        <div class="dropdown">
          {#each menuCommands as cmd (cmd.id)}
            <button disabled={!cmd.enabled} onclick={() => run(cmd.handler)}>
              <span class="entry-label">{cmd.label}</span>
              {#if cmd.hotkey}<span class="entry-hotkey">{formatHotkey(cmd.hotkey)}</span>{/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <div class="menu-group">
      <button class="menu-button" class:open={openMenu === 'actions'} aria-haspopup="menu" aria-expanded={openMenu === 'actions'} onclick={() => toggle('actions')}>{t('Actions')}</button>
      {#if openMenu === 'actions'}
        <div class="dropdown">
          {#each actionCommands as cmd (cmd.id)}
            <button disabled={!cmd.enabled} onclick={() => run(cmd.handler)}>
              <span class="entry-label">{cmd.label}</span>
              {#if cmd.hotkey}<span class="entry-hotkey">{formatHotkey(cmd.hotkey)}</span>{/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </nav>

  {#if onToggleMute}
    <button class="mute-button" class:muted title={muted ? tx('Unmute') : t('Mute')} aria-label={muted ? tx('Unmute') : t('Mute')} aria-pressed={muted} data-testid="mute-toggle" onclick={onToggleMute}>
      {muted ? '\u{1F507}' : '\u{1F50A}'}
    </button>
  {/if}

  <div class="status">
    <span class="stat" title={tx('Turn / turn limit')}>
      <span class="label">{t('Turn')}</span>
      {turnNumber}{#if scenarioTurnsLimit !== null}/{scenarioTurnsLimit}{/if}
      {#if activeSide !== undefined}<span class="dim">{fmt(tx('(side $side)'), { side: activeSide })}</span>{/if}
    </span>
    <span class="stat" title={t('Gold')}>
      <span class="label">{t('Gold')}</span>
      {gold}
    </span>
    <span class="stat" title={tx('Villages owned')}>
      <span class="label">{t('Villages')}</span>
      {economyInfo.villagesOwned}
    </span>
    <span class="stat" title={t('Units')}>
      <span class="label">{t('Units')}</span>
      {economyInfo.unitCount}
    </span>
    <span class="stat" title={tx('Upkeep charged (raw total)')}>
      <span class="label">{t('Upkeep')}</span>
      {economyInfo.upkeepCharged} <span class="dim">({economyInfo.upkeepTotal})</span>
    </span>
    <span class="stat" title={tx('Income next turn')}>
      <span class="label">{t('Income')}</span>
      {economyInfo.netIncome >= 0 ? '+' : ''}{economyInfo.netIncome}
    </span>
    {#if timeOfDay && timeOfDay.id}
      <span class="stat tod" title="{t('Lawful Bonus:')} {timeOfDay.lawfulBonus >= 0 ? '+' : ''}{timeOfDay.lawfulBonus}%">
        {#if timeOfDay.image}
          <img class="tod-icon" src={imageUrl(timeOfDay.image)} alt="" />
        {/if}
        {timeOfDay.name}
      </span>
    {/if}
    <span class="scenario-name">{scenarioName}</span>
  </div>
</header>

<style>
  .top-bar {
    direction: ltr; /* Wesnoth does not mirror its GUI for right-to-left languages; text runs pick their own direction (dir="auto") */
    display: flex;
    align-items: stretch;
    background: #23201a;
    color: #f1e6c8;
    font-family: var(--font-ui);
    font-size: 0.85rem;
    border-bottom: 1px solid #4a4432;
  }
  .mute-button {
    font: inherit;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: inherit;
    cursor: pointer;
    padding: 0.1rem 0.4rem;
  }
  .mute-button:hover {
    border-color: #4a8ab8;
  }
  .mute-button.muted {
    opacity: 0.6;
  }
  .menus {
    display: flex;
    flex: 0 0 auto;
    border-right: 1px solid #4a4432;
  }
  .menu-group {
    position: relative;
  }
  .menu-button {
    height: 100%;
    font: inherit;
    font-weight: 700;
    padding: 0.5rem 0.9rem;
    border: none;
    background: transparent;
    color: #f1e6c8;
    cursor: pointer;
  }
  .menu-button:hover,
  .menu-button.open {
    background: #35301f;
  }
  .dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 50;
    display: flex;
    flex-direction: column;
    min-width: 10rem;
    background: #1a1710;
    border: 1px solid #8a6a2e;
    border-radius: 0 0 4px 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    padding: 0.25rem 0;
  }
  .dropdown button {
    font: inherit;
    text-align: left;
    padding: 0.4rem 0.9rem;
    border: none;
    background: transparent;
    color: #eee;
    cursor: pointer;
  }
  .dropdown button:hover:not(:disabled) {
    background: #35301f;
  }
  /* Phase 15: label left, hotkey hint right, as real Wesnoth's menus show them. */
  .dropdown button {
    display: flex;
    gap: 1.5rem;
    align-items: baseline;
    justify-content: space-between;
    white-space: nowrap;
  }
  .entry-hotkey {
    color: #b8a066;
    font-size: 0.85em;
  }
  .dropdown button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .status {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0 0.9rem;
    overflow-x: auto;
  }
  .stat {
    display: inline-flex;
    align-items: baseline;
    gap: 0.3rem;
    white-space: nowrap;
  }
  .label {
    opacity: 0.65;
    font-size: 0.8em;
  }
  .dim {
    opacity: 0.6;
    font-size: 0.9em;
  }
  .tod {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .tod-icon {
    width: 18px;
    height: 18px;
    object-fit: contain;
  }
  .scenario-name {
    flex: 0 0 auto;
    white-space: nowrap;
    margin-left: auto;
    font-style: italic;
    opacity: 0.75;
  }
</style>
