<script lang="ts">
  import { imageUrl } from '@wesnothweb2/renderer';
  import type { CombatPreview, RecruitOption, RecallOption, AttackerWeaponOption, SelectedUnitInfo, EconomyInfo } from './gameSession.js';

  let {
    selected,
    pendingPreview,
    attackerWeaponOptions,
    statusMessage,
    log,
    recruitOptions,
    pendingRecruitTypeId,
    recallOptions,
    pendingRecallIndex,
    turnNumber,
    scenarioTurnsLimit,
    activeSide,
    gold,
    economyInfo,
    onConfirmAttack,
    onCancelAttack,
    onSelectAttackerWeapon,
    onSelectRecruitType,
    onSelectRecallUnit,
    onEndTurn,
    onSave,
    onLoad,
  }: {
    selected: SelectedUnitInfo | null;
    pendingPreview: CombatPreview | null;
    /** The attacker's usable weapons against the current target -- see `GameSession.attackerWeaponOptions`. Empty unless `pendingPreview` is set. */
    attackerWeaponOptions: AttackerWeaponOption[];
    statusMessage: string;
    log: string[];
    /** Real recruitable types for the selected leader's side, if it's currently able to recruit -- see `GameSession.recruitOptions`. */
    recruitOptions: RecruitOption[];
    /** Which recruit type (if any) is armed, awaiting a click on a highlighted castle tile. */
    pendingRecruitTypeId: string | null;
    /** The selected leader's side's real recall list, if it's currently able to recruit/recall -- see `GameSession.recallOptions`. */
    recallOptions: RecallOption[];
    /** Which recall-list entry (if any, by `RecallOption.index`) is armed, awaiting a click on a highlighted castle tile. */
    pendingRecallIndex: number | null;
    turnNumber: number;
    /** The scenario's `turns=` limit, if it has one (null means unlimited). */
    scenarioTurnsLimit: number | null;
    activeSide: number;
    /** The active side's current gold. */
    gold: number;
    /** The active side's income/upkeep figures -- see `GameSession.economyInfo`. */
    economyInfo: EconomyInfo;
    onConfirmAttack: () => void;
    onCancelAttack: () => void;
    onSelectAttackerWeapon: (index: number) => void;
    onSelectRecruitType: (typeId: string) => void;
    onSelectRecallUnit: (index: number) => void;
    onEndTurn: () => void;
    onSave: () => void;
    onLoad: () => void;
  } = $props();

  function pct(fraction: number): string {
    return `${Math.round(fraction * 100)}%`;
  }
</script>

<aside class="side-panel">
  <section class="scenario-info">
    <div>Turn {turnNumber}{#if scenarioTurnsLimit !== null} / {scenarioTurnsLimit}{/if}</div>
    <div>Active side: {activeSide}</div>
    <div>Gold: {gold} <span class="hint-inline">(started with {economyInfo.startGold})</span></div>
    <div>
      Income next turn: {economyInfo.netIncome >= 0 ? '+' : ''}{economyInfo.netIncome}
      <span class="hint-inline">
        ({economyInfo.villagesOwned} village{economyInfo.villagesOwned === 1 ? '' : 's'} &times; {economyInfo.incomePerVillage}g)
      </span>
    </div>
  </section>

  <p class="status">{statusMessage}</p>

  {#if pendingPreview}
    <!--
      The real combat-prediction popup real Wesnoth shows before you commit
      to an attack -- fed directly by packages/engine's attackPrediction.ts
      (simulateCombat), not hand-waved numbers. See GameSession.buildPreview.
    -->
    <section class="prediction">
      <h3>Combat Prediction</h3>
      {#if attackerWeaponOptions.length > 1}
        <!--
          Real Wesnoth offers a weapon choice whenever the attacker has more
          than one usable weapon against this target (e.g. a Spearman's
          spear vs. javelin) -- previously this project always used weapon
          index 0 silently. See GameSession.attackerWeaponOptions/
          selectAttackerWeapon.
        -->
        <div class="weapon-choice">
          {#each attackerWeaponOptions as opt (opt.index)}
            <button
              class="weapon-option"
              class:selected={opt.selected}
              onclick={() => onSelectAttackerWeapon(opt.index)}
            >
              <span class="name">{opt.name}</span>
              <span class="stats">{opt.damage}&times;{opt.numAttacks}</span>
            </button>
          {/each}
        </div>
      {/if}
      <div class="combatant attacker">
        <div class="name">{pendingPreview.attacker.name} <span class="role">(attacker)</span></div>
        <div>HP {pendingPreview.attacker.hp}/{pendingPreview.attacker.maxHp}</div>
        <div>Chance to hit: {pendingPreview.attacker.chanceToHit}%</div>
        <div>Damage per blow: {pendingPreview.attacker.damagePerBlow} &times; {pendingPreview.attacker.numBlows} strikes</div>
        <div>Chance to die: {pct(pendingPreview.attacker.deathChance)}</div>
      </div>
      <div class="combatant defender">
        <div class="name">{pendingPreview.defender.name} <span class="role">(defender)</span></div>
        <div>HP {pendingPreview.defender.hp}/{pendingPreview.defender.maxHp}</div>
        <div>Chance to hit: {pendingPreview.defender.chanceToHit}%</div>
        <div>Damage per blow: {pendingPreview.defender.damagePerBlow} &times; {pendingPreview.defender.numBlows} strikes</div>
        <div>Chance to die: {pct(pendingPreview.defender.deathChance)}</div>
      </div>
      <div class="actions">
        <button class="primary" onclick={onConfirmAttack}>Attack</button>
        <button onclick={onCancelAttack}>Cancel</button>
      </div>
    </section>
  {:else}
    {#if selected}
      <section class="unit-info">
        <h3>{selected.name}</h3>
        <div>Type: {selected.typeId}</div>
        <div>Side: {selected.side}</div>
        <div>Position: ({selected.x}, {selected.y})</div>
        <div>HP: {selected.hp}/{selected.maxHp}</div>
        <div>Moves left: {selected.movesLeft}/{selected.maxMoves}</div>
        <div>Attacks left: {selected.attacksLeft}</div>
      </section>
    {/if}

    {#if recruitOptions.length > 0}
      <!--
        Real recruit list (packages/engine's actions/recruit.ts) -- cost/
        name/image come straight from snapshot.unitTypes, cross-referenced
        with the selected leader's team's real `recruit=`/canRecruit set.
        Shown whenever the selected unit is a leader standing on its keep
        with at least one vacant, keep-connected castle tile (see
        GameSession.computeRecruitTiles) -- addresses "can't recruit".
      -->
      <section class="recruit">
        <h3>Recruit</h3>
        <ul class="recruit-list">
          {#each recruitOptions as opt (opt.typeId)}
            <li>
              <button
                class="recruit-option"
                class:selected={pendingRecruitTypeId === opt.typeId}
                disabled={!opt.affordable}
                title={opt.affordable ? `Recruit ${opt.name}` : `Not enough gold (needs ${opt.cost}, have ${gold})`}
                onclick={() => onSelectRecruitType(opt.typeId)}
              >
                <span class="name">{opt.name}</span>
                <span class="cost">{opt.cost}g</span>
              </button>
            </li>
          {/each}
        </ul>
        {#if pendingRecruitTypeId}
          <p class="hint">Click a green-highlighted castle tile to place your recruit.</p>
        {:else}
          <p class="hint">Pick a unit type, then click a highlighted castle tile.</p>
        {/if}
      </section>
    {/if}

    {#if recallOptions.length > 0}
      <!--
        Real recall list (packages/engine's actions/recruit.ts's
        recallUnit, driven by carryover -- see GameSession.startNextScenario/
        computeCarryoverRecruits): every surviving unit carried over from a
        finished scenario, off-board until the player recalls it here. Same
        castle-tile-click placement flow as Recruit above, distinguished by
        GameSession.pendingRecallIndex being keyed by list position rather
        than unit type id (see RecallOption's own doc comment).
      -->
      <section class="recall">
        <h3>Recall</h3>
        <ul class="recruit-list">
          {#each recallOptions as opt, i (i)}
            <li>
              <button
                class="recruit-option"
                class:selected={pendingRecallIndex === opt.index}
                disabled={!opt.affordable}
                title={opt.affordable ? `Recall ${opt.name}` : `Not enough gold (needs ${opt.cost}, have ${gold})`}
                onclick={() => onSelectRecallUnit(opt.index)}
              >
                {#if opt.image}
                  <img class="unit-icon" src={imageUrl(opt.image)} alt="" />
                {/if}
                <span class="name">{opt.name} <span class="level">(lvl {opt.level}, {opt.hp}/{opt.maxHp} hp)</span></span>
                <span class="cost">{opt.cost}g</span>
              </button>
            </li>
          {/each}
        </ul>
        {#if pendingRecallIndex !== null}
          <p class="hint">Click a green-highlighted castle tile to place your recalled unit.</p>
        {:else}
          <p class="hint">Pick a unit to recall, then click a highlighted castle tile.</p>
        {/if}
      </section>
    {/if}

    {#if !selected && recruitOptions.length === 0 && recallOptions.length === 0}
      <p class="hint">
        Click one of your units to select it. Blue hexes are where it can move;
        red hexes are adjacent enemies it can attack.
      </p>
    {/if}
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
    <button onclick={onSave} title="Save to browser storage">Save</button>
    <button onclick={onLoad} title="Load from browser storage">Load</button>
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
  .scenario-info {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid #3a3628;
    font-size: 0.8rem;
    color: #cbbf9a;
  }
  .status {
    margin: 0;
    color: #f1e6c8;
    font-style: italic;
  }
  .hint-inline {
    opacity: 0.7;
    font-size: 0.9em;
  }
  h3 {
    margin: 0 0 0.4rem;
    font-size: 0.95rem;
    color: #f1e6c8;
  }
  .unit-info div,
  .combatant div {
    margin: 0.15rem 0;
  }
  .prediction {
    border: 1px solid #4a4432;
    border-radius: 4px;
    padding: 0.5rem 0.6rem;
    background: #23201a;
  }
  .combatant {
    padding: 0.3rem 0;
    border-top: 1px solid #3a3628;
  }
  .combatant:first-of-type {
    border-top: none;
  }
  .name {
    font-weight: 700;
  }
  .role {
    font-weight: 400;
    opacity: 0.7;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .recruit {
    border: 1px solid #4a4432;
    border-radius: 4px;
    padding: 0.5rem 0.6rem;
    background: #23201a;
  }
  .recruit-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .recruit-option {
    width: 100%;
    display: flex;
    justify-content: space-between;
    font: inherit;
    padding: 0.35rem 0.6rem;
    border-radius: 4px;
    border: 1px solid #4a4432;
    background: #2c2820;
    color: #eee;
    cursor: pointer;
  }
  .recruit-option.selected {
    border-color: #ffd54a;
    background: #4a3d1e;
  }
  .recruit-option .cost {
    opacity: 0.8;
  }
  .weapon-choice {
    display: flex;
    gap: 0.4rem;
    margin-bottom: 0.5rem;
  }
  .weapon-option {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.1rem;
    font: inherit;
    padding: 0.3rem 0.5rem;
    border-radius: 4px;
    border: 1px solid #4a4432;
    background: #2c2820;
    color: #eee;
    cursor: pointer;
  }
  .weapon-option.selected {
    border-color: #ffd54a;
    background: #4a3d1e;
  }
  .weapon-option .name {
    font-weight: 700;
  }
  .weapon-option .stats {
    font-size: 0.8rem;
    opacity: 0.8;
  }
  .recall {
    border: 1px solid #4a4432;
    border-radius: 4px;
    padding: 0.5rem 0.6rem;
    background: #23201a;
  }
  .unit-icon {
    width: 24px;
    height: 24px;
    object-fit: contain;
    flex: 0 0 auto;
  }
  .recall .recruit-option {
    align-items: center;
    gap: 0.5rem;
  }
  .recall .name {
    flex: 1 1 auto;
    text-align: left;
  }
  .level {
    font-weight: 400;
    opacity: 0.7;
    font-size: 0.8em;
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
