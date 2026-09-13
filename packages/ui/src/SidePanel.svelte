<script lang="ts">
  import type { RecruitOption, RecallOption, SelectedUnitInfo } from './gameSession.js';

  let {
    selected,
    inspected,
    statusMessage,
    log,
    recruitOptions,
    recallOptions,
    onEndTurn,
  }: {
    selected: SelectedUnitInfo | null;
    /** A unit clicked purely to view its info (any side) -- see `GameSession.inspectedUnit`. Shown alongside `selected`, addressing "no way to see information about enemy units". */
    inspected: SelectedUnitInfo | null;
    statusMessage: string;
    log: string[];
    /**
     * Real recruitable types for the selected leader's side, if it's
     * currently able to recruit -- see `GameSession.recruitOptions`. Only
     * its length is used here (to decide whether the "click a unit to
     * select it" hint should show instead) -- the real trigger now lives
     * in `TopBar.svelte`'s Actions menu (Phase 14: real Wesnoth's own
     * right-hand panel has no recruit/recall buttons of its own either,
     * only unit info/minimap/turn end).
     */
    recruitOptions: RecruitOption[];
    /** Same "length only" note as `recruitOptions`. */
    recallOptions: RecallOption[];
    onEndTurn: () => void;
  } = $props();

  /** "melee, blade" style label for a weapon's range/damage type -- addresses "UI is missing information about weapon type". */
  function rangeType(w: { range: string; type: string }): string {
    return `${w.range}, ${w.type}`;
  }
</script>

<aside class="side-panel">
  <p class="status">{statusMessage}</p>

  {#snippet unitInfo(info: SelectedUnitInfo)}
    <div>Type: {info.typeId}</div>
    <div>Side: {info.side}</div>
    <div>Position: ({info.x}, {info.y})</div>
    <div>Terrain: {info.terrainName} (Defense: {info.defensePercent}%)</div>
    <div>HP: {info.hp}/{info.maxHp}</div>
    <div>XP: {info.xp}/{info.maxXp}</div>
    <div>Moves left: {info.movesLeft}/{info.maxMoves}</div>
    <div>Attacks left: {info.attacksLeft}</div>
    {#if info.traits.length > 0}
      <!-- Real character traits (e.g. strong, intelligent) -- addresses "no information about character traits in the unit infobox". -->
      <div>Traits: {info.traits.join(', ')}</div>
    {/if}
    {#if info.attacks.length > 0}
      <!-- Real weapon type/range/specials -- addresses "UI is missing information about weapon type/specials". -->
      <div class="attacks">
        <div class="attacks-label">Attacks:</div>
        <ul>
          {#each info.attacks as atk (atk.name)}
            <li>
              <span class="name">{atk.name}</span>
              <span class="stats">{atk.damage}&times;{atk.numAttacks} ({rangeType(atk)})</span>
              {#if atk.specials.length > 0}
                <span class="specials" title={atk.specials.map((s) => s.description).join('\n\n')}>
                  {atk.specials.map((s) => s.name).join(', ')}
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    {#if info.abilities.length > 0}
      <!-- Real abilities (e.g. heals, skirmisher) -- addresses "UI is missing information about abilities". -->
      <div class="abilities">
        <div class="attacks-label">Abilities:</div>
        <ul>
          {#each info.abilities as ab (ab.name)}
            <li title={ab.description}>{ab.name}</li>
          {/each}
        </ul>
      </div>
    {/if}
  {/snippet}

  {#if selected}
    <section class="unit-info">
      <h3>{selected.name}</h3>
      {@render unitInfo(selected)}
    </section>
  {/if}

  {#if inspected}
    <!--
      A unit clicked purely to view its info -- friend or enemy, addresses
      "no way to see information about enemy units". Independent of
      `selected` (see GameSession.inspectedUnit's own doc comment): shown
      as its own section so it doesn't disturb the acting-unit display above.
    -->
    <section class="unit-info inspected">
      <h3>{inspected.name} <span class="role">(viewing)</span></h3>
      {@render unitInfo(inspected)}
    </section>
  {/if}

  {#if !selected && !inspected && recruitOptions.length === 0 && recallOptions.length === 0}
    <p class="hint">
      Click one of your units to select it. Blue hexes are where it can move;
      red hexes are adjacent enemies it can attack.
    </p>
  {/if}

  <section class="log">
    <h3>Log</h3>
    {#if log.length === 0}
      <p class="hint">Nothing has happened yet.</p>
    {:else}
      <ul>
        {#each log as entry, i (i)}
          <li>{entry}</li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="turn-actions">
    <button class="primary" onclick={onEndTurn}>End Turn</button>
  </section>
</aside>

<style>
  .side-panel {
    width: 20rem;
    flex: 0 0 auto;
    padding: 0.75rem 1rem;
    background: #1c1a16;
    color: #ddd;
    font-family: sans-serif;
    font-size: 0.85rem;
    overflow-y: auto;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .status {
    margin: 0;
    color: #f1e6c8;
    font-style: italic;
  }
  h3 {
    margin: 0 0 0.4rem;
    font-size: 0.95rem;
    color: #f1e6c8;
  }
  .unit-info {
    border: 1px solid #4a4432;
    border-radius: 4px;
    padding: 0.5rem 0.6rem;
    background: #23201a;
  }
  .unit-info div {
    margin: 0.15rem 0;
  }
  .unit-info.inspected {
    border-color: #6a4a4a;
  }
  .attacks,
  .abilities {
    margin-top: 0.35rem;
  }
  .attacks-label {
    opacity: 0.75;
    font-size: 0.85em;
  }
  .attacks ul,
  .abilities ul {
    list-style: none;
    margin: 0.15rem 0 0;
    padding: 0;
  }
  .attacks li,
  .abilities li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    align-items: baseline;
    padding: 0.1rem 0;
  }
  .attacks .name {
    font-weight: 700;
  }
  .attacks .stats {
    opacity: 0.85;
    font-size: 0.9em;
  }
  .specials {
    font-style: italic;
    opacity: 0.8;
    font-size: 0.85em;
  }
  .name {
    font-weight: 700;
  }
  .role {
    font-weight: 400;
    opacity: 0.7;
  }
  button {
    font: inherit;
    padding: 0.35rem 0.75rem;
    border-radius: 4px;
    border: 1px solid #4a4432;
    background: #2c2820;
    color: #eee;
    cursor: pointer;
  }
  button.primary {
    background: #6a4a1e;
    border-color: #8a6a2e;
  }
  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .log ul {
    margin: 0;
    padding-left: 1.1rem;
    max-height: 10rem;
    overflow-y: auto;
  }
  .log li {
    margin-bottom: 0.25rem;
  }
  .hint {
    opacity: 0.75;
    margin: 0;
  }
  .turn-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: auto;
    padding-top: 0.5rem;
    border-top: 1px solid #3a3628;
  }
  .turn-actions button {
    flex: 1 1 auto;
  }
</style>
