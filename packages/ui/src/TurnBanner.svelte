<script lang="ts">
  /**
   * "Turn N -- Scenario Name -- Side X's turn -- [icon] Time of Day" banner.
   * `turnNumber` and `activeSide` are now driven live by `GameSession.
   * turnNumber`/`activeSide` (see `endTurn`) via `GameShell` -- this used to
   * be hardcoded to turn 1 with no side indicator before real end-turn
   * cycling existed. `timeOfDay` is the real `[time]` entry active this
   * turn (see `GameSession.currentTimeOfDay`) -- catalogue: "Status bar:
   * gold/villages/turn/ToD -- Top bar shows ... turn and ToD for the
   * viewing side."
   */
  import { imageUrl } from '@wesnothweb2/renderer';
  import type { TimeOfDayEntry } from '@wesnothweb2/engine';

  let {
    scenarioName,
    turnNumber = 1,
    activeSide,
    scenarioTurnsLimit = null,
    timeOfDay = null,
  }: {
    scenarioName: string;
    turnNumber?: number;
    /** Which side currently has the move -- omit to hide the "Side X's turn" segment. */
    activeSide?: number;
    /** The scenario's `turns=` limit, if it has one. */
    scenarioTurnsLimit?: number | null;
    /** The real `[time]` entry active this turn -- omit (or a scenario with no schedule at all, `id === ''`) to hide the ToD segment. */
    timeOfDay?: TimeOfDayEntry | null;
  } = $props();
</script>

<header class="turn-banner">
  <span class="turn">Turn {turnNumber}{#if scenarioTurnsLimit !== null}/{scenarioTurnsLimit}{/if}</span>
  <span class="sep">--</span>
  <span class="scenario">{scenarioName}</span>
  {#if activeSide !== undefined}
    <span class="sep">--</span>
    <span class="active-side">Side {activeSide}'s turn</span>
  {/if}
  {#if timeOfDay && timeOfDay.id}
    <span class="sep">--</span>
    <span class="tod" title="Lawful bonus: {timeOfDay.lawfulBonus >= 0 ? '+' : ''}{timeOfDay.lawfulBonus}%">
      {#if timeOfDay.image}
        <img class="tod-icon" src={imageUrl(timeOfDay.image)} alt="" />
      {/if}
      {timeOfDay.name}
    </span>
  {/if}
</header>

<style>
  .turn-banner {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: #23201a;
    color: #f1e6c8;
    font-family: sans-serif;
    border-bottom: 1px solid #4a4432;
  }
  .turn {
    font-weight: 700;
  }
  .sep {
    opacity: 0.5;
  }
  .scenario {
    font-style: italic;
  }
  .active-side {
    opacity: 0.85;
  }
  .tod {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    opacity: 0.85;
  }
  .tod-icon {
    width: 20px;
    height: 20px;
    object-fit: contain;
  }
</style>
