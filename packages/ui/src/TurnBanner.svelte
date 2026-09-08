<script lang="ts">
  /**
   * "Turn N -- Scenario Name -- Side X's turn" banner. `turnNumber` and
   * `activeSide` are now driven live by `GameSession.turnNumber`/
   * `activeSide` (see `endTurn`) via `GameShell` -- this used to be
   * hardcoded to turn 1 with no side indicator before real end-turn
   * cycling existed.
   */
  let {
    scenarioName,
    turnNumber = 1,
    activeSide,
    scenarioTurnsLimit = null,
  }: {
    scenarioName: string;
    turnNumber?: number;
    /** Which side currently has the move -- omit to hide the "Side X's turn" segment. */
    activeSide?: number;
    /** The scenario's `turns=` limit, if it has one. */
    scenarioTurnsLimit?: number | null;
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
</style>
