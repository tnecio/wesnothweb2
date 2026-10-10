<script lang="ts">
  /**
   * The status table (`gui2::dialogs::game_stats`, `game_stats.cfg`, the `statustable` command, Alt+S): every
   * side not `hidden=`, as the viewing side sees it, in two tabs.
   *
   *  - Game Stats ("Current Status"): the leader (its sprite and name in the side's colour, `Unknown` and the
   *    unknown-unit sprite when it can be neither seen nor known), the controller, the team, and -- when the
   *    viewing side knows the side's economy (`team::knows_upkeep`) -- gold (left out for an enemy under the
   *    viewing side's fog), villages (`n/total` when the viewing side has neither fog nor shroud), units,
   *    upkeep and net income, negatives in red.
   *  - Scenario Settings: side number, starting gold, base income, gold and support per village, fog, shroud.
   *
   * Each column sorts. Scroll To (the dialog's OK) centres the map on the chosen side's leader.
   */
  import Modal from './Modal.svelte';
  import IpfImage from './images/IpfImage.svelte';
  import { unitImageRef } from './images/unitImageRef.js';
  import type { GameStatsRow } from './gameSession.js';
  import { t } from './i18n/locale.js';
  import { onPlainButton } from './commands.js';

  let {
    rows,
    sideColor,
    onScrollTo,
    onClose,
  }: {
    rows: readonly GameStatsRow[];
    /** `team::get_side_color`, as a CSS colour. */
    sideColor: (side: number) => string;
    onScrollTo: (side: number) => void;
    onClose: () => void;
  } = $props();

  type Tab = 'stats' | 'settings';
  let tab = $state<Tab>('stats');
  let sortKey = $state<string | null>(null);
  let ascending = $state(true);
  let selectedSide = $state<number | null>(null);

  /** `controller_name`: upstream's four controller names; a network side reads as a human one here. */
  function controllerName(row: GameStatsRow): string {
    switch (row.controller) {
      case 'ai':
      case 'network_ai':
        return t('controller^AI');
      case 'human':
      case 'network':
        return t('controller^Human');
      case 'reserved':
        return t('controller^Reserved');
      default:
        return t('controller^Idle');
    }
  }

  /** `utils::signed_value`: `+5`, `+0`, `−5`. */
  const signed = (n: number): string => (n < 0 ? `−${-n}` : `+${n}`);
  /** `utils::half_signed_value`: only a negative is signed, with the Unicode minus. */
  const halfSigned = (n: number): string => (n < 0 ? `−${-n}` : `${n}`);
  const yesNo = (b: boolean): string => (b ? t('yes') : t('no'));

  /** The two tabs' sorters (`set_sorters`), by column. */
  const sorters: Record<string, (r: GameStatsRow) => string | number> = {
    leader: (r) => r.leaderName,
    team: (r) => r.teamName,
    gold: (r) => r.gold ?? Number.NEGATIVE_INFINITY,
    villages: (r) => r.villages,
    units: (r) => r.units,
    upkeep: (r) => r.upkeep,
    income: (r) => r.netIncome,
    side: (r) => r.side,
    startGold: (r) => r.startGold,
    baseIncome: (r) => r.baseIncome,
    villageGold: (r) => r.villageGold,
    villageSupport: (r) => r.villageSupport,
    fog: (r) => Number(r.fog),
    shroud: (r) => Number(r.shroud),
  };

  let sorted = $derived.by(() => {
    const list = [...rows];
    const by = sortKey ? sorters[sortKey] : undefined;
    if (by) {
      list.sort((a, b) => {
        const x = by(a);
        const y = by(b);
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
        return ascending ? c : -c;
      });
    }
    return list;
  });

  let selected = $derived(sorted.find((r) => r.side === selectedSide) ?? sorted[0] ?? null);

  function sortBy(key: string): void {
    if (sortKey === key) ascending = !ascending;
    else {
      sortKey = key;
      ascending = true;
    }
  }

  function ariaSort(key: string): 'ascending' | 'descending' | 'none' {
    return sortKey === key ? (ascending ? 'ascending' : 'descending') : 'none';
  }

  function scrollTo(): void {
    if (selected) onScrollTo(selected.side);
  }

  /** Arrow keys walk the rows, Enter scrolls to the side's leader. */
  function handleKeydown(e: KeyboardEvent): void {
    if (sorted.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const at = sorted.findIndex((r) => r.side === selected?.side);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      selectedSide = sorted[(Math.max(0, at) + step + sorted.length) % sorted.length]!.side;
    } else if (e.key === 'Enter' && !onPlainButton(e.target)) {
      e.preventDefault();
      scrollTo();
    }
  }

  const statsColumns: [string, () => string][] = [
    ['team', () => t('Team')],
    ['gold', () => t('Gold')],
    ['villages', () => t('Villages')],
    ['units', () => t('Units')],
    ['upkeep', () => t('Upkeep')],
    ['income', () => t('Income')],
  ];
  const settingsColumns: [string, () => string][] = [
    ['side', () => t('Side')],
    ['startGold', () => t('Starting\nGold')],
    ['baseIncome', () => t('Base\nIncome')],
    ['villageGold', () => t('Gold Per\nVillage')],
    ['villageSupport', () => t('Support Per\nVillage')],
    ['fog', () => t('Fog')],
    ['shroud', () => t('Shroud')],
  ];
  let columns = $derived(tab === 'stats' ? statsColumns : settingsColumns);

  function cell(r: GameStatsRow, key: string): { text: string; negative?: boolean } {
    switch (key) {
      case 'team':
        return { text: r.teamName };
      case 'gold':
        return r.known && r.gold !== null ? { text: halfSigned(r.gold), negative: r.gold < 0 } : { text: '' };
      case 'villages':
        return { text: r.known ? (r.totalVillages !== null ? `${r.villages}/${r.totalVillages}` : String(r.villages)) : '' };
      case 'units':
        return { text: r.known ? String(r.units) : '' };
      case 'upkeep':
        return { text: r.known ? String(r.upkeep) : '' };
      case 'income':
        return r.known ? { text: signed(r.netIncome), negative: r.netIncome < 0 } : { text: '' };
      case 'side':
        return { text: String(r.side) };
      case 'startGold':
        return { text: String(r.startGold) };
      case 'baseIncome':
        return { text: String(r.baseIncome) };
      case 'villageGold':
        return { text: String(r.villageGold) };
      case 'villageSupport':
        return { text: String(r.villageSupport) };
      case 'fog':
        return { text: yesNo(r.fog) };
      case 'shroud':
        return { text: yesNo(r.shroud) };
      default:
        return { text: '' };
    }
  }

  let title = $derived(tab === 'stats' ? t('Current Status') : t('Scenario Settings'));
</script>

<svelte:window onkeydown={handleKeydown} />

<Modal width="52rem" labelledBy={title} {onClose}>
  {#snippet children()}
    <div class="title">{title}</div>
    <div class="tabs" role="tablist" aria-label={title}>
      <button role="tab" aria-selected={tab === 'stats'} class:on={tab === 'stats'} onclick={() => (tab = 'stats')} data-testid="game-stats-tab-stats">{t('Game Stats')}</button>
      <button role="tab" aria-selected={tab === 'settings'} class:on={tab === 'settings'} onclick={() => (tab = 'settings')} data-testid="game-stats-tab-settings">
        {t('Scenario Settings')}
      </button>
    </div>
    <div class="table-wrap">
      <table data-testid="game-stats">
        <thead>
          <tr>
            <th colspan="2" aria-sort={ariaSort('leader')}><button onclick={() => sortBy('leader')}>{t('Leader')}</button></th>
            {#each columns as [key, label] (key)}
              <th aria-sort={ariaSort(key)}><button onclick={() => sortBy(key)}>{label()}</button></th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each sorted as r (r.side)}
            <tr class:selected={selected?.side === r.side} onclick={() => (selectedSide = r.side)} ondblclick={() => onScrollTo(r.side)} data-testid={`game-stats-row-${r.side}`}>
              <td class="image">{#if r.leaderImage}<IpfImage class="leader" src={unitImageRef(r.leaderImage, r.side)} />{/if}</td>
              <td class="leader-name">
                <span style:color={sideColor(r.side)}>{r.leaderName}</span>
                <small class="controller">{controllerName(r)}</small>
              </td>
              {#each columns as [key] (key)}
                {@const c = cell(r, key)}
                <td class:negative={c.negative} data-testid={`game-stats-${key}-${r.side}`}>{c.text}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="footer">
      <div class="spacer"></div>
      <button class="primary" data-autofocus disabled={!selected} onclick={scrollTo} data-testid="game-stats-scroll-to">{t('Scroll To')}</button>
      <button onclick={onClose}>{t('Close')}</button>
    </div>
  {/snippet}
</Modal>

<style>
  .title {
    font-size: 1.15rem;
    font-weight: 700;
    color: #e4c860;
  }
  .tabs {
    display: flex;
    gap: 0.25rem;
    margin-top: 0.4rem;
    border-bottom: 1px solid #4a3d1e;
  }
  .tabs button {
    font: inherit;
    padding: 0.3rem 1rem;
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
  .table-wrap {
    max-height: 60vh;
    overflow: auto;
    margin-top: 0.4rem;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }
  th {
    position: sticky;
    top: 0;
    background: #131722;
    text-align: left;
    vertical-align: bottom;
    padding: 0.2rem 0.4rem;
    border-bottom: 1px solid #4a4432;
    white-space: pre-line;
  }
  th button {
    font: inherit;
    font-weight: 700;
    color: #e4c860;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    text-align: left;
    white-space: pre-line;
  }
  tbody tr {
    cursor: pointer;
  }
  tbody tr:hover {
    background: #1a2233;
  }
  tbody tr.selected {
    background: #35411f;
  }
  td {
    padding: 0.2rem 0.4rem;
    border-bottom: 1px solid #241f1a;
  }
  td.image {
    width: 48px;
  }
  * :global(.leader) {
    width: 48px;
    height: 48px;
    object-fit: contain;
  }
  .leader-name {
    display: flex;
    flex-direction: column;
  }
  .controller {
    color: #808080;
  }
  .negative {
    color: #ff0000;
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.6rem;
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
  .footer button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>
