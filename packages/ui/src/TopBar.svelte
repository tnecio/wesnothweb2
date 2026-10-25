<script lang="ts">
  /**
   * The top bar: upstream's `data/themes/default.cfg` `top-panel` -- its `themes/classic/menubar.png` strip, the
   * "Menu" and "Actions" menus on `button_menu/menu_button_copper_H20`, and the status reports (`reports.cpp`):
   * the playing side's flag and the turn, gold, villages (owned/known), units, upkeep and net income, each behind
   * its `themes/*.png` icon with upstream's tooltip. Both dropdowns render the `Command[]` `GameShell.svelte`
   * hands them (`commands.ts`), as `ContextMenu.svelte` does.
   *
   * Upstream draws the strip with `draw::tiled` at its own size, so it is never stretched: here it repeats
   * along the bar with its copper edge at the bottom, and a taller bar (a finger's 44px, a phone's wrapped
   * lines) is filled above with the strip's top rows. The menu buttons' frame is sliced (`border-image`) so
   * it keeps its corners at any size, and their labels are the page's text.
   *
   * Web-only: the mute switch (a page cannot play sound before the visitor asks, and visitors expect one);
   * no battery report (the device shows its own). The time of day is upstream's sidebar's (`TimeOfDayPanel`)
   * where there is room for it; on a phone it stays here, the one place that is always on screen.
   */
  import IpfImage from './images/IpfImage.svelte';
  import { ipfImageUrl } from './images/ipfImage.js';
  import { sideFlagRef } from './images/unitImageRef.js';
  import type { TimeOfDayEntry } from '@wesnothweb2/engine';
  import type { EconomyInfo } from './gameSession.js';
  import { formatHotkey, type Command } from './commands.js';
  import { ENGINE_IMAGES, GAME_IMAGES } from './gameData.js';
  import { fmt, t, tw, tx } from './i18n/locale.js';

  let {
    turnNumber = 1,
    activeSide,
    flagIcon = '',
    flagColor = undefined,
    scenarioTurnsLimit = null,
    timeOfDay = null,
    gold,
    economyInfo,
    menuCommands,
    actionCommands,
    muted = false,
    onToggleMute,
    collapsed = false,
    onToggleCollapsed,
  }: {
    turnNumber?: number;
    activeSide?: number;
    /** The playing side's `flag_icon=` (empty: the default flag) and colour range id. */
    flagIcon?: string;
    flagColor?: string;
    scenarioTurnsLimit?: number | null;
    /** Shown here only on a phone (see the component's doc comment). */
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
    /**
     * Phase 23: in the compact (phone) layout the status wraps onto as many lines as it needs, and
     * this collapses it to the essentials (turn, gold, time of day). Ignored on wider screens, where
     * everything fits on one line.
     */
    collapsed?: boolean;
    onToggleCollapsed?: () => void;
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

  const MENUBAR = 'themes/classic/menubar.png';
  /** The strip's rows above its copper edge (rows 22-26), to fill a bar taller than the strip's 27px. */
  let menubarFill = $state<string | null>(null);
  $effect(() => {
    let cancelled = false;
    void ipfImageUrl(`${MENUBAR}~CROP(0,0,833,22)`).then((url) => {
      if (!cancelled) menubarFill = url;
    });
    return () => {
      cancelled = true;
    };
  });
  const barBackground = $derived(
    [`url('${GAME_IMAGES}/core/images/${MENUBAR}') left bottom / auto repeat-x`, ...(menubarFill ? [`url('${menubarFill}') left top / auto repeat`] : []), '#1f1603'].join(', '),
  );
  const button = (state: string) => `url('${ENGINE_IMAGES}/buttons/button_menu/menu_button_copper_H20${state}@2x.png')`;

  /** `utils::half_signed_value` / `font::unicode_minus`: a negative figure with a real minus sign. */
  const signed = (n: number): string => (n < 0 ? `\u2212${-n}` : String(n));

  // Upstream's tooltips (`reports.cpp`), title and explanation.
  const turnTooltip = $derived(
    scenarioTurnsLimit !== null ? `${tw('Turn Number')}\n\n${tw('When the game exceeds the number of turns indicated by the second number, it will end.')}` : tw('Turn Number'),
  );
  const goldTooltip = $derived(`${tw('Gold')}\n\n${tw('The amount of gold currently available to recruit and maintain your army.')}`);
  const villagesTooltip = $derived(`${tw('Villages')}\n\n${tw('The fraction of known villages that your side has captured.')}`);
  const unitsTooltip = $derived(`${tw('Units')}\n\n${tw('The total number of units on your side.')}`);
  const upkeepTooltip = $derived(
    `${tw('Upkeep')}\n\n${tw('The expenses incurred at the end of every turn to maintain your army. The first number is the amount of gold that will be deducted. It is equal to the number of unit levels not supported by villages. The second is the total cost of upkeep, including that covered by villages — in other words, the amount of gold that would be deducted if you lost all villages.')}`,
  );
  const incomeTooltip = $derived(
    `${tw('Net Income')}\n\n${tw('The net amount of gold you gain or lose each turn, taking into account income from controlled villages and payment of upkeep.')}`,
  );
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleKeydown} />

<header
  class="top-bar"
  class:collapsed
  bind:this={barEl}
  style:background={barBackground}
  style:--menu-button={button('')}
  style:--menu-button-active={button('-active')}
  style:--menu-button-pressed={button('-pressed')}
>
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

  <!-- Each figure's name is there for screen readers (and reads "Gold 40" as text); the icon shows it. -->
  <div class="status">
    <span class="stat" data-stat="turn" title={turnTooltip}>
      {#if activeSide !== undefined}<IpfImage class="flag" src={sideFlagRef(flagIcon, flagColor)} />{/if}
      <span class="visually-hidden">{t('Turn')}</span>
      {turnNumber}{#if scenarioTurnsLimit !== null}/{scenarioTurnsLimit}{/if}
      {#if activeSide !== undefined}<span class="visually-hidden">{fmt(tx('(side $side)'), { side: activeSide })}</span>{/if}
    </span>
    <span class="stat" data-stat="gold" title={goldTooltip}>
      <IpfImage class="icon" src="themes/gold.png" />
      <span class="visually-hidden">{t('Gold')}</span>
      <span class:bad={gold < 0}>{signed(gold)}</span>
    </span>
    <span class="stat secondary" data-stat="villages" title={villagesTooltip}>
      <IpfImage class="icon" src="themes/villages.png" />
      <span class="visually-hidden">{t('Villages')}</span>
      {economyInfo.villagesOwned}/{economyInfo.villagesKnown}
    </span>
    <span class="stat secondary" data-stat="units" title={unitsTooltip}>
      <IpfImage class="icon" src="themes/units.png" />
      <span class="visually-hidden">{t('Units')}</span>
      {economyInfo.unitCount}
    </span>
    <span class="stat secondary" data-stat="upkeep" title={upkeepTooltip}>
      <IpfImage class="icon wide" src="themes/upkeep.png" />
      <span class="visually-hidden">{t('Upkeep')}</span>
      {economyInfo.upkeepCharged} ({economyInfo.upkeepTotal})
    </span>
    <span class="stat secondary" data-stat="income" title={incomeTooltip}>
      <IpfImage class="icon wide" src="themes/income.png" />
      <span class="visually-hidden">{t('Income')}</span>
      <span class:bad={economyInfo.netIncome < 0}>{signed(economyInfo.netIncome)}</span>
    </span>
    {#if timeOfDay && timeOfDay.id}
      <span class="stat tod" title="{t('Lawful Bonus:')} {timeOfDay.lawfulBonus >= 0 ? '+' : ''}{timeOfDay.lawfulBonus}%">
        {#if timeOfDay.image}
          <!-- Through the image path functions: Secrets of the Ancients' schedule crops one strip (`~CROP`). -->
          <IpfImage class="tod-icon" src={timeOfDay.image} />
        {/if}
        <span class="tod-name">{timeOfDay.name}</span>
      </span>
    {/if}
  </div>

  {#if onToggleMute}
    <button class="mute-button" class:muted title={muted ? tx('Unmute') : t('Mute')} aria-label={muted ? tx('Unmute') : t('Mute')} aria-pressed={muted} data-testid="mute-toggle" onclick={onToggleMute}>
      <svg viewBox="0 0 20 16" width="20" height="16" aria-hidden="true">
        <path d="M2 5.5h3.5L10 1.5v13L5.5 10.5H2z" fill="currentColor" />
        {#if muted}
          <path d="M13 5l5 6M18 5l-5 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" />
        {:else}
          <path d="M12.5 5.2a3.6 3.6 0 0 1 0 5.6M14.8 3a6.6 6.6 0 0 1 0 10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none" />
        {/if}
      </svg>
    </button>
  {/if}
  {#if onToggleCollapsed}
    <button
      class="collapse-toggle"
      aria-expanded={!collapsed}
      aria-label={collapsed ? tx('Show the full status') : tx('Show less of the status')}
      title={collapsed ? tx('Show the full status') : tx('Show less of the status')}
      data-testid="top-bar-toggle"
      onclick={onToggleCollapsed}>{collapsed ? '\u{25BE}' : '\u{25B4}'}</button
    >
  {/if}
</header>

<style>
  .top-bar {
    direction: ltr; /* Wesnoth does not mirror its GUI for right-to-left languages; text runs pick their own direction (dir="auto") */
    display: flex;
    align-items: center;
    min-height: 27px;
    color: #f1e6c8;
    font-family: var(--font-ui);
    font-size: 0.85rem;
    /* The strip's copper edge is its bottom 5 rows: the content sits above it. */
    padding-bottom: 5px;
    box-sizing: border-box;
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .menus {
    display: flex;
    flex: 0 0 auto;
    gap: 0;
    padding-left: 0;
  }
  .menu-group {
    position: relative;
  }
  /* `menu_button_copper_H20` (100x20): the frame sliced, so it keeps its corners at any width or height. */
  .menu-button {
    position: relative;
    min-width: 100px;
    height: 20px;
    margin-top: 1px;
    font: inherit;
    font-size: 0.9rem;
    line-height: 1;
    padding: 0 0.8rem;
    border: none;
    background: transparent;
    color: #fff;
    cursor: pointer;
    isolation: isolate;
  }
  .menu-button::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-style: solid;
    border-width: 4px;
    border-image: var(--menu-button) 8 fill / 4px stretch;
  }
  .menu-button:hover::before,
  .menu-button:focus-visible::before {
    border-image-source: var(--menu-button-active);
  }
  .menu-button:active::before,
  .menu-button.open::before {
    border-image-source: var(--menu-button-pressed);
  }
  .menu-button:focus-visible {
    outline: 1px solid #ffd54a;
    outline-offset: 1px;
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
    gap: 1.1rem;
    padding: 0 0.9rem;
    overflow-x: auto;
  }
  .stat {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .stat :global(.icon),
  .stat :global(.flag) {
    width: 16px;
    height: 16px;
    flex: none;
  }
  .stat :global(.icon.wide) {
    width: 24px;
  }
  .stat :global(.flag) {
    width: auto;
    height: 17px;
  }
  /* `font::BAD_COLOR`. */
  .bad {
    color: #ff0000;
  }
  /* The time of day is the sidebar's (`TimeOfDayPanel`), but for on a phone (below). */
  .tod {
    display: none;
    align-items: center;
    gap: 0.3rem;
  }
  .tod :global(.tod-icon) {
    width: 18px;
    height: 18px;
    object-fit: contain;
  }
  .mute-button {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 20px;
    margin: 1px 0.5rem 0;
    padding: 0 0.3rem;
    font: inherit;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 3px;
    color: #e4c860;
    cursor: pointer;
  }
  .mute-button:hover,
  .mute-button:focus-visible {
    border-color: #8a6a2e;
  }
  .mute-button.muted {
    color: #9c8f6c;
  }
  .collapse-toggle {
    display: none;
    font: inherit;
    font-size: 1.1rem;
    min-width: 2.75rem;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  /* While a [message] waits for a tap anywhere, the switch still works (it sits above the message's click catcher). */
  :global(:root:has(.wml-message-open)) .collapse-toggle {
    position: relative;
    z-index: 150;
  }
  /*
   * Phase 23, a finger: menus and their entries are at least 44 px tall. The menu buttons' art stays its own
   * 20px height, centred in the taller target.
   */
  @media (pointer: coarse) {
    .menu-button,
    .mute-button,
    .collapse-toggle,
    .dropdown button {
      min-height: 44px;
    }
    .menu-button {
      height: 44px;
      margin-top: 0;
    }
    .menu-button::before {
      inset: 12px 0;
    }
    .mute-button {
      min-width: 44px;
      margin-block: 0;
    }
  }
  /*
   * Phase 23, a phone: nothing scrolls sideways any more. The status wraps under the menus onto as
   * many lines as it needs (every figure stays readable), or collapses to the essentials. The time of
   * day is here, where it is always on screen (the infobox can be folded away).
   */
  @media (max-width: 720px), (max-height: 500px) {
    .top-bar {
      flex-wrap: wrap;
      position: relative;
    }
    .status {
      flex-wrap: wrap;
      column-gap: 0.9rem;
      row-gap: 0.2rem;
      padding: 0.3rem 0.6rem;
      overflow-x: visible;
    }
    .tod {
      display: inline-flex;
    }
    .collapsed .secondary {
      display: none;
    }
    .collapse-toggle {
      display: block;
    }
  }
  @media (max-width: 720px) {
    /* Portrait: the menus keep the first line and the status has a line (or more) of its own. */
    .status {
      order: 3;
      flex-basis: 100%;
    }
    .mute-button {
      margin-left: auto;
    }
    /* Collapsed, the essentials fit on the menus' line. */
    .collapsed .status {
      order: 0;
      flex: 1 1 0;
      flex-wrap: nowrap;
      overflow: hidden;
    }
    .collapsed .mute-button {
      margin-left: 0;
    }
    /* The icon says it; the name doesn't fit beside the menus. */
    .collapsed .tod-name {
      display: none;
    }
  }
</style>
