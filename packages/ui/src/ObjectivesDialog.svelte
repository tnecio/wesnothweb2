<script lang="ts">
  /**
   * Full-screen modal shown once at scenario start when the scenario's own
   * real `[objectives]` set anything non-`silent=` (see
   * `GameSession.scenarioObjectives`/`runStartupEvents`'s own doc
   * comments) -- real, reported bug (bugs3.md): this never existed at
   * all, so a player had no in-game way to see victory/defeat conditions
   * or gold-carryover terms. Mirrors real Wesnoth's own objectives
   * dialog's real section layout (Victory:/Defeat:/Gold carryover:/
   * Notes:, in that order, each only shown if non-empty) -- see
   * `objectives.ts`'s own doc comment for the `data/lua/wml/
   * objectives.lua` logic this renders, and what's deliberately not
   * ported (per-entry color/bullet overrides, `show_if`, re-opening the
   * dialog later from a menu).
   */
  import type { ScenarioObjectives } from '@wesnothweb2/engine';
  import { turnCounterSuffix, OBJECTIVE_COLOR } from '@wesnothweb2/engine';

  let {
    scenarioName,
    objectives,
    currentTurn,
    turnsLimit,
    onClose,
  }: {
    scenarioName: string;
    objectives: ScenarioObjectives;
    currentTurn: number;
    turnsLimit: number | null;
    onClose: () => void;
  } = $props();

  const winObjectives = $derived(objectives.objectives.filter((o) => o.condition === 'win'));
  const loseObjectives = $derived(objectives.objectives.filter((o) => o.condition === 'lose'));

  function turnSuffix(showTurnCounter: boolean): string {
    if (!showTurnCounter) return '';
    return turnCounterSuffix(currentTurn, turnsLimit ?? -1);
  }

  function goldCarryoverLine(entry: ScenarioObjectives['goldCarryover'][number]): string[] {
    const lines: string[] = [];
    if (entry.bonus !== undefined) {
      lines.push(entry.bonus ? 'Early finish bonus.' : 'No early finish bonus.');
    }
    if (entry.carryoverPercentage !== undefined) {
      lines.push(
        entry.carryoverPercentage === 0
          ? 'No gold carried over to the next scenario.'
          : `${entry.carryoverPercentage}% of gold carried over to the next scenario.`,
      );
    }
    return lines;
  }
</script>

<div class="objectives-overlay">
  <div class="objectives-box">
    <div class="scenario-name">{scenarioName}</div>
    {#if objectives.summary}
      <p class="summary">{objectives.summary}</p>
    {/if}

    {#if winObjectives.length > 0}
      <div class="section">
        <div class="section-label">{objectives.victoryLabel}</div>
        <ul>
          {#each winObjectives as obj, i (i)}
            <li style:color={OBJECTIVE_COLOR.win}>{obj.description}{turnSuffix(obj.showTurnCounter)}</li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if loseObjectives.length > 0}
      <div class="section">
        <div class="section-label">{objectives.defeatLabel}</div>
        <ul>
          {#each loseObjectives as obj, i (i)}
            <li style:color={OBJECTIVE_COLOR.lose}>{obj.description}{turnSuffix(obj.showTurnCounter)}</li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if objectives.goldCarryover.length > 0}
      <div class="section">
        <div class="section-label">{objectives.goldCarryoverLabel}</div>
        <ul>
          {#each objectives.goldCarryover as entry, i (i)}
            {#each goldCarryoverLine(entry) as line (line)}
              <li style:color={OBJECTIVE_COLOR.goldCarryover}>{line}</li>
            {/each}
          {/each}
        </ul>
      </div>
    {/if}

    {#if objectives.notes.length > 0}
      <div class="section">
        <div class="section-label">{objectives.notesLabel}</div>
        <ul>
          {#each objectives.notes as note (note)}
            <li style:color={OBJECTIVE_COLOR.note}>{note}</li>
          {/each}
        </ul>
      </div>
    {/if}

    <div class="footer">
      <button class="advance" onclick={onClose}>OK</button>
    </div>
  </div>
</div>

<style>
  .objectives-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.55);
    font-family: sans-serif;
  }
  .objectives-box {
    max-width: 32rem;
    width: 90%;
    max-height: 80vh;
    overflow-y: auto;
    padding: 1.25rem 1.5rem;
    background: #23201a;
    border: 1px solid #4a4432;
    border-radius: 6px;
    color: #ddd;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6);
  }
  .scenario-name {
    font-size: 1.2rem;
    font-weight: 700;
    color: #f1e6c8;
    margin-bottom: 0.5rem;
  }
  .summary {
    margin: 0 0 0.75rem;
    line-height: 1.4;
  }
  .section {
    margin-top: 1rem;
  }
  .section-label {
    font-weight: 700;
    color: #f1e6c8;
    margin-bottom: 0.3rem;
  }
  ul {
    margin: 0;
    padding-left: 1.3rem;
  }
  li {
    line-height: 1.4;
  }
  .footer {
    display: flex;
    justify-content: flex-end;
    margin-top: 1.25rem;
  }
  .advance {
    font: inherit;
    padding: 0.35rem 1.2rem;
    border-radius: 4px;
    border: 1px solid #8a6a2e;
    background: #6a4a1e;
    color: #f1e6c8;
    cursor: pointer;
  }
</style>
