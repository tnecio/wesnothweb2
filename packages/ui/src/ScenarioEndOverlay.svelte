<script lang="ts">
  /**
   * Full-screen, non-dismissable banner shown once `GameSession.
   * scenarioResult` latches (see `checkVictory`/`GameSession.
   * checkForGameEnd`) -- the scenario is over, win or lose. Unlike
   * `StoryViewer`/`MessageViewer` this has nothing to click through to:
   * `GameShell`'s `phase` only ever moves forward into `'ended'`, and
   * every `GameSession` mutator already no-ops once `scenarioResult` is
   * set, so this overlay is here purely to make that state visible rather
   * than leaving the player clicking a board that's silently stopped
   * responding.
   */
  let {
    result,
    turnNumber,
    gold,
  }: {
    result: 'victory' | 'defeat';
    turnNumber: number;
    gold: number;
  } = $props();
</script>

<div class="end-overlay" class:victory={result === 'victory'} class:defeat={result === 'defeat'}>
  <div class="end-content">
    <h1>{result === 'victory' ? 'Victory!' : 'Defeat...'}</h1>
    <p class="detail">
      {result === 'victory' ? 'The enemy has been vanquished.' : 'Your forces have fallen.'}
    </p>
    <p class="stats">Turn {turnNumber} &middot; {gold} gold</p>
    <p class="hint">Reload the page to play again.</p>
  </div>
</div>

<style>
  .end-overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.78);
    font-family: sans-serif;
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
</style>
