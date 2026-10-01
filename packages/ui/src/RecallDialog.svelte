<script lang="ts">
  /**
   * Phase 13: real Wesnoth's recall dialog (`gui/dialogs/units_dialog.cpp`'s
   * `build_recall_dialog` -- the same underlying dialog as recruit, just
   * fed the recall list instead of the recruit list), replacing
   * `SidePanel.svelte`'s old inline recall section. Same placement
   * behavior as `RecruitDialog.svelte` -- see its own doc comment.
   */
  import IpfImage from './images/IpfImage.svelte';
  import HelpButton from './help/HelpButton.svelte';
  import { helpBrowser } from './help/helpBrowser.svelte.js';
  import { unitImageRef } from './images/unitImageRef.js';
  import type { RecallOption } from './gameSession.js';
  import { alignmentName, damageTypeName, rangeName, raceName } from './i18n/gameText.js';
  import { fmt, t, th, tx } from './i18n/locale.js';
  import { onPlainButton } from './commands.js';
  import Modal from './Modal.svelte';

  let {
    options,
    onRecall,
    onDismiss,
    onRename,
    onCancel,
  }: {
    options: RecallOption[];
    gold: number;
    onRecall: (index: number) => void;
    onDismiss: (index: number) => void;
    onRename: (index: number, name: string) => void;
    onCancel: () => void;
  } = $props();

  let selectedIndex = $state(options[0]?.index ?? null);
  const selected = $derived(options.find((o) => o.index === selectedIndex) ?? options[0] ?? null);
  let renaming = $state(false);
  let renameValue = $state('');

  function rangeType(w: { range: string; type: string }): string {
    return `${rangeName(w.range)}, ${damageTypeName(w.type)}`;
  }

  function startRename(): void {
    if (!selected) return;
    renameValue = selected.name;
    renaming = true;
  }

  function confirmRename(): void {
    if (selected) onRename(selected.index, renameValue);
    renaming = false;
  }

  function handleDismiss(): void {
    if (!selected) return;
    const dismissedIndex = selected.index;
    onDismiss(dismissedIndex);
    // The list shrinks by one and every later index shifts down -- settle
    // on whatever now occupies this same position, or the new last entry.
    selectedIndex = null;
  }

  /**
   * Phase 15 H4: arrow keys walk the recall list, Enter recalls the
   * highlighted unit (`Modal` owns Escape/Tab/focus). Skipped while the
   * rename field has focus -- it has its own Enter/Escape handling --
   * and while a button has focus, whose own activation is what Enter
   * should do there.
   */
  function handleKeydown(e: KeyboardEvent): void {
    if (helpBrowser.isOpen) return; // The help opened from this dialog is on top and owns the keys.
    if (options.length === 0 || renaming) return;
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const current = options.findIndex((o) => o.index === selectedIndex);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = (Math.max(0, current) + step + options.length) % options.length;
      selectedIndex = options[next]!.index;
    } else if (e.key === 'Enter' && !onPlainButton(e.target)) {
      if (selected?.affordable) {
        e.preventDefault();
        onRecall(selected.index);
      }
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<Modal width="42rem" labelledBy={t('Recall Unit')} onClose={onCancel}>
  {#snippet children()}
    <div class="title">{t('Recall Unit')}</div>
    <div class="layout">
      <div class="detail">
        {#if selected}
          {#if selected.image}
            <IpfImage class="portrait" src={unitImageRef(selected.image)} />
          {/if}
          {#if renaming}
            <div class="rename-row">
              <input
                type="text"
                bind:value={renameValue}
                onkeydown={(e) => {
                  if (e.key === 'Enter') confirmRename();
                  if (e.key === 'Escape') renaming = false;
                }}
              />
              <button class="small" onclick={confirmRename}>{t('OK')}</button>
            </div>
          {:else}
            <div class="name">{selected.name}</div>
          {/if}
          <div class="type-name">{selected.typeName}</div>
          <div class="subline">
            <span class="level">{t('Lvl')} {selected.level}</span>
            <span class="alignment">{alignmentName(selected.alignment)}</span>
            <span class="race">{raceName(selected.raceId)}</span>
          </div>
          <div class="stats">
            <span class="hp">{t('HP:')} {selected.hp}/{selected.maxHp}</span>
            <span class="sep">|</span>
            <span class="moves">{th('Moves:')} {selected.movesLeft}/{selected.maxMoves}</span>
            <span class="sep">|</span>
            <span class="xp">{t('XP:')} {selected.xp}/{selected.maxXp}</span>
          </div>
          {#if selected.traits.length > 0}
            <div class="traits">{t('Traits')}: {selected.traits.join(', ')}</div>
          {/if}
          {#if selected.attacks.length > 0}
            <div class="attacks">
              <div class="attacks-label">{t('Attacks')}</div>
              <ul>
                <!-- Keyed by index, not atk.name -- see SidePanel.svelte's own comment (bugs4.md #9):
                     real units can have two same-named attacks (e.g. Peasant's melee + thrown "pitchfork"). -->
                {#each selected.attacks as atk, i (i)}
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
      <table class="recall-table">
        <thead>
          <tr>
            <th></th>
            <th>{t('Type')}</th>
            <th>{t('Name')}</th>
            <th>{t('Lvl')}</th>
            <th>{t('XP')}</th>
            <th>{t('Traits')}</th>
          </tr>
        </thead>
        <tbody>
          {#each options as opt (opt.index)}
            <tr
              class="row"
              class:selected={selectedIndex === opt.index}
              class:unaffordable={!opt.affordable}
              onclick={() => {
                selectedIndex = opt.index;
                renaming = false;
              }}
            >
              <td>{#if opt.image}<IpfImage class="thumb" src={unitImageRef(opt.image)} />{/if}</td>
              <td>{opt.typeName} <span class="cost">{fmt(tx('$amount|g'), { amount: opt.cost })}</span></td>
              <td>{opt.name}</td>
              <td>{opt.level}</td>
              <td class="xp-cell">{opt.xp}/{opt.maxXp}</td>
              <td class="traits-cell">{opt.traits.join(', ')}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="footer">
      <HelpButton disabled={!selected} onclick={() => selected && helpBrowser.openUnitType(selected.typeId)} />
      <button onclick={startRename} disabled={!selected}>{t('Rename')}</button>
      <button onclick={handleDismiss} disabled={!selected}>{t('Dismiss Unit')}</button>
      <div class="spacer"></div>
      <button
        class="primary"
        data-autofocus
        disabled={!selected || !selected.affordable}
        onclick={() => selected && onRecall(selected.index)}
      >
        {t('Recall')}
      </button>
      <button onclick={onCancel}>{t('Cancel')}</button>
    </div>
  {/snippet}
</Modal>

<style>
  .title {
    font-size: 1.15rem;
    font-weight: 700;
    color: #e4c860;
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
  /* on the <img> inside IpfImage, so reached through :global, still only within this component */
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
    font: inherit;
    background: #0e1420;
    border: 1px solid #4a4432;
    color: #eee;
    border-radius: 3px;
    padding: 0.15rem 0.3rem;
  }
  button.small {
    padding: 0.15rem 0.5rem;
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
  .attacks {
    margin-top: 0.3rem;
  }
  .attacks-label {
    font-weight: 700;
    opacity: 0.8;
    font-size: 0.85rem;
    margin-bottom: 0.2rem;
  }
  .attacks ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .atk-name {
    font-weight: 700;
    margin-right: 0.35rem;
  }
  .atk-stats {
    font-size: 0.85rem;
    opacity: 0.85;
  }
  .recall-table {
    flex: 1 1 auto;
    border-collapse: collapse;
    font-size: 0.85rem;
    max-height: 20rem;
    overflow-y: auto;
    display: block;
  }
  .recall-table thead,
  .recall-table tbody {
    display: table;
    width: 100%;
    table-layout: fixed;
  }
  .recall-table th {
    text-align: left;
    padding: 0.2rem 0.4rem;
    opacity: 0.7;
    font-weight: 700;
    border-bottom: 1px solid #4a4432;
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
  .row.unaffordable {
    opacity: 0.5;
  }
  .row td {
    padding: 0.25rem 0.4rem;
    border-bottom: 1px solid #241f1a;
  }
  /* on the <img> inside IpfImage, so reached through :global, still only within this component */
  * :global(.thumb) {
    width: 22px;
    height: 22px;
    object-fit: contain;
  }
  .cost {
    opacity: 0.7;
    font-size: 0.8em;
  }
  .traits-cell {
    font-size: 0.8em;
    opacity: 0.8;
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .spacer {
    flex: 1 1 auto;
  }
  button {
    font: inherit;
    padding: 0.4rem 1.1rem;
    border-radius: 4px;
    border: 1px solid #2f5a7a;
    background: #1a3350;
    color: #d7e8f5;
    cursor: pointer;
  }
  button.primary {
    background: #2a5a86;
    border-color: #4a8ab8;
  }
  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* Narrow (a phone, or a large font size): the detail pane goes above the list instead of squeezing it. */
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
