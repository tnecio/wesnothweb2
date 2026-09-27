<script lang="ts">
  /**
   * Phase 13: real Wesnoth's recruit dialog (`gui/dialogs/units_dialog.cpp`'s
   * `build_recruit_dialog`) -- a unit-type list with cost/affordability and
   * a detail pane for the highlighted type, replacing `SidePanel.svelte`'s
   * old inline recruit section.
   *
   * Placement: if this dialog was opened by right-clicking a specific
   * empty castle tile, `GameShell.handleConfirmRecruit` places the chosen
   * unit there directly the instant "Recruit" is pressed (real, reported
   * bug, bugs4.md #5: making the player click that same, already-known
   * tile a SECOND time was pure friction). If opened with no specific
   * tile in mind (the top bar's Actions menu), it falls back to arming the
   * choice and waiting for the player to click one of the green-
   * highlighted castle tiles on the map -- there's no single tile to
   * prefer in that case.
   */
  import { imageUrl } from '@wesnothweb2/renderer';
  import type { RecruitOption } from './gameSession.js';
  import { alignmentName, damageTypeName, rangeName, raceName } from './i18n/gameText.js';
  import { fmt, t, th, tx } from './i18n/locale.js';
  import { onPlainButton } from './commands.js';
  import Modal from './Modal.svelte';

  let {
    options,
    gold,
    onRecruit,
    onCancel,
  }: {
    options: RecruitOption[];
    gold: number;
    onRecruit: (typeId: string) => void;
    onCancel: () => void;
  } = $props();

  let selectedTypeId = $state(options[0]?.typeId ?? null);
  const selected = $derived(options.find((o) => o.typeId === selectedTypeId) ?? options[0] ?? null);

  function rangeType(w: { range: string; type: string }): string {
    return `${rangeName(w.range)}, ${damageTypeName(w.type)}`;
  }

  /**
   * Phase 15 H4: arrow keys walk the type list and Enter recruits the
   * highlighted type, so the dialog needs no mouse. `Modal` already owns
   * Escape, Tab and the initial focus.
   *
   * Enter is ignored while a button has focus: that button's own
   * activation is what the player means (Cancel must cancel, not
   * recruit).
   */
  function handleKeydown(e: KeyboardEvent): void {
    if (options.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const current = options.findIndex((o) => o.typeId === selectedTypeId);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const next = (Math.max(0, current) + step + options.length) % options.length;
      selectedTypeId = options[next]!.typeId;
    } else if (e.key === 'Enter' && !onPlainButton(e.target)) {
      if (selected?.affordable) {
        e.preventDefault();
        onRecruit(selected.typeId);
      }
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<Modal width="34rem" labelledBy={t('Recruit Unit')} onClose={onCancel}>
  {#snippet children()}
    <div class="title">{t('Recruit Unit')}</div>
    <div class="layout">
      <div class="detail">
        {#if selected}
          {#if selected.image}
            <img class="portrait" src={imageUrl(selected.image)} alt="" />
          {/if}
          <div class="name">{selected.name}</div>
          <div class="subline">
            <span class="level">{t('Lvl')} {selected.level}</span>
            <span class="alignment">{alignmentName(selected.alignment)}</span>
            <span class="race">{raceName(selected.raceId)}</span>
          </div>
          <div class="stats">
            <span class="hp">{t('HP:')} {selected.hitpoints}</span>
            <span class="sep">|</span>
            <span class="moves">{th('Moves:')} {selected.moves}</span>
          </div>
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
                    {#if atk.specials.length > 0}
                      <span class="atk-specials">{atk.specials.map((s) => s.name).join(', ')}</span>
                    {/if}
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
          {#if selected.abilities.length > 0}
            <div class="abilities">
              {#each selected.abilities as ab (ab.name)}
                <span class="ability" title={ab.description}>{ab.name}</span>
              {/each}
            </div>
          {/if}
        {/if}
      </div>
      <ul class="type-list">
        {#each options as opt (opt.typeId)}
          <li>
            <button
              class="type-option"
              data-list-option
              class:selected={selectedTypeId === opt.typeId}
              class:unaffordable={!opt.affordable}
              title={opt.affordable ? undefined : fmt(tx('Not enough gold (needs $cost, have $gold)'), { cost: opt.cost, gold })}
              onclick={() => (selectedTypeId = opt.typeId)}
            >
              {#if opt.image}
                <img class="thumb" src={imageUrl(opt.image)} alt="" />
              {/if}
              <span class="opt-name">{opt.name}</span>
              <span class="opt-cost">{fmt(tx('$amount|g'), { amount: opt.cost })}</span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
    <div class="footer">
      <button
        class="primary"
        disabled={!selected || !selected.affordable}
        onclick={() => selected && onRecruit(selected.typeId)}
      >
        {t('Recruit')}
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
    gap: 0.35rem;
  }
  .portrait {
    width: 100%;
    max-height: 8rem;
    object-fit: contain;
  }
  .name {
    font-size: 1.1rem;
    font-weight: 700;
    color: #f1e6c8;
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
    gap: 0.4rem;
    font-size: 0.9rem;
  }
  .hp {
    color: #6fd66f;
  }
  .moves {
    color: #7ab8e8;
  }
  .sep {
    opacity: 0.4;
  }
  .attacks {
    margin-top: 0.4rem;
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
    gap: 0.25rem;
  }
  .atk-name {
    font-weight: 700;
    margin-right: 0.35rem;
  }
  .atk-stats {
    font-size: 0.9rem;
    opacity: 0.85;
  }
  .atk-specials {
    display: block;
    font-style: italic;
    font-size: 0.8rem;
    opacity: 0.75;
  }
  .abilities {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-top: 0.3rem;
  }
  .ability {
    font-size: 0.75rem;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    background: #2c2820;
    border: 1px solid #4a4432;
  }
  .type-list {
    flex: 1 1 auto;
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    overflow-y: auto;
    max-height: 20rem;
  }
  .type-option {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font: inherit;
    padding: 0.35rem 0.6rem;
    border-radius: 4px;
    border: 1px solid #4a4432;
    background: #1a2233;
    color: #eee;
    cursor: pointer;
  }
  .type-option.selected {
    border-color: #ffd54a;
    background: #35411f;
  }
  .type-option.unaffordable {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .thumb {
    width: 28px;
    height: 28px;
    object-fit: contain;
    flex: 0 0 auto;
  }
  .opt-name {
    flex: 1 1 auto;
    text-align: left;
  }
  .opt-cost {
    opacity: 0.8;
  }
  .footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
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
  @container (max-width: 33rem) {
    .layout {
      flex-direction: column;
      min-height: 0;
    }
    .detail {
      flex: 0 0 auto;
    }
  }
</style>
