<script lang="ts">
  import { fmt, t, tw, tx } from './i18n/locale.js';
  /**
   * Full-screen, non-dismissable banner shown once `GameSession.
   * scenarioResult` latches (see `checkVictory`/`GameSession.
   * checkForGameEnd`) -- the scenario is over, win or lose. Unlike
   * `StoryViewer`/`MessageViewer` this has nothing to click through to on
   * defeat (or a victory with no next scenario): `GameShell`'s `phase` only
   * ever moves forward into `'ended'`, and every `GameSession` mutator
   * already no-ops once `scenarioResult` is set, so the overlay is here
   * purely to make that state visible rather than leaving the player
   * clicking a board that's silently stopped responding.
   *
   * On a victory WITH a real next scenario (`nextScenarioAvailable`, from
   * `GameSession.nextScenarioId` -- the scenario's own real
   * `[scenario] next_scenario=`), a "Continue" button is shown instead of
   * the terminal "reload to play again" hint -- see `GameShell.svelte`'s
   * `continueToNextScenario`, which owns the actual fetch/transition this
   * button triggers via `onContinue`.
   */
  let {
    result,
    turnNumber,
    gold,
    nextScenarioAvailable,
    continuing,
    continueError,
    onContinue,
    onQuitToMenu = undefined,
  }: {
    result: 'victory' | 'defeat';
    turnNumber: number;
    gold: number;
    /** Whether this victory has a real `next_scenario=` to continue into. Always `false` on defeat. */
    nextScenarioAvailable: boolean;
    /** True while `onContinue`'s fetch/transition is in flight -- disables the button and shows a loading hint. */
    continuing: boolean;
    /** Set if the last `onContinue` attempt failed (e.g. the next snapshot's fetch failed) -- shown so the player can retry rather than being stuck silently. */
    continueError: string | null;
    onContinue: () => void;
    /** Back to the title screen. Offered when there is no way on (the campaign is over, or the scenario was lost). */
    onQuitToMenu?: () => void;
  } = $props();

  /** The way on: focused as the screen appears, so Enter continues without a mouse. */
  let continueButton: HTMLButtonElement | undefined = $state();
  let menuButton: HTMLButtonElement | undefined = $state();
  $effect(() => {
    (continueButton ?? menuButton)?.focus();
  });
</script>

<div class="end-overlay" class:victory={result === 'victory'} class:defeat={result === 'defeat'} role="alertdialog" aria-modal="true" aria-labelledby="end-title" aria-describedby="end-detail">
  <div class="end-content">
    <h1 id="end-title">{result === 'victory' ? tw('Victory') : tw('Defeat')}</h1>
    <p class="detail" id="end-detail">
      {result === 'victory' ? tx('The enemy has been vanquished.') : tx('Your forces have fallen.')}
    </p>
    <p class="stats">{fmt(tx('Turn $turn · $gold gold'), { turn: turnNumber, gold })}</p>
    {#if nextScenarioAvailable}
      <button class="continue" bind:this={continueButton} onclick={onContinue} disabled={continuing}>
        {continuing ? tx('Loading next scenario...') : tx('Continue to next scenario')}
      </button>
      {#if continueError}
        <p class="error">{tx('Failed to continue:')} {continueError}</p>
      {/if}
    {:else if onQuitToMenu}
      <button class="continue" bind:this={menuButton} onclick={onQuitToMenu} data-testid="end-quit-to-menu">{t('Quit to Menu')}</button>
    {:else}
      <p class="hint">{tx('Reload the page to play again.')}</p>
    {/if}
  </div>
</div>

<style>
  .end-overlay {
    direction: ltr; /* Wesnoth does not mirror its GUI for right-to-left languages; text runs pick their own direction (dir="auto") */
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.78);
    font-family: var(--font-ui);
    text-align: center;
  }
  .end-content {
    padding: 2rem 3rem;
    border-radius: 8px;
    background: #1a1712;
    border: 1px solid #4a4432;
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.6);
  }
  h1 {
    margin: 0 0 0.5rem;
    font-size: 2.5rem;
  }
  .victory h1 {
    color: #ffd54a;
  }
  .defeat h1 {
    color: #e23b3b;
  }
  .detail {
    margin: 0 0 1rem;
    color: #f1e6c8;
    font-size: 1.1rem;
  }
  .stats {
    margin: 0 0 1.5rem;
    color: #ccc;
  }
  .hint {
    margin: 0;
    color: #888;
    font-size: 0.85rem;
  }
  .continue {
    font: inherit;
    font-size: 1rem;
    padding: 0.5rem 1.25rem;
    border-radius: 4px;
    border: 1px solid #8a6a2e;
    background: #6a4a1e;
    color: #f1e6c8;
    cursor: pointer;
  }
  .continue:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .error {
    margin: 0.75rem 0 0;
    color: #e23b3b;
    font-size: 0.85rem;
    max-width: 24rem;
  }
</style>
