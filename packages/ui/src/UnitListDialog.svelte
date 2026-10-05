<script lang="ts">
  /**
   * Phase 24: the Unit List (`units_dialog::build_unit_list_dialog`, `menu_handler::unit_list`, Alt+U):
   * the viewing side's units on the map in upstream's columns -- name, type, level, moves, HP, XP, status
   * and traits -- sortable by each but status, filtered by the search box (name, type, level, alignment,
   * race and traits), with the selected unit's details beside the list. "Scroll To" (the dialog's OK)
   * centres the map on the unit and selects it; Rename renames it, as upstream's does, outside the game's
   * recorded actions. Upstream 1.19's favourite star is not in the port.
   */
  import IpfImage from './images/IpfImage.svelte';
  import HelpButton from './help/HelpButton.svelte';
  import { helpBrowser } from './help/helpBrowser.svelte.js';
  import { unitImageRef } from './images/unitImageRef.js';
  import type { UnitListEntry } from './gameSession.js';
  import { alignmentName, damageTypeName, rangeName, raceName } from './i18n/gameText.js';
  import { t, th } from './i18n/locale.js';
  import { onPlainButton } from './commands.js';
  import Modal from './Modal.svelte';
  import { hpColor, xpColor } from '@wesnothweb2/renderer';

  let {
    units,
    onScrollTo,
    onRename,
    onClose,
  }: {
    units: readonly UnitListEntry[];
    onScrollTo: (x: number, y: number) => void;
    onRename: (x: number, y: number, name: string) => void;
    onClose: () => void;
  } = $props();

  type SortKey = 'name' | 'type' | 'level' | 'moves' | 'hp' | 'xp' | 'traits';
  let sortKey = $state<SortKey | null>(null);
  let ascending = $state(true);
  let filter = $state('');
  let selectedKey = $state<string | null>(null);
  let renaming = $state(false);
  let renameValue = $state('');

  const keyOf = (u: UnitListEntry): string => `${u.info.x},${u.info.y}`;
  const EN_DASH = '–';

  /** `units_dialog`'s sort functions: text columns by their text, the numbers as upstream orders them. */
  function sortValue(u: UnitListEntry, key: SortKey): string | number | [number, number] {
    switch (key) {
      case 'name':
        return u.info.name || EN_DASH;
      case 'type':
        return u.info.typeName;
      case 'level':
        return [u.info.level, -(u.info.maxXp - u.info.xp)];
      case 'moves':
        return u.info.movesLeft;
      case 'hp':
        return u.info.hp;
      case 'xp':
        return u.info.xp + u.info.maxXp;
      case 'traits':
        return u.info.traits.join(', ');
    }
  }

  function compare(a: UnitListEntry, b: UnitListEntry, key: SortKey): number {
    const x = sortValue(a, key);
    const y = sortValue(b, key);
    if (Array.isArray(x) && Array.isArray(y)) return x[0] - y[0] || x[1] - y[1];
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x).localeCompare(String(y));
  }

  /** `set_filter_generator`: every word must match one of the unit's keys. */
  function matches(u: UnitListEntry, words: readonly string[]): boolean {
    const keys = [u.info.typeName, u.info.name || EN_DASH, String(u.info.level), alignmentName(u.info.alignment ?? 'neutral'), u.info.raceName, ...u.info.traits].map((k) =>
      k.toLowerCase(),
    );
    return words.every((w) => keys.some((k) => k.includes(w)));
  }

  let rows = $derived.by(() => {
    const words = filter.toLowerCase().split(/\s+/).filter((w) => w !== '');
    const list = units.filter((u) => matches(u, words));
    if (sortKey) {
      const key = sortKey;
      list.sort((a, b) => compare(a, b, key) * (ascending ? 1 : -1));
    }
    return list;
  });

  let selected = $derived(rows.find((u) => keyOf(u) === selectedKey) ?? rows[0] ?? null);

  function sortBy(key: SortKey): void {
    if (sortKey === key) ascending = !ascending;
    else {
      sortKey = key;
      ascending = true;
    }
  }

  function ariaSort(key: SortKey): 'ascending' | 'descending' | 'none' {
    return sortKey === key ? (ascending ? 'ascending' : 'descending') : 'none';
  }

  function rangeType(w: { range: string; type: string }): string {
    return `${rangeName(w.range)}, ${damageTypeName(w.type)}`;
  }

  /** The XP column: `xp/max`, or an en dash for a unit that cannot advance. */
  function xpText(u: UnitListEntry): string {
    return u.canAdvance ? `${u.info.xp}/${u.info.maxXp}` : EN_DASH;
  }

  const css = (rgb: number): string => `#${rgb.toString(16).padStart(6, '0')}`;

  function scrollTo(): void {
    if (selected) onScrollTo(selected.info.x, selected.info.y);
  }

  function startRename(): void {
    if (!selected || selected.unrenamable) return;
    renameValue = selected.info.name;
    renaming = true;
  }

  function confirmRename(): void {
    if (selected) onRename(selected.info.x, selected.info.y, renameValue);
    renaming = false;
  }

  /** Arrow keys walk the list and Enter scrolls to the unit, as in the recall list. */
  function handleKeydown(e: KeyboardEvent): void {
    if (helpBrowser.isOpen || renaming || rows.length === 0) return;
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const current = rows.findIndex((u) => keyOf(u) === (selected ? keyOf(selected) : null));
      const step = e.key === 'ArrowDown' ? 1 : -1;
      selectedKey = keyOf(rows[(Math.max(0, current) + step + rows.length) % rows.length]!);
    } else if (e.key === 'Enter' && !onPlainButton(e.target)) {
      e.preventDefault();
      scrollTo();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<Modal width="56rem" labelledBy={t('Unit List')} {onClose}>
  {#snippet children()}
    <div class="title">{t('Unit List')}</div>
    <input class="filter" type="search" placeholder={t('Search for unit name, unit type name, unit level, or trait')} bind:value={filter} data-testid="unit-list-filter" />
    <div class="layout">
      <div class="detail">
        {#if selected}
          {@const u = selected.info}
          {#if u.image}
            <IpfImage class="portrait" src={unitImageRef(u.image, u.side)} />
          {/if}
          {#if renaming}
            <div class="rename-row">
              <input
                type="text"
                aria-label={t('Name:')}
                bind:value={renameValue}
                onkeydown={(e) => {
                  if (e.key === 'Enter') confirmRename();
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    renaming = false;
                  }
                }}
              />
              <button class="small" onclick={confirmRename}>{t('OK')}</button>
            </div>
          {:else}
            <div class="name">{u.name}</div>
          {/if}
          <div class="type-name">{u.typeName}</div>
          <div class="subline">
            <span>{t('Lvl')} {u.level}</span>
            <span>{alignmentName(u.alignment ?? 'neutral')}</span>
            <span>{raceName(u.raceId)}</span>
          </div>
          <div class="stats">
            <span class="hp">{t('HP:')} {u.hp}/{u.maxHp}</span>
            <span class="sep">|</span>
            <span class="moves">{th('Moves:')} {u.movesLeft}/{u.maxMoves}</span>
            <span class="sep">|</span>
            <span class="xp">{t('XP:')} {u.xp}/{u.maxXp}</span>
          </div>
          {#if u.traits.length > 0}
            <div class="traits">{t('Traits')}: {u.traits.join(', ')}</div>
          {/if}
          {#if u.attacks.length > 0}
            <div class="attacks">
              <div class="attacks-label">{t('Attacks')}</div>
              <ul>
                {#each u.attacks as atk, i (i)}
                  <li>
                    <span class="atk-name">{atk.name}</span>
                    <span class="atk-stats">{atk.damage}&times;{atk.numAttacks} {rangeType(atk)}</span>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        {/if}
      </div>
      <div class="table-wrap">
        <table class="unit-table" data-testid="unit-list">
          <thead>
            <tr>
              <th></th>
              <th aria-sort={ariaSort('name')}><button onclick={() => sortBy('name')}>{t('Name')}</button></th>
              <th aria-sort={ariaSort('type')}><button onclick={() => sortBy('type')}>{t('Type')}</button></th>
              <th aria-sort={ariaSort('level')}><button onclick={() => sortBy('level')}>{t('Lvl')}</button></th>
              <th aria-sort={ariaSort('moves')}><button onclick={() => sortBy('moves')}>{t('Moves')}</button></th>
              <th aria-sort={ariaSort('hp')}><button onclick={() => sortBy('hp')}>{t('HP')}</button></th>
              <th aria-sort={ariaSort('xp')}><button onclick={() => sortBy('xp')}>{t('XP')}</button></th>
              <th>{t('Status')}</th>
              <th aria-sort={ariaSort('traits')}><button onclick={() => sortBy('traits')}>{t('Traits')}</button></th>
            </tr>
          </thead>
          <tbody>
            {#each rows as u (keyOf(u))}
              <tr
                class="row"
                class:selected={selected !== null && keyOf(selected) === keyOf(u)}
                data-testid={`unit-list-row-${keyOf(u)}`}
                onclick={() => {
                  selectedKey = keyOf(u);
                  renaming = false;
                }}
                ondblclick={() => onScrollTo(u.info.x, u.info.y)}
              >
                <td>{#if u.info.image}<IpfImage class="thumb" src={unitImageRef(u.info.image, u.info.side)} />{/if}</td>
                <td>{u.info.name || EN_DASH}</td>
                <td>{u.info.typeName}</td>
                <td>{u.info.level}</td>
                <td>{u.info.movesLeft}/{u.info.maxMoves}</td>
                <td style:color={css(hpColor(u.info.hp, u.info.maxHp))}>{u.info.hp}/{u.info.maxHp}</td>
                <td style:color={u.canAdvance ? css(xpColor(u.info.maxXp - u.info.xp)) : undefined}>{xpText(u)}</td>
                <td>{#if u.statusImage}<IpfImage class="status" src={u.statusImage} />{/if}</td>
                <td class="traits-cell">{u.info.traits.join(', ')}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
    <div class="footer">
      <HelpButton disabled={!selected} onclick={() => selected && helpBrowser.openUnitType(selected.info.typeId, selected.info.variation)} />
      <button onclick={startRename} disabled={!selected || selected.unrenamable} data-testid="unit-list-rename">{t('Rename')}</button>
      <div class="spacer"></div>
      <button class="primary" data-autofocus disabled={!selected} onclick={scrollTo} data-testid="unit-list-scroll-to">{t('Scroll To')}</button>
      <button onclick={onClose}>{t('Cancel')}</button>
    </div>
  {/snippet}
</Modal>

<style>
  .title {
    font-size: 1.15rem;
    font-weight: 700;
    color: #e4c860;
  }
  .filter {
    width: 100%;
    box-sizing: border-box;
    margin: 0.4rem 0;
    font: inherit;
    padding: 0.2rem 0.4rem;
    background: #0e1420;
    color: inherit;
    border: 1px solid #4a4432;
    border-radius: 3px;
  }
  .layout {
    display: flex;
    gap: 1rem;
    min-height: 16rem;
  }
  .detail {
    flex: 0 0 12rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  * :global(.portrait) {
    width: 100%;
    max-height: 6rem;
    object-fit: contain;
  }
  .name {
    font-size: 1.1rem;
    font-weight: 700;
    color: #f1e6c8;
  }
  .rename-row {
    display: flex;
    gap: 0.3rem;
  }
  .rename-row input {
    flex: 1 1 auto;
    min-width: 0;
    font: inherit;
    background: #0e1420;
    border: 1px solid #4a4432;
    color: #eee;
    border-radius: 3px;
    padding: 0.15rem 0.3rem;
  }
  .type-name {
    font-size: 0.85rem;
    opacity: 0.7;
  }
  .subline {
    display: flex;
    gap: 0.5rem;
    font-size: 0.85rem;
    opacity: 0.85;
    text-transform: capitalize;
  }
  .stats {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    font-size: 0.85rem;
  }
  .hp {
    color: #6fd66f;
  }
  .moves {
    color: #7ab8e8;
  }
  .xp {
    color: #d6c86f;
  }
  .sep {
    opacity: 0.4;
  }
  .traits {
    font-size: 0.8rem;
    opacity: 0.8;
  }
  .attacks-label {
    font-weight: 700;
    opacity: 0.8;
    font-size: 0.85rem;
    margin: 0.3rem 0 0.2rem;
  }
  .attacks ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .atk-name {
    font-weight: 700;
    margin-right: 0.35rem;
  }
  .atk-stats {
    font-size: 0.85rem;
    opacity: 0.85;
  }
  .table-wrap {
    flex: 1 1 auto;
    max-height: 22rem;
    overflow: auto;
  }
  .unit-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }
  .unit-table th {
    position: sticky;
    top: 0;
    background: #131722;
    text-align: left;
    padding: 0.2rem 0.4rem;
    font-weight: 700;
    border-bottom: 1px solid #4a4432;
    white-space: nowrap;
  }
  .unit-table th button {
    font: inherit;
    font-weight: 700;
    color: inherit;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  .row {
    cursor: pointer;
  }
  .row:hover {
    background: #1a2233;
  }
  .row.selected {
    background: #35411f;
  }
  .row td {
    padding: 0.25rem 0.4rem;
    border-bottom: 1px solid #241f1a;
  }
  * :global(.thumb) {
    width: 24px;
    height: 24px;
    object-fit: contain;
  }
  * :global(.status) {
    width: 16px;
    height: 16px;
  }
  .traits-cell {
    font-size: 0.8em;
    opacity: 0.8;
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .spacer {
    flex: 1 1 auto;
  }
  button.small,
  .footer button {
    font: inherit;
    padding: 0.4rem 1.1rem;
    border-radius: 4px;
    border: 1px solid #2f5a7a;
    background: #1a3350;
    color: #d7e8f5;
    cursor: pointer;
  }
  button.small {
    padding: 0.15rem 0.5rem;
  }
  .footer button.primary {
    background: #2a5a86;
    border-color: #4a8ab8;
  }
  .footer button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* Narrow (a phone, or a large font size): the details go above the list. */
  @container (max-width: 41rem) {
    .layout {
      flex-direction: column;
      min-height: 0;
    }
    .detail {
      flex: 0 0 auto;
    }
  }
</style>
