<script lang="ts">
  /**
   * Phase 13: real Wesnoth's recall dialog (`gui/dialogs/units_dialog.cpp`'s
   * `build_recall_dialog` -- the same underlying dialog as recruit, just
   * fed the recall list instead of the recruit list), replacing
   * `SidePanel.svelte`'s old inline recall section. Same placement
   * behavior as `RecruitDialog.svelte` -- see its own doc comment.
   */
  import { imageUrl } from '@wesnothweb2/renderer';
  import type { RecallOption } from './gameSession.js';
  import { raceDisplayName } from './gameSession.js';
  import Modal from './Modal.svelte';

  let {
    options,
    gold,
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
    return `${w.range}, ${w.type}`;
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
</script>

<Modal width="42rem" labelledBy="Recall unit" onClose={onCancel}>
  {#snippet children()}
    <div class="title">Recall Unit</div>
    <div class="layout">
      <div class="detail">
        {#if selected}
          {#if selected.image}
            <img class="portrait" src={imageUrl(selected.image)} alt="" />
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
              <button class="small" onclick={confirmRename}>OK</button>
            </div>
          {:else}
            <div class="name">{selected.name}</div>
          {/if}
          <div class="type-name">{selected.typeId}</div>
          <div class="subline">
            <span class="level">Lvl {selected.level}</span>
            <span class="alignment">{selected.alignment}</span>
            <span class="race">{raceDisplayName(selected.raceId)}</span>
          </div>
          <div class="stats">
            <span class="hp">HP: {selected.hp}/{selected.maxHp}</span>
            <span class="sep">|</span>
            <span class="moves">Moves: {selected.movesLeft}/{selected.maxMoves}</span>
            <span class="sep">|</span>
            <span class="xp">XP: {selected.xp}/{selected.maxXp}</span>
          </div>
          {#if selected.traits.length > 0}
            <div class="traits">Traits: {selected.traits.join(', ')}</div>
          {/if}
          {#if selected.attacks.length > 0}
            <div class="attacks">
              <div class="attacks-label">Attacks</div>
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
            <th>Type</th>
            <th>Name</th>
            <th>Lvl</th>
            <th>XP</th>
            <th>Traits</th>
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
              <td>{#if opt.image}<img class="thumb" src={imageUrl(opt.image)} alt="" />{/if}</td>
              <td>{opt.typeId} <span class="cost">{opt.cost}g</span></td>
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
      <button onclick={startRename} disabled={!selected}>Rename</button>
      <button onclick={handleDismiss} disabled={!selected}>Dismiss Unit</button>
      <div class="spacer"></div>
      <button
        class="primary"
        disabled={!selected || !selected.affordable}
        onclick={() => selected && onRecall(selected.index)}
      >
        Recall
      </button>
      <button onclick={onCancel}>Cancel</button>
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
  .portrait {
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
  .thumb {
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
</style>
