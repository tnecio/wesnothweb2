<script lang="ts">
  /**
   * Owns the PixiJS canvas + SnapshotBoard instance for one game session.
   * Mirrors apps/web's original (pre-Phase-5) App.svelte mount pattern
   * (async PIXI.Application init inside a mount-only $effect, cleaned up on
   * destroy) -- see that effect's own comment for why reading `canvasHost`
   * synchronously and doing the async work inside a non-awaited IIFE keeps
   * this effect from re-running on every prop change (Svelte only tracks
   * *synchronous* reads made before an effect's first `await`/microtask
   * hop). Two small always-synchronous effects below handle re-rendering
   * units/highlights whenever the live game state changes.
   */
  import * as PIXI from 'pixi.js';
  import { SnapshotBoard, type ScenarioSnapshot, type HexPoint, type SnapshotUnit } from '@wesnothweb2/renderer';

  let {
    snapshot,
    units,
    selectedHex = null,
    reachable = [],
    attackTargets = [],
    onHexClick,
  }: {
    /** Static parts (terrain/teams/scenario/map) -- read once at mount, never re-applied after. */
    snapshot: ScenarioSnapshot;
    /** Live unit positions/HP -- re-applied to the board whenever this changes. */
    units: SnapshotUnit[];
    selectedHex?: HexPoint | null;
    reachable?: readonly HexPoint[];
    attackTargets?: readonly HexPoint[];
    onHexClick: (x: number, y: number) => void;
  } = $props();

  let canvasHost: HTMLDivElement | undefined = $state();
  let status = $state('loading scenario...');
  let board: SnapshotBoard | undefined;

  $effect(() => {
    if (!canvasHost) return;
    let app: PIXI.Application | undefined;
    let cancelled = false;

    (async () => {
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

      const newBoard = new SnapshotBoard(snapshot, { imageBaseUrl: '/game-images', onHexClick });
      await newBoard.render();
      if (cancelled) {
        app.destroy(true);
        return;
      }
      board = newBoard;
      app.stage.addChild(newBoard.stage);

      // Center the board roughly in the viewport.
      const bounds = newBoard.stage.getLocalBounds();
      newBoard.stage.x = (app.screen.width - bounds.width) / 2 - bounds.x;
      newBoard.stage.y = (app.screen.height - bounds.height) / 2 - bounds.y;

      status = `${snapshot.scenario.name} -- ${units.length} units, ${snapshot.map.width}x${snapshot.map.height} hexes`;
      // Apply whatever the current live state already is (props may have
      // settled before this async init finished) -- the effects below only
      // fire again on a *subsequent* change.
      await newBoard.updateUnits(units);
      newBoard.setHighlights({ selected: selectedHex, reachable, attackTargets });
    })().catch((err) => {
      console.error(err);
      status = `failed to load: ${err instanceof Error ? err.message : String(err)}`;
    });

    return () => {
      cancelled = true;
      app?.destroy(true);
    };
  });

  $effect(() => {
    const liveUnits = units;
    void board?.updateUnits(liveUnits);
  });

  $effect(() => {
    board?.setHighlights({ selected: selectedHex, reachable, attackTargets });
  });
</script>

<div class="board-view">
  <p class="status">{status}</p>
  <div class="canvas-host" bind:this={canvasHost}></div>
</div>

<style>
  .board-view {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .status {
    margin: 0;
    padding: 0.35rem 1rem;
    font-family: sans-serif;
    font-size: 0.8rem;
    color: #aaa;
    background: #181818;
  }
  .canvas-host {
    flex: 1 1 auto;
    min-height: 0;
  }
</style>
