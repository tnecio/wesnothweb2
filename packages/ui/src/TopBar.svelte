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
  import type { Command } from './commands.js';

  let {
    scenarioName,
    turnNumber = 1,
    activeSide,
    scenarioTurnsLimit = null,
    timeOfDay = null,
    economyInfo,
    menuCommands,
    actionCommands,
  }: {
    scenarioName: string;
    turnNumber?: number;
    activeSide?: number;
    scenarioTurnsLimit?: number | null;
    timeOfDay?: TimeOfDayEntry | null;
    economyInfo: EconomyInfo;
    /** The "Menu" dropdown's commands (Save/Load, ...). */
    menuCommands: readonly Command[];
    /** The "Actions" dropdown's commands (Recruit/Recall/Objectives/End Turn, ...). */
    actionCommands: readonly Command[];
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
      <button class="menu-button" class:open={openMenu === 'menu'} onclick={() => toggle('menu')}>Menu</button>
      {#if openMenu === 'menu'}
        <div class="dropdown">
          {#each menuCommands as cmd (cmd.id)}
            <button disabled={!cmd.enabled} onclick={() => run(cmd.handler)}>{cmd.label}</button>
          {/each}
        </div>
      {/if}
    </div>
    <div class="menu-group">
      <button class="menu-button" class:open={openMenu === 'actions'} onclick={() => toggle('actions')}>Actions</button>
      {#if openMenu === 'actions'}
        <div class="dropdown">
          {#each actionCommands as cmd (cmd.id)}
            <button disabled={!cmd.enabled} onclick={() => run(cmd.handler)}>{cmd.label}</button>
          {/each}
        </div>
      {/if}
    </div>
  </nav>

  <div class="status">
    <span class="stat" title="Turn / turn limit">
      <span class="label">Turn</span>
      {turnNumber}{#if scenarioTurnsLimit !== null}/{scenarioTurnsLimit}{/if}
      {#if activeSide !== undefined}<span class="dim">(side {activeSide})</span>{/if}
    </span>
    <span class="stat" title="Gold">
      <span class="label">Gold</span>
      {economyInfo.startGold}
    </span>
    <span class="stat" title="Villages owned">
      <span class="label">Villages</span>
      {economyInfo.villagesOwned}
    </span>
    <span class="stat" title="Units">
      <span class="label">Units</span>
      {economyInfo.unitCount}
    </span>
    <span class="stat" title="Upkeep charged (raw total)">
      <span class="label">Upkeep</span>
      {economyInfo.upkeepCharged} <span class="dim">({economyInfo.upkeepTotal})</span>
    </span>
    <span class="stat" title="Income next turn">
      <span class="label">Income</span>
      {economyInfo.netIncome >= 0 ? '+' : ''}{economyInfo.netIncome}
    </span>
    {#if timeOfDay && timeOfDay.id}
      <span class="stat tod" title="Lawful bonus: {timeOfDay.lawfulBonus >= 0 ? '+' : ''}{timeOfDay.lawfulBonus}%">
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
    display: flex;
    align-items: stretch;
    background: #23201a;
    color: #f1e6c8;
    font-family: sans-serif;
    font-size: 0.85rem;
    border-bottom: 1px solid #4a4432;
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
  .dropdown button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .status {
    flex: 1 1 auto;
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
    margin-left: auto;
    font-style: italic;
    opacity: 0.75;
  }
</style>
