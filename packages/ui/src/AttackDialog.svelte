<script lang="ts">
  /**
   * Phase 13: real Wesnoth's attack-confirmation dialog
   * (`gui/dialogs/unit_attack.cpp`) -- side-by-side attacker/defender
   * comparison with a weapon-selection row, replacing `SidePanel.svelte`'s
   * old inline "Combat Prediction" section. Opens a nested
   * `CombatSimulationDialog` for the full damage-calculation breakdown,
   * matching real Wesnoth's own "Damage Calculations" button.
   */
  import { imageUrl } from '@wesnothweb2/renderer';
  import type { CombatPreview, CombatantPreview, AttackerWeaponOption } from './gameSession.js';
  import { raceDisplayName } from './gameSession.js';
  import Modal from './Modal.svelte';
  import CombatSimulationDialog from './CombatSimulationDialog.svelte';

  let {
    preview,
    attackerWeaponOptions,
    onConfirm,
    onCancel,
    onSelectAttackerWeapon,
  }: {
    preview: CombatPreview;
    attackerWeaponOptions: AttackerWeaponOption[];
    onConfirm: () => void;
    onCancel: () => void;
    onSelectAttackerWeapon: (index: number) => void;
  } = $props();

  let showSimulation = $state(false);

  function rangeType(w: { range: string; type: string }): string {
    return `${w.range}, ${w.type}`;
  }

  /**
   * Real, reported bug (bugs4.md #10): the confirmation dialog showed a
   * final chance-to-hit/damage with no indication of WHY -- no sign of a
   * time-of-day bonus/penalty, an active leadership bonus, a charge, or a
   * backstab, even though `buildPreview` (gameSession.ts) already computed
   * every one of these as a real input to the combat math it displays.
   * Short labels, not full detail -- `CombatSimulationDialog`'s "Damage
   * Calculations" breakdown is where a player goes for the full picture.
   */
  function modifierBadges(c: CombatantPreview): string[] {
    const badges: string[] = [];
    if (c.lawfulBonus !== 0) badges.push(`Time of day ${c.lawfulBonus > 0 ? '+' : ''}${c.lawfulBonus}%`);
    if (c.leadershipBonus !== 0) badges.push(`Leadership +${c.leadershipBonus}%`);
    if (c.chargeActive) badges.push('Charge ×2');
    if (c.backstabActive) badges.push('Backstab ×2');
    return badges;
  }

  /** Real, reported bug (bugs4.md #10): `magical`/`marksman` set a FLAT chance-to-hit override, but the dialog only ever showed the resulting number, with nothing distinguishing it from an ordinary terrain-defense roll. */
  function chanceToHitSuffix(c: CombatantPreview): string {
    if (c.chanceToHitSource === 'magical') return ' (magical)';
    if (c.chanceToHitSource === 'marksman') return ' (marksman)';
    return '';
  }
</script>

<Modal width="46rem" labelledBy="Attack" onClose={onCancel}>
  {#snippet children()}
    <div class="title">Attack Enemy</div>
    <div class="combatants">
      {#each [preview.attacker, preview.defender] as c, i (i)}
        <div class="combatant" class:defender={i === 1}>
          {#if c.image}
            <img class="portrait" src={imageUrl(c.image)} alt="" />
          {/if}
          <div class="name">{c.name}</div>
          <div class="type-name">{c.typeId}</div>
          <div class="subline">
            <span>Lvl {c.level}</span>
            <span>{c.alignment}</span>
            <span>{raceDisplayName(c.raceId)}</span>
          </div>
          {#if c.traits.length > 0}
            <div class="traits">{c.traits.join(', ')}</div>
          {/if}
          <div class="hp">HP: {c.hp}/{c.maxHp}</div>
        </div>
      {/each}
    </div>

    {#if attackerWeaponOptions.length > 1}
      <div class="weapon-choice">
        {#each attackerWeaponOptions as opt (opt.index)}
          <button
            class="weapon-option"
            class:selected={opt.selected}
            onclick={() => onSelectAttackerWeapon(opt.index)}
            title={opt.specials.length > 0 ? opt.specials.map((s) => s.name).join(', ') : undefined}
          >
            <span class="name">{opt.name}</span>
            <span class="stats">{opt.damage}&times;{opt.numAttacks} ({rangeType(opt)})</span>
          </button>
        {/each}
      </div>
    {/if}

    <div class="weapons-row">
      <div class="weapon-slot attacker-weapon">
        {#if preview.attacker.weapon}
          <div class="wname">{preview.attacker.weapon.name}</div>
          <div class="wstats">{preview.attacker.damagePerBlow}&times;{preview.attacker.numBlows} {rangeType(preview.attacker.weapon)}</div>
          <div class="wchance">{preview.attacker.chanceToHit}%{chanceToHitSuffix(preview.attacker)}</div>
          {#if preview.attacker.weapon.specials.length > 0}
            <div class="specials">{preview.attacker.weapon.specials.map((s) => s.name).join(', ')}</div>
          {/if}
          {#each modifierBadges(preview.attacker) as badge (badge)}
            <div class="modifier-badge">{badge}</div>
          {/each}
        {/if}
      </div>
      <div class="range-label">
        {preview.attacker.weapon ? rangeType(preview.attacker.weapon).split(',')[0] : ''}
      </div>
      <div class="weapon-slot defender-weapon">
        {#if preview.defender.weapon}
          <div class="wname">{preview.defender.weapon.name}</div>
          <div class="wstats">{preview.defender.damagePerBlow}&times;{preview.defender.numBlows} {rangeType(preview.defender.weapon)}</div>
          <div class="wchance">{preview.defender.chanceToHit}%{chanceToHitSuffix(preview.defender)}</div>
          {#if preview.defender.weapon.specials.length > 0}
            <div class="specials">{preview.defender.weapon.specials.map((s) => s.name).join(', ')}</div>
          {/if}
          {#each modifierBadges(preview.defender) as badge (badge)}
            <div class="modifier-badge">{badge}</div>
          {/each}
        {:else}
          <div class="hint">No counter-attack</div>
        {/if}
      </div>
    </div>

    <div class="footer">
      <button class="simulation" onclick={() => (showSimulation = true)}>Damage Calculations</button>
      <div class="spacer"></div>
      <button class="primary" onclick={onConfirm}>Attack</button>
      <button onclick={onCancel}>Cancel</button>
    </div>
  {/snippet}
</Modal>

{#if showSimulation}
  <CombatSimulationDialog attacker={preview.attacker} defender={preview.defender} onClose={() => (showSimulation = false)} />
{/if}

<style>
  .title {
    font-size: 1.15rem;
    font-weight: 700;
    color: #e4c860;
    text-align: center;
  }
  .combatants {
    display: flex;
    justify-content: space-around;
    gap: 1rem;
  }
  .combatant {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
    text-align: center;
    flex: 1 1 12rem;
  }
  .portrait {
    width: 4.5rem;
    height: 4.5rem;
    object-fit: contain;
  }
  .name {
    font-weight: 700;
    color: #f1e6c8;
  }
  .type-name {
    font-size: 0.8rem;
    opacity: 0.7;
  }
  .subline {
    display: flex;
    gap: 0.4rem;
    font-size: 0.8rem;
    opacity: 0.85;
    text-transform: capitalize;
  }
  .traits {
    font-size: 0.75rem;
    opacity: 0.75;
    font-style: italic;
  }
  .hp {
    font-size: 0.9rem;
    color: #6fd66f;
  }
  .weapon-choice {
    display: flex;
    gap: 0.4rem;
    justify-content: center;
  }
  .weapon-option {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.1rem;
    font: inherit;
    padding: 0.3rem 0.6rem;
    border-radius: 4px;
    border: 1px solid #4a4432;
    background: #1a2233;
    color: #eee;
    cursor: pointer;
  }
  .weapon-option.selected {
    border-color: #ffd54a;
    background: #35411f;
  }
  .weapon-option .name {
    font-weight: 700;
  }
  .weapon-option .stats {
    font-size: 0.8rem;
    opacity: 0.8;
  }
  .weapons-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-top: 1px solid #3a3628;
    border-bottom: 1px solid #3a3628;
  }
  .weapon-slot {
    flex: 1 1 40%;
    text-align: center;
  }
  .wname {
    font-weight: 700;
  }
  .wstats {
    font-size: 0.85rem;
    opacity: 0.85;
  }
  .wchance {
    color: #6fd66f;
    font-weight: 700;
  }
  .range-label {
    flex: 0 0 auto;
    opacity: 0.6;
    font-size: 0.8rem;
    font-style: italic;
  }
  .hint {
    opacity: 0.7;
    font-size: 0.85rem;
  }
  .specials {
    font-size: 0.75rem;
    font-style: italic;
    opacity: 0.8;
    color: #c9a84a;
  }
  .modifier-badge {
    font-size: 0.72rem;
    opacity: 0.85;
    color: #8ec9e8;
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
  button.simulation {
    background: #1a2233;
    border-color: #4a4432;
  }
</style>
