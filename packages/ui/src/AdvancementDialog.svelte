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
   * Laid out like the real dialog (`gui/dialogs/unit_advance.cpp`, seen
   * against a screenshot of the original): the advancing unit fills a
   * detail column on the left -- portrait, name, type, level/alignment/
   * race, HP and XP, traits, weapons -- and the choices are a *list* on
   * the right that you select in and confirm with OK, not a row of
   * buttons that each commit immediately. Real, reported bug (bugs6.md):
   * the first version showed only the options, so a player had no way to
   * see what they were advancing *from*, and any click was final.
   *
   * The detail column deliberately mirrors `RecallDialog`'s, which shows
   * the same view-model (`SelectedUnitInfo`) in the same shape -- the two
   * dialogs are the same idea (pick a unit, see its details) and should
   * not drift apart.
   */
  import { imageUrl } from '@wesnothweb2/renderer';
  import type { PendingAdvancement } from './gameSession.js';
  import { raceDisplayName } from './gameSession.js';
  import { onPlainButton } from './commands.js';
  import Modal from './Modal.svelte';

  let {
    pending,
    onChoose,
  }: {
    pending: PendingAdvancement | null;
    onChoose: (typeId: string) => void;
  } = $props();

  let selectedTypeId = $state<string | null>(pending?.optionInfos[0]?.typeId ?? null);

  let selected = $derived(pending?.optionInfos.find((o) => o.typeId === selectedTypeId) ?? pending?.optionInfos[0] ?? null);

  function rangeType(w: { range: string; type: string }): string {
    return `${w.range}, ${w.type}`;
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (!pending) return;
    const options = pending.optionInfos;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const current = options.findIndex((o) => o.typeId === selectedTypeId);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      selectedTypeId = options[(Math.max(0, current) + step + options.length) % options.length]!.typeId;
    } else if (e.key === 'Enter' && !onPlainButton(e.target)) {
      e.preventDefault();
      if (selected) onChoose(selected.typeId);
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if pending}
  <Modal width="48rem" labelledBy="Unit advancement">
    {#snippet children()}
      <div class="title">Advance Unit</div>
      <div class="layout">
        <div class="detail">
          {#if pending.unitInfo.image}
            <img class="portrait" src={imageUrl(pending.unitInfo.image)} alt="" />
          {/if}
          <div class="name">{pending.unitInfo.name}</div>
          <div class="type-name">{pending.unitInfo.typeId}</div>
          <div class="subline">
            <span class="level">Lvl {pending.unitInfo.level}</span>
            <span class="alignment">{pending.unitInfo.alignment}</span>
            <span class="race">{raceDisplayName(pending.unitInfo.raceId)}</span>
          </div>
          <div class="stats">
            <span class="hp">HP: {pending.unitInfo.hp}/{pending.unitInfo.maxHp}</span>
            <span class="sep">|</span>
            <span class="xp">XP: {pending.unitInfo.xp}/{pending.unitInfo.maxXp}</span>
          </div>
          {#if pending.unitInfo.traits.length > 0}
            <div class="traits">Traits: {pending.unitInfo.traits.join(', ')}</div>
          {/if}
          {#if pending.unitInfo.attacks.length > 0}
            <div class="attacks">
              <div class="attacks-label">Attacks</div>
              <ul>
                <!-- Keyed by index, not atk.name -- see SidePanel.svelte's own comment (bugs4.md #9):
                     real units can have two same-named attacks (e.g. Peasant's melee + thrown "pitchfork"). -->
                {#each pending.unitInfo.attacks as atk, i (i)}
                  <li>
                    <span class="atk-name">{atk.name}</span>
                    <span class="atk-stats">{atk.damage}&times;{atk.numAttacks} {rangeType(atk)}</span>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        </div>

        <div class="choices">
          <div class="prompt">Choose which unit to advance to:</div>
          <ul class="option-list">
            {#each pending.optionInfos as option (option.typeId)}
              <li>
                <button
                  class="option"
                  class:selected={option.typeId === selected?.typeId}
                  data-list-option
                  onclick={() => (selectedTypeId = option.typeId)}
                  ondblclick={() => onChoose(option.typeId)}
                >
                  {#if option.image}<img class="option-icon" src={imageUrl(option.image)} alt="" />{/if}
                  <span class="option-text">
                    <span class="option-name">{option.name}</span>
                    <span class="option-stats">
                      Level {option.level} &middot; {option.hitpoints} HP
                      {#each option.attacks as atk, i (i)}
                        <span class="option-attack">{atk.damage}&times;{atk.numAttacks} {atk.name}</span>
                      {/each}
                    </span>
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        </div>
      </div>

      <div class="footer">
        <div class="spacer"></div>
        <button class="primary" data-autofocus disabled={!selected} onclick={() => selected && onChoose(selected.typeId)}>
          OK
        </button>
      </div>
    {/snippet}
  </Modal>
{/if}

<style>
  .title {
    font-size: 1.15rem;
    font-weight: 700;
    color: #e4c860;
    margin-bottom: 0.5rem;
  }
  .layout {
    display: flex;
    gap: 1rem;
    min-height: 14rem;
  }
  .detail {
    flex: 0 0 13rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .portrait {
    width: 100%;
    max-height: 7rem;
    object-fit: contain;
  }
  .name {
    font-size: 1.1rem;
    font-weight: 700;
    color: #f1e6c8;
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
  .attacks ul,
  .option-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .attacks li {
    font-size: 0.85rem;
  }
  .atk-name {
    font-weight: 700;
    margin-right: 0.35rem;
  }
  .choices {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .prompt {
    font-size: 0.9rem;
    opacity: 0.9;
  }
  .option-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .option {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    text-align: left;
    font: inherit;
    color: inherit;
    padding: 0.5rem 0.7rem;
    border-radius: 4px;
    border: 1px solid #4a4432;
    background: #1a2233;
    cursor: pointer;
  }
  .option.selected {
    background: #35411f;
    border-color: #ffd54a;
  }
  .option-icon {
    width: 3rem;
    height: 3rem;
    object-fit: contain;
    flex: 0 0 auto;
  }
  .option-text {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .option-name {
    font-weight: 700;
    color: #f1e6c8;
  }
  .option-stats {
    font-size: 0.8rem;
    opacity: 0.85;
  }
  .option-attack {
    margin-left: 0.5rem;
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  .spacer {
    flex: 1 1 auto;
  }
  button.primary {
    font: inherit;
    padding: 0.4rem 1.1rem;
    border-radius: 4px;
    border: 1px solid #4a8ab8;
    background: #2a5a86;
    color: #d7e8f5;
    cursor: pointer;
  }
  button.primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
