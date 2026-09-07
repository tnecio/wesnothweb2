<script lang="ts">
  import * as PIXI from 'pixi.js';
  import { SnapshotBoard, type ScenarioSnapshot } from '@wesnothweb2/renderer';

  let status = $state('loading scenario snapshot...');
  let canvasHost: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (!canvasHost) return;
    let app: PIXI.Application | undefined;
    let cancelled = false;

    (async () => {
      const res = await fetch('/scenario-snapshot.json');
      if (!res.ok) throw new Error(`fetch scenario-snapshot.json: ${res.status}`);
      const snapshot: ScenarioSnapshot = await res.json();
      if (cancelled) return;

      status = `${snapshot.scenario.name} — ${snapshot.units.length} units, ${snapshot.map.width}x${snapshot.map.height} hexes`;

      app = new PIXI.Application();
      await app.init({
        backgroundColor: 0x111111,
        resizeTo: canvasHost,
        antialias: true,
      });
      if (cancelled) {
        app.destroy();
        return;
      }
      canvasHost!.appendChild(app.canvas);

      const board = new SnapshotBoard(snapshot, { imageBaseUrl: '/game-images' });
      await board.render();
      app.stage.addChild(board.stage);

      // Center the board roughly in the viewport.
      const bounds = board.stage.getLocalBounds();
      board.stage.x = (app.screen.width - bounds.width) / 2 - bounds.x;
      board.stage.y = (app.screen.height - bounds.height) / 2 - bounds.y;
    })().catch((err) => {
      console.error(err);
      status = `failed to load: ${err instanceof Error ? err.message : String(err)}`;
    });

    return () => {
      cancelled = true;
      app?.destroy(true);
    };
  });
</script>

<main>
  <header>
    <h1>wesnothweb2</h1>
    <p>{status}</p>
  </header>
  <div class="board" bind:this={canvasHost}></div>
</main>

<style>
  :global(html, body) {
    margin: 0;
    height: 100%;
  }
  main {
    font-family: sans-serif;
    color: #eee;
    background: #181818;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  header {
    padding: 0.5rem 1rem;
    flex: 0 0 auto;
  }
  header h1 {
    margin: 0;
    font-size: 1.1rem;
  }
  header p {
    margin: 0.25rem 0 0;
    font-size: 0.85rem;
    color: #aaa;
  }
  .board {
    flex: 1 1 auto;
    min-height: 0;
  }
</style>
