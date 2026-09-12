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
  import {
    SnapshotBoard,
    ImageCache,
    type ScenarioSnapshot,
    type HexPoint,
    type SnapshotUnit,
    type VillageOwnerPoint,
    type UnitAnimationCue,
    type FogShroudHex,
  } from '@wesnothweb2/renderer';
  import type { TimeOfDayEntry } from '@wesnothweb2/engine';
  import { fetchTerrainGraphicsRules } from './terrainGraphicsRulesCache.js';
  import { fetchTeamColors } from './teamColorsCache.js';

  let {
    snapshot,
    units,
    selectedHex = null,
    reachable = [],
    attackTargets = [],
    recruitTiles = [],
    villageOwners = [],
    hexVisibility = [],
    timeOfDay = undefined,
    onHexClick,
    hoverDefensePercent,
  }: {
    /** Static parts (terrain/teams/scenario/map) -- read once at mount, never re-applied after. */
    snapshot: ScenarioSnapshot;
    /** Live unit positions/HP -- re-applied to the board whenever this changes. */
    units: SnapshotUnit[];
    selectedHex?: HexPoint | null;
    reachable?: readonly (HexPoint & { defensePercent?: number })[];
    attackTargets?: readonly HexPoint[];
    recruitTiles?: readonly HexPoint[];
    /** Live village ownership (village hex -> owning side, or unowned if absent) -- re-applied whenever it changes, same as `units`. */
    villageOwners?: readonly VillageOwnerPoint[];
    /** Per-hex shroud/fog state for the board's fog overlay -- see `GameSession.hexVisibility`. Empty when the scenario uses neither. */
    hexVisibility?: readonly FogShroudHex[];
    /** The current global ToD's red=/green=/blue= colour shift -- see `SnapshotBoard.updateTimeOfDayTint`. Omit for no tint (a scenario with no [time] schedule). */
    timeOfDay?: Pick<TimeOfDayEntry, 'red' | 'green' | 'blue'>;
    onHexClick: (x: number, y: number) => void;
    /** Real terrain-defense percentage the currently selected unit would have at (x, y), for the hover status line -- `undefined`/`null` when nothing is selected or the hex is off-board. */
    hoverDefensePercent?: (x: number, y: number) => number | null;
  } = $props();

  const MIN_ZOOM = 0.3;
  const MAX_ZOOM = 3;
  const DRAG_THRESHOLD_PX = 6;

  let canvasHost: HTMLDivElement | undefined = $state();
  /** Transient loading/error text only -- the ready-state label is `readyLabel` below, kept live via `$derived` rather than a one-time snapshot of `units.length` at mount (that used to freeze at the pre-events count, e.g. "2 units" even once the scenario's startup events had spawned nine more). */
  let status = $state<string | null>('loading scenario...');
  /** The hex the pointer is currently over, engine-convention (0-based) -- shown in the status line so positions are easy to read off and report precisely (e.g. describing a bug). `null` when the pointer isn't over the board at all. */
  let hoveredHex = $state<HexPoint | null>(null);
  /**
   * `$state`, not a plain `let` -- this used to be a plain variable, which
   * created a real race: the two small reactive effects below read `board`
   * but only *re-run* when `selectedHex`/`units`/etc change, not when
   * `board` itself transitions from undefined to assigned (a plain
   * variable write isn't a tracked dependency). If a prop changed at some
   * point before the async PixiJS init below finished (entirely possible
   * -- app.init() is not instant), that effect run saw `board` still
   * undefined, no-opped, and then never reran again since nothing it
   * tracks changed afterwards -- silently dropping the selection ring/
   * highlights with no error. Confirmed by instrumenting both effects:
   * the exact same click sequence rendered highlights correctly on some
   * runs and not at all on others, which is the signature of a timing
   * race, not a one-off mistake. Making `board` reactive means its own
   * assignment is a tracked write, so both effects correctly rerun the
   * moment it becomes available, regardless of what else changed when.
   */
  let board: SnapshotBoard | undefined = $state();
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
    function onPointerLeave(): void {
      hoveredHex = null;
    }
    host.addEventListener('pointerleave', onPointerLeave);

    (async () => {
      // Deliberately NO PixiJS CullerPlugin here: tried for the real
      // terrain layer (~8,700 sprites) and it made every frame ~10x SLOWER
      // (measured: dialog clicks went from ~0.5s to ~24s each), while a
      // plain `app.render()` of the whole unculled board costs ~2ms of CPU.
      // Sprite count is not the bottleneck; see SnapshotBoard's
      // `installHitArea` for what actually was.
      app = new PIXI.Application();
      const [, terrainGraphicsRules, teamColors] = await Promise.all([
        app.init({
          backgroundColor: 0x111111,
          resizeTo: host,
          antialias: true,
          // Required for the 'subtract' advanced blend mode used by
          // SnapshotBoard's ToD tint layer -- without it, the blend
          // filter has no valid backbuffer to read the composited scene
          // from and renders solid black wherever it's applied.
          useBackBuffer: true,
        }),
        fetchTerrainGraphicsRules(),
        fetchTeamColors(),
      ]);
      if (cancelled) {
        app.destroy();
        return;
      }
      host.appendChild(app.canvas);
      // Real, reported bug (bugs3.md #3): unit sprites always rendered in
      // their raw reference palette (magenta) instead of the unit's side
      // color -- `ImageCache` needs real palette/range data before it can
      // apply `~RC(flag_rgb>side_color_id)` (see `SnapshotBoard.
      // buildUnitVisual`). `sideRanges` is left empty: this recolor path
      // resolves a side's color id up front (`resolveSideColorId`, using
      // `defaultColors`) rather than relying on `ImageCache`'s own
      // side-number fallback.
      ImageCache.setColorData(teamColors ? { ...teamColors, sideRanges: {} } : null);

      const newBoard = new SnapshotBoard(snapshot, {
        imageBaseUrl: '/game-images',
        engineImageBaseUrl: '/game-images-engine',
        onHexClick: wrappedOnHexClick,
        onHexHover: (x, y) => {
          hoveredHex = { x, y };
        },
        terrainGraphicsRules,
      });
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
      newBoard.updateVillageOwnership(villageOwners);
      newBoard.updateFogShroud(hexVisibility);
      if (timeOfDay) newBoard.updateTimeOfDayTint(timeOfDay);
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
      host.removeEventListener('pointerleave', onPointerLeave);
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

  $effect(() => {
    board?.updateVillageOwnership(villageOwners);
  });

  $effect(() => {
    board?.updateFogShroud(hexVisibility);
  });

  $effect(() => {
    if (timeOfDay) board?.updateTimeOfDayTint(timeOfDay);
  });

  /**
   * Plays a sequence of animation "beats" one after another (each beat's
   * own cues concurrently, then the next beat) -- an attack's real
   * per-blow attacker+defender pairs, or a movement's real per-step glide
   * (one cue per leg of a multi-hex path). Exposed for `GameShell.svelte`
   * to call (via `bind:this`) and await BEFORE it applies the resolved
   * action's final state through the `units` prop -- see `SnapshotBoard`'s
   * own module doc comment on why that ordering matters (an `updateUnits`
   * mid-flight would cut the animation short). A no-op (resolves
   * immediately) if the board isn't mounted yet, which shouldn't happen
   * in practice (an action can't resolve before the board renders) but
   * is handled rather than assumed. `speedMultiplier` passes straight
   * through to `SnapshotBoard.playAnimations` (see its own doc comment) --
   * default 1 (real authored speed); `GameShell.svelte` requests a
   * faster one for movement specifically.
   */
  export async function playAnimationSequence(beats: readonly UnitAnimationCue[][], speedMultiplier = 1): Promise<void> {
    if (!board) return;
    for (const cues of beats) {
      await board.playAnimations(cues, undefined, speedMultiplier);
    }
  }
</script>

<div class="board-view">
  <p class="status">
    {status ?? readyLabel} (drag to pan, scroll to zoom)
    {#if hoveredHex}
      &middot; Hex: ({hoveredHex.x}, {hoveredHex.y})
      {#if hoverDefensePercent}
        {@const def = hoverDefensePercent(hoveredHex.x, hoveredHex.y)}
        {#if def !== null && def !== undefined}
          &middot; Defense: {def}%
        {/if}
      {/if}
    {/if}
  </p>
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
