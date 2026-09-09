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
   *
   * ## Pan/zoom (playability feedback: "no ability to scroll or zoom map")
   *
   * Implemented as plain DOM pointer/wheel listeners on `canvasHost` that
   * directly mutate `board.stage.x/y/scale`, NOT PixiJS's own federated
   * event system -- panning needs to work over empty/background canvas
   * area, not just over interactive hex `Graphics` objects, and mixing a
   * drag gesture with SnapshotBoard's existing per-hex `pointertap` click
   * handling needs care: a click-drag that pans the board would otherwise
   * ALSO fire a hex click at release (the hex originally under the cursor
   * stays under the cursor throughout a 1:1 pan, so PixiJS's own down/up
   * same-target click detection would still fire). This wraps `onHexClick`
   * to swallow the next click whenever the just-finished gesture moved more
   * than `DRAG_THRESHOLD_PX`, using a listener registered on `canvasHost`
   * in the CAPTURE phase for `pointerup` specifically so it runs before
   * PixiJS's own listener (attached to the canvas element itself, a
   * descendant of `canvasHost`) -- capture-phase listeners on an ancestor
   * always run before an event reaches a descendant, which is what
   * guarantees `suppressNextClick` is set before PixiJS computes its own
   * click. This ordering is standard DOM behaviour, but could not be
   * confirmed against a real browser in this environment -- see the
   * top-level report.
   */
  import * as PIXI from 'pixi.js';
  import { SnapshotBoard, type ScenarioSnapshot, type HexPoint, type SnapshotUnit } from '@wesnothweb2/renderer';

  let {
    snapshot,
    units,
    selectedHex = null,
    reachable = [],
    attackTargets = [],
    recruitTiles = [],
    onHexClick,
  }: {
    /** Static parts (terrain/teams/scenario/map) -- read once at mount, never re-applied after. */
    snapshot: ScenarioSnapshot;
    /** Live unit positions/HP -- re-applied to the board whenever this changes. */
    units: SnapshotUnit[];
    selectedHex?: HexPoint | null;
    reachable?: readonly HexPoint[];
    attackTargets?: readonly HexPoint[];
    recruitTiles?: readonly HexPoint[];
    onHexClick: (x: number, y: number) => void;
  } = $props();

  const MIN_ZOOM = 0.3;
  const MAX_ZOOM = 3;
  const DRAG_THRESHOLD_PX = 6;

  let canvasHost: HTMLDivElement | undefined = $state();
  /** Transient loading/error text only -- the ready-state label is `readyLabel` below, kept live via `$derived` rather than a one-time snapshot of `units.length` at mount (that used to freeze at the pre-events count, e.g. "2 units" even once the scenario's startup events had spawned nine more). */
  let status = $state<string | null>('loading scenario...');
  let board: SnapshotBoard | undefined;
  const readyLabel = $derived(`${snapshot.scenario.name} -- ${units.length} units, ${snapshot.map.width}x${snapshot.map.height} hexes`);

  $effect(() => {
    if (!canvasHost) return;
    const host = canvasHost;
    let app: PIXI.Application | undefined;
    let cancelled = false;

    // --- pan/zoom state (see module doc comment) ---
    let dragActive = false;
    let dragStart = { x: 0, y: 0 };
    let dragOrigin = { x: 0, y: 0 };
    let dragDistance = 0;
    let suppressNextClick = false;

    function wrappedOnHexClick(x: number, y: number): void {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      onHexClick(x, y);
    }

    function onPointerDown(e: PointerEvent): void {
      if (e.button !== 0 || !board) return;
      dragActive = true;
      dragDistance = 0;
      dragStart = { x: e.clientX, y: e.clientY };
      dragOrigin = { x: board.stage.x, y: board.stage.y };
    }

    function onPointerMove(e: PointerEvent): void {
      if (!dragActive || !board) return;
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      dragDistance = Math.max(dragDistance, Math.hypot(dx, dy));
      board.stage.x = dragOrigin.x + dx;
      board.stage.y = dragOrigin.y + dy;
    }

    function onPointerUpCapture(): void {
      if (!dragActive) return;
      dragActive = false;
      if (dragDistance > DRAG_THRESHOLD_PX) suppressNextClick = true;
    }

    function onWindowPointerUp(): void {
      dragActive = false;
    }

    function onWheel(e: WheelEvent): void {
      if (!board) return;
      e.preventDefault();
      const zoomFactor = Math.exp(-e.deltaY * 0.001);
      const oldScale = board.stage.scale.x;
      const newScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldScale * zoomFactor));
      const actualFactor = newScale / oldScale;
      const rect = host.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      // Keep the point under the cursor fixed on screen while scaling.
      board.stage.x = px - (px - board.stage.x) * actualFactor;
      board.stage.y = py - (py - board.stage.y) * actualFactor;
      board.stage.scale.set(newScale);
    }

    // `pointerdown`/`pointermove` on the host are enough for a drag that
    // stays over the canvas; `pointerup` is also listened to on `window`
    // (in addition to the capture listener below) so a drag ending outside
    // the canvas still clears `dragActive`.
    host.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    // Capture phase, and on `host` (an ancestor of the PixiJS canvas) --
    // see module doc comment on why this ordering matters.
    host.addEventListener('pointerup', onPointerUpCapture, true);
    host.addEventListener('wheel', onWheel, { passive: false });

    (async () => {
      app = new PIXI.Application();
      await app.init({
        backgroundColor: 0x111111,
        resizeTo: host,
        antialias: true,
      });
      if (cancelled) {
        app.destroy();
        return;
      }
      host.appendChild(app.canvas);

      const newBoard = new SnapshotBoard(snapshot, { imageBaseUrl: '/game-images', onHexClick: wrappedOnHexClick });
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

      status = null;
      // Apply whatever the current live state already is (props may have
      // settled before this async init finished) -- the effects below only
      // fire again on a *subsequent* change.
      await newBoard.updateUnits(units);
      newBoard.setHighlights({ selected: selectedHex, reachable, attackTargets, recruitTiles });
    })().catch((err) => {
      console.error(err);
      status = `failed to load: ${err instanceof Error ? err.message : String(err)}`;
    });

    return () => {
      cancelled = true;
      host.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
      host.removeEventListener('pointerup', onPointerUpCapture, true);
      host.removeEventListener('wheel', onWheel);
      app?.destroy(true);
    };
  });

  $effect(() => {
    const liveUnits = units;
    void board?.updateUnits(liveUnits);
  });

  $effect(() => {
    board?.setHighlights({ selected: selectedHex, reachable, attackTargets, recruitTiles });
  });
</script>

<div class="board-view">
  <p class="status">{status ?? readyLabel} (drag to pan, scroll to zoom)</p>
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
    touch-action: none;
  }
</style>
