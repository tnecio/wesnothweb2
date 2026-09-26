<script lang="ts">
  import { imageUrl } from '@wesnothweb2/renderer';
  import type { RecruitOption, RecallOption, SelectedUnitInfo, HoveredHexInfo } from './gameSession.js';
  import { alignmentName, capitalizeFirst, damageTypeName, rangeName } from './i18n/gameText.js';
  import { fmt, t, th, tw, tx } from './i18n/locale.js';

  let {
    selected,
    inspected,
    statusMessage,
    log,
    recruitOptions,
    recallOptions,
    hoveredHexInfo = null,
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
    /** Phase 14: the real theme's "terrain under the cursor" strip -- see `GameSession.hoveredHexInfo`. */
    hoveredHexInfo?: HoveredHexInfo | null;
    onEndTurn: () => void;
  } = $props();

  /** "melee, blade" style label for a weapon's range/damage type -- addresses "UI is missing information about weapon type". */
  function rangeType(w: { range: string; type: string }): string {
    return `${rangeName(w.range)}, ${damageTypeName(w.type)}`;
  }

  /** Real convention: resistance is shown as a signed percentage relative to normal (100) -- e.g. a `resistance` of 80 (20% resistant) shows as "+20%", 130 (30% weak) as "-30%". */
  function resistanceLabel(resistance: number): string {
    const pct = 100 - resistance;
    return `${pct >= 0 ? '+' : ''}${pct}%`;
  }
</script>

<aside class="side-panel">
  <p class="status" dir="auto">{statusMessage}</p>

  {#if hoveredHexInfo}
    <!-- Phase 14: real theme's always-on "terrain under the cursor" strip. -->
    <p class="hover-terrain">
      {hoveredHexInfo.terrainName} ({hoveredHexInfo.x}, {hoveredHexInfo.y}){#if hoveredHexInfo.defensePercent !== null}
        &mdash; {th('Defense')}: {hoveredHexInfo.defensePercent}%{/if}
    </p>
  {/if}

  {#snippet unitInfo(info: SelectedUnitInfo)}
    <div class="portrait-row">
      {#if info.image}
        <img class="portrait" src={imageUrl(info.image)} alt="" />
      {/if}
      <div class="headline">
        <div class="name-row">
          <span class="unit-name" dir="auto">{info.name}</span>
          {#if info.statuses.length > 0}
            <span class="statuses">
              {#each info.statuses as status (status)}
                <span class="status-badge" title={status}>{status}</span>
              {/each}
            </span>
          {/if}
        </div>
        <div class="sub">{th('Level')} {info.level} {info.typeName} &middot; {info.raceName} &middot; {capitalizeFirst(alignmentName(info.alignment ?? 'neutral'))}</div>
        <div class="sub">{t('Side')} {info.side} &middot; ({info.x}, {info.y})</div>
      </div>
    </div>

    <div class="bar-row" title={tx('Hitpoints')}>
      <span class="bar-label">{t('HP')}</span>
      <div class="bar hp"><div class="bar-fill" style={`width: ${info.maxHp > 0 ? (100 * info.hp) / info.maxHp : 0}%`}></div></div>
      <span class="bar-value">{info.hp}/{info.maxHp}</span>
    </div>
    <div class="bar-row" title={tx('Experience')}>
      <span class="bar-label">{t('XP')}</span>
      <div class="bar xp"><div class="bar-fill" style={`width: ${info.maxXp > 0 ? (100 * info.xp) / info.maxXp : 0}%`}></div></div>
      <span class="bar-value">{info.xp}/{info.maxXp}</span>
    </div>
    <div class="bar-row" title={tx('Moves left')}>
      <span class="bar-label">{tw('MP')}</span>
      <div class="bar mp"><div class="bar-fill" style={`width: ${info.maxMoves > 0 ? (100 * info.movesLeft) / info.maxMoves : 0}%`}></div></div>
      <span class="bar-value">{info.movesLeft}/{info.maxMoves}</span>
    </div>

    <div>{th('Terrain')}: {info.terrainName} ({th('Defense')}: {info.defensePercent}%)</div>
    <div>{tx('Attacks left:')} {info.attacksLeft}</div>
    {#if info.traits.length > 0}
      <!-- Real character traits (e.g. strong, intelligent) -- addresses "no information about character traits in the unit infobox". -->
      <div>{t('Traits')}: {info.traits.join(', ')}</div>
    {/if}

    <!-- Real resistances tooltip -- addresses "no way to see a unit's resistances". -->
    <div class="resistances">
      <div class="attacks-label">{t('Resistances:')}</div>
      <div class="resistance-grid">
        {#each info.resistances as r (r.damageType)}
          <span class="resistance-cell" class:weak={r.resistance > 100} class:strong={r.resistance < 100}>
            {capitalizeFirst(damageTypeName(r.damageType))}: {resistanceLabel(r.resistance)}
          </span>
        {/each}
      </div>
    </div>

    {#if info.attacks.length > 0}
      <!-- Real weapon type/range/specials -- addresses "UI is missing information about weapon type/specials". -->
      <div class="attacks">
        <div class="attacks-label">{t('Attacks')}:</div>
        <ul>
          <!-- Keyed by index, NOT atk.name (bugs4.md #9): real units routinely have two attacks sharing
               one name (e.g. the real Peasant's melee + thrown "pitchfork", Drake Arbiter's twin "halberd"
               entries) -- keying by name threw a Svelte each_key_duplicate error selecting them, which
               broke this whole panel's reactivity for that click and looked like the unit couldn't be
               selected at all. -->
          {#each info.attacks as atk, i (i)}
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
        <div class="attacks-label">{t('Abilities:')}</div>
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
      <div class="role">{tx('(viewing)')}</div>
      {@render unitInfo(inspected)}
    </section>
  {/if}

  {#if !selected && !inspected && recruitOptions.length === 0 && recallOptions.length === 0}
    <p class="hint">
      {tx('Click one of your units to select it. The hexes it can move to are brightened and show its defense there, from red (poor) through yellow to green (good); adjacent enemies it can attack are marked red.')}
    </p>
  {/if}

  <section class="log">
    <h3>{tx('Log')}</h3>
    {#if log.length === 0}
      <p class="hint">{tx('Nothing has happened yet.')}</p>
    {:else}
      <ul>
        {#each log as entry, i (i)}
          <li dir="auto">{entry}</li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="turn-actions">
    <button class="primary" onclick={onEndTurn}>{t('End Turn')}</button>
  </section>
</aside>

<style>
  .side-panel {
    direction: ltr; /* Wesnoth does not mirror its GUI for right-to-left languages; text runs pick their own direction (dir="auto") */
    width: 20rem;
    flex: 0 0 auto;
    padding: 0.75rem 1rem;
    background: #1c1a16;
    color: #ddd;
    font-family: var(--font-ui);
    font-size: 0.85rem;
    overflow-y: auto;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  @media (max-width: 720px) {
    .side-panel {
      width: auto;
      max-height: 42vh;
    }
  }
  .status {
    margin: 0;
    color: #f1e6c8;
    font-style: italic;
  }
  .hover-terrain {
    margin: 0;
    padding: 0.3rem 0.5rem;
    background: #23201a;
    border: 1px solid #3a3628;
    border-radius: 4px;
    font-size: 0.8em;
    opacity: 0.85;
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
  .portrait-row {
    display: flex;
    gap: 0.6rem;
    align-items: flex-start;
    margin-bottom: 0.4rem;
  }
  .portrait {
    width: 3.2rem;
    height: 3.2rem;
    object-fit: contain;
    image-rendering: pixelated;
    flex: 0 0 auto;
    background: #14120e;
    border: 1px solid #3a3628;
    border-radius: 3px;
  }
  .headline {
    min-width: 0;
  }
  .name-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .unit-name {
    font-weight: 700;
    color: #f1e6c8;
    font-size: 0.95rem;
  }
  .statuses {
    display: inline-flex;
    gap: 0.25rem;
  }
  .status-badge {
    font-size: 0.7em;
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    background: #5a2a2a;
    color: #f1d0d0;
    text-transform: uppercase;
  }
  .sub {
    font-size: 0.8em;
    opacity: 0.75;
  }
  .bar-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0.2rem 0;
  }
  .bar-label {
    /* Wide enough for a translated label such as Arabic's two-word "hit points"; wraps between words, never inside one. */
    flex: 0 0 auto;
    width: 3.4rem;
    font-size: 0.75em;
    opacity: 0.7;
    overflow-wrap: normal;
    hyphens: manual;
  }
  .bar {
    flex: 1 1 auto;
    height: 0.5rem;
    background: #14120e;
    border: 1px solid #3a3628;
    border-radius: 3px;
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
  }
  .bar.hp .bar-fill {
    background: #5a9e4a;
  }
  .bar.xp .bar-fill {
    background: #4a7ea8;
  }
  .bar.mp .bar-fill {
    background: #a8964a;
  }
  .bar-value {
    width: 3.4rem;
    text-align: right;
    font-size: 0.8em;
    opacity: 0.85;
  }
  .resistances {
    margin-top: 0.35rem;
  }
  .resistance-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.15rem 0.5rem;
    margin-top: 0.15rem;
  }
  .resistance-cell {
    font-size: 0.8em;
  }
  .resistance-cell.weak {
    color: #d98a6a;
  }
  .resistance-cell.strong {
    color: #8ac48a;
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
