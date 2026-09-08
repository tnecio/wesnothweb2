<script lang="ts">
  /**
   * A static "Turn N -- Scenario Name" banner. Deliberately NOT driven by
   * real WML `[objectives]` parsing (that needs the WML event pump wired
   * into a turn-tracking play_controller equivalent, out of scope for this
   * phase per docs/IMPLEMENTATION_PLAN.md) -- this reads the scenario name
   * straight from the snapshot and always shows "Turn 1", matching the
   * single-implicit-turn scope `GameSession` itself implements (no
   * end-turn/AI-turn flow yet).
   */
  let { scenarioName, turnNumber = 1 }: { scenarioName: string; turnNumber?: number } = $props();
</script>

<header class="turn-banner">
  <span class="turn">Turn {turnNumber}</span>
  <span class="sep">--</span>
  <span class="scenario">{scenarioName}</span>
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
</style>
