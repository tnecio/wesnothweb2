<script lang="ts">
  /**
   * Full-screen modal shown whenever `GameSession.pendingAdvancement` is
   * set -- a unit reached full XP and has 2+ real `advances_to=` options,
   * mirroring upstream's `unit_advancement_choice::query_user` human-
   * dialog branch (`actions/advancement.ts`'s own doc comment explicitly
   * scoped that out as "a UI concern", which this fills in). A unit with
   * exactly one option never reaches this dialog at all -- `GameSession`
   * advances it immediately, matching real Wesnoth (the dialog only
   * appears when there's an actual choice to make).
   *
   * Addresses bugs2.md's "unit advancement" item: this is the interactive
   * half of it, alongside `GameSession.chooseAdvancement`/
   * `processAdvancementQueue` and the new synthetic-campaigns/advancement/
   * debug scenario built to exercise it end-to-end.
   */
  import type { PendingAdvancement } from './gameSession.js';
  import { buildWeaponInfo } from './gameSession.js';

  let {
    pending,
    onChoose,
  }: {
    pending: PendingAdvancement | null;
    onChoose: (typeId: string) => void;
  } = $props();

  function rangeType(w: { range: string; type: string }): string {
    return `${w.range}, ${w.type}`;
  }
</script>

{#if pending}
  <div class="advancement-overlay">
    <div class="advancement-box">
      <div class="title">{pending.unit.name || pending.unit.type.name} has advanced! Choose a unit type to become:</div>
      <div class="options">
        {#each pending.options as option (option.id)}
          <button class="option" onclick={() => onChoose(option.id)}>
            <div class="option-name">{option.name}</div>
            <div class="option-stats">Level {option.level} &middot; {option.hitpoints} HP</div>
            {#if option.attacks.length > 0}
              <ul class="option-attacks">
                {#each option.attacks as atk (atk.name)}
                  {@const info = buildWeaponInfo(atk)}
                  <li>{info.name} {info.damage}&times;{info.numAttacks} ({rangeType(info)})</li>
                {/each}
              </ul>
            {/if}
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .advancement-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.55);
    font-family: sans-serif;
  }
  .advancement-box {
    max-width: 44rem;
    width: 90%;
    padding: 1.25rem;
    background: #23201a;
    border: 1px solid #4a4432;
    border-radius: 6px;
    color: #ddd;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6);
  }
  .title {
    font-weight: 700;
    color: #f1e6c8;
    margin-bottom: 1rem;
  }
  .options {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .option {
    flex: 1 1 12rem;
    text-align: left;
    font: inherit;
    color: inherit;
    padding: 0.6rem 0.8rem;
    border-radius: 4px;
    border: 1px solid #8a6a2e;
    background: #6a4a1e;
    cursor: pointer;
  }
  .option:hover {
    background: #7d571f;
  }
  .option-name {
    font-weight: 700;
    color: #f1e6c8;
  }
  .option-stats {
    font-size: 0.85rem;
    opacity: 0.85;
    margin: 0.2rem 0;
  }
  .option-attacks {
    margin: 0.3rem 0 0;
    padding-left: 1.1rem;
    font-size: 0.8rem;
  }
</style>
