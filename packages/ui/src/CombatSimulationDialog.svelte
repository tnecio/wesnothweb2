<script lang="ts">
  /**
   * Phase 13: real Wesnoth's damage-calculation dialog
   * (`gui/dialogs/attack_predictions.cpp`) -- opened from `AttackDialog`'s
   * "Damage Calculations" button. Base/total damage, resistance, chance
   * to hit/escape unscathed, and the real post-exchange HP probability
   * distribution (`CombatantPreview.hpDist`, straight from
   * `attackPrediction.ts`'s `simulateCombat`) as a bar chart, per side.
   */
  import { hpColor } from '@wesnothweb2/renderer';
  import type { CombatantPreview } from './gameSession.js';
  import Modal from './Modal.svelte';
  import { damageTypeName } from './i18n/gameText.js';
  import { fmt, t, tx } from './i18n/locale.js';

  let {
    attacker,
    defender,
    onClose,
  }: {
    attacker: CombatantPreview;
    defender: CombatantPreview;
    onClose: () => void;
  } = $props();

  function cssColor(hp: number, maxHp: number): string {
    return '#' + hpColor(hp, maxHp).toString(16).padStart(6, '0');
  }

  /** Non-zero outcomes only, highest HP first -- matches real Wesnoth's own bar-chart ordering. */
  function outcomes(c: CombatantPreview): { hp: number; probability: number }[] {
    return c.hpDist
      .map((probability, hp) => ({ hp, probability }))
      .filter((o) => o.probability > 0.0005)
      .sort((a, b) => b.hp - a.hp);
  }

  function unscathedPercent(c: CombatantPreview): number {
    return Math.round((c.hpDist[c.hp] ?? 0) * 100 * 10) / 10;
  }

  function resistanceLabel(c: CombatantPreview): string | null {
    if (c.resistanceModifier === undefined || c.resistanceModifier === 100 || !c.weapon) return null;
    const factor = (c.resistanceModifier / 100).toFixed(1);
    const type = damageTypeName(c.weapon.type);
    return c.resistanceModifier > 100 ? fmt(tx('Vulnerability to $type ×$factor'), { type, factor }) : fmt(tx('Resistance to $type ×$factor'), { type, factor });
  }

  /**
   * Real, reported bug (bugs4.md #10): this dialog computed a fully
   * correct final damage/chance-to-hit, but never showed why -- no line
   * for a time-of-day bonus/penalty, an active leadership bonus, or a
   * charge/backstab doubling. These mirror the exact real inputs
   * `GameSession.buildPreview` already fed into the same combat math this
   * dialog displays the RESULT of -- a display-only breakdown.
   */
  function modifierLines(c: CombatantPreview): string[] {
    const lines: string[] = [];
    if (c.lawfulBonus !== 0) lines.push(fmt(tx('Time of day: $bonus|% damage'), { bonus: `${c.lawfulBonus > 0 ? '+' : ''}${c.lawfulBonus}` }));
    if (c.leadershipBonus !== 0) lines.push(fmt(tx('Leadership: +$bonus|% damage'), { bonus: c.leadershipBonus }));
    if (c.chargeActive) lines.push(tx('Charge: ×2 damage (both sides)'));
    if (c.backstabActive) lines.push(tx('Backstab: ×2 damage'));
    if (c.slowed) lines.push(tx('Slowed: / 2 damage'));
    return lines;
  }

  /** Real, reported bug (bugs4.md #10): `magical`/`marksman` override the chance to hit with a flat value, but nothing distinguished that from an ordinary terrain-defense roll. */
  function chanceToHitLabel(c: CombatantPreview): string {
    if (c.chanceToHitSource === 'magical') return `${c.chanceToHit}% (${tx('magical')})`;
    if (c.chanceToHitSource === 'marksman') return `${c.chanceToHit}% (${tx('marksman')})`;
    return `${c.chanceToHit}%`;
  }
</script>

<Modal title={t('Damage Calculations')} width="40rem" onClose={onClose}>
  {#snippet children()}
    <div class="columns">
      {#each [{ id: 'attacker', label: t('Attacker'), c: attacker }, { id: 'defender', label: t('Defender'), c: defender }] as side (side.id)}
        <div class="column">
          <div class="side-label">{side.label}</div>
          {#if side.c.weapon}
            <div class="line">
              <span class="label">{t('Base damage')}</span>
              <span class="value">{side.c.baseDamage} <em>({side.c.weapon.name})</em></span>
            </div>
            {#if resistanceLabel(side.c)}
              <div class="line">
                <span class="label">{resistanceLabel(side.c)}</span>
              </div>
            {/if}
            <div class="line total">
              <span class="label">{t('Total damage')}</span>
              <span class="value total-value">{side.c.damagePerBlow}&times;{side.c.numBlows}</span>
            </div>
            <div class="line">
              <span class="label">{t('Chance to hit')}</span>
              <span class="value hit">{chanceToHitLabel(side.c)}</span>
            </div>
            {#if side.c.weapon.specials.length > 0}
              <div class="specials-line">{side.c.weapon.specials.map((s) => s.name).join(', ')}</div>
            {/if}
            {#each modifierLines(side.c) as line (line)}
              <div class="modifier-line">{line}</div>
            {/each}
          {:else}
            <p class="hint">{t('No usable weapon')}</p>
          {/if}
          <!-- Upstream (attack_predictions.cpp) shows these for a weaponless side too: it still takes damage (bugs6.md). -->
          <div class="line">
            <span class="label">{t('Chance of being unscathed')}</span>
            <span class="value unscathed">{unscathedPercent(side.c)}%</span>
          </div>
          <div class="outcome-label">{tx('Expected result (HP)')}</div>
          <div class="outcomes">
            {#each outcomes(side.c) as o (o.hp)}
              <div class="outcome-row">
                <span class="hp-value">{o.hp}</span>
                <span class="bar-track">
                  <span class="bar-fill" style:width={`${Math.round(o.probability * 100)}%`} style:background={cssColor(o.hp, side.c.maxHp)}></span>
                </span>
                <span class="pct">{Math.round(o.probability * 1000) / 10}%</span>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    </div>
    <div class="footer">
      <button class="primary" onclick={onClose}>{t('Close')}</button>
    </div>
  {/snippet}
</Modal>

<style>
  .columns {
    display: flex;
    gap: 1.5rem;
  }
  .column {
    flex: 1 1 50%;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .side-label {
    font-size: 1.05rem;
    font-weight: 700;
    color: #e4c860;
    text-align: center;
    margin-bottom: 0.3rem;
  }
  .line {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.9rem;
  }
  .line.total {
    margin-top: 0.3rem;
    font-weight: 700;
  }
  .total-value {
    color: #6fd66f;
  }
  .hit {
    color: #6fd66f;
  }
  .unscathed {
    color: #e05a5a;
  }
  .value em {
    font-style: italic;
    opacity: 0.75;
  }
  .outcome-label {
    margin-top: 0.5rem;
    font-weight: 700;
    font-size: 0.9rem;
    opacity: 0.85;
  }
  .outcomes {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .outcome-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
  }
  .hp-value {
    width: 2rem;
    text-align: right;
    opacity: 0.85;
  }
  .bar-track {
    flex: 1 1 auto;
    height: 0.8rem;
    background: #1a1710;
    border: 1px solid #4a4432;
    border-radius: 2px;
    overflow: hidden;
  }
  .bar-fill {
    display: block;
    height: 100%;
  }
  .pct {
    width: 3rem;
    text-align: right;
    opacity: 0.85;
  }
  .hint {
    opacity: 0.7;
    font-size: 0.9rem;
  }
  .specials-line {
    font-size: 0.8rem;
    font-style: italic;
    opacity: 0.85;
    color: #c9a84a;
  }
  .modifier-line {
    font-size: 0.8rem;
    opacity: 0.85;
    color: #8ec9e8;
  }
  .footer {
    display: flex;
    justify-content: flex-end;
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
</style>
