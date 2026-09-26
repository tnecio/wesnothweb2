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
    hexToPixel,
    unitBundleManifestUrl,
  } from '@wesnothweb2/renderer';
  import type { TimeOfDayEntry } from '@wesnothweb2/engine';
  import { fetchTeamColors } from './teamColorsCache.js';

  let {
    snapshot,
    units,
    selectedHex = null,
    cursorHex = null,
    reachable = [],
    attackTargets = [],
    villageOwners = [],
    hexVisibility = [],
    terrain = null,
    timeOfDay = undefined,
    onHexClick,
    onHexRightClick,
    onHexHoverChange,
    hoverDefensePercent,
    paused = false,
  }: {
    /**
     * Phase 16: stop rendering while something covers the whole board (the
     * story screen), like upstream's `display::set_prevent_draw` in
     * `story_viewer::pre_show`. The render loop otherwise redraws the full
     * map every frame and starves the overlay's own timers and input.
     */
    paused?: boolean;
    /** Static parts (terrain/teams/scenario/map) -- read once at mount, never re-applied after. */
    snapshot: ScenarioSnapshot;
    /** Live unit positions/HP -- re-applied to the board whenever this changes. */
    units: SnapshotUnit[];
    selectedHex?: HexPoint | null;
    /** Phase 15: the keyboard cursor's hex (`GameShell` owns it), drawn as its own ring. */
    cursorHex?: HexPoint | null;
    reachable?: readonly (HexPoint & { defensePercent?: number })[];
    attackTargets?: readonly HexPoint[];
    /** Live village ownership (village hex -> owning side, or unowned if absent) -- re-applied whenever it changes, same as `units`. */
    villageOwners?: readonly VillageOwnerPoint[];
    /** Per-hex shroud/fog state for the board's fog overlay -- see `GameSession.hexVisibility`. Empty when the scenario uses neither. */
    hexVisibility?: readonly FogShroudHex[];
    /** The whole on-board terrain once WML changed the map (`GameSession.terrainHexes`); `null` while it is the scenario's. */
    terrain?: readonly { x: number; y: number; code: string }[] | null;
    /** The current global ToD's red=/green=/blue= colour shift -- see `SnapshotBoard.updateTimeOfDayTint`. Omit for no tint (a scenario with no [time] schedule). */
    timeOfDay?: Pick<TimeOfDayEntry, 'red' | 'green' | 'blue'>;
    onHexClick: (x: number, y: number) => void;
    /**
     * Phase 14: real Wesnoth's right-click context menu -- called with a
     * hex's engine-convention (0-based) (x,y) AND raw viewport
     * (`clientX`/`clientY`, for positioning an HTML popup at the cursor)
     * when a terrain tile is right-clicked. Omit to leave right-click as a
     * no-op (still suppresses the browser's own menu over the canvas,
     * matching a real game window).
     */
    onHexRightClick?: (x: number, y: number, clientX: number, clientY: number) => void;
    /** Bubbles the hovered hex up to a caller that wants to show live terrain info elsewhere (the infobox's "hovered hex" section) -- `null` when the pointer leaves the board. Separate from `hoverDefensePercent` (used only for this component's own inline status line) so a caller doesn't need to reimplement hover tracking itself. */
    onHexHoverChange?: (hex: HexPoint | null) => void;
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
  /** Resolves once the first full render -- terrain, then units, highlights, fog -- is on screen (or failed); see `whenReady`. */
  let markReady: () => void = () => {};
  const readyPromise = new Promise<void>((resolve) => (markReady = resolve));
  /** The mounted PixiJS app, reactive so the `paused` effect below runs once it exists. */
  let pixiApp: PIXI.Application | undefined = $state.raw();
  /** Phase 17 `[lock_view]`: the player's own pan/zoom is off while a cutscene owns the camera. */
  let viewLocked = false;
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
      if (e.button !== 0 || !board || viewLocked) return;
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
      if (!board || viewLocked) return;
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
      onHexHoverChange?.(null);
    }
    host.addEventListener('pointerleave', onPointerLeave);
    // Real Wesnoth's right-click opens its own in-game context menu, not
    // the browser's -- suppress the native one over the whole board
    // unconditionally (whether or not a caller actually supplied
    // `onHexRightClick`, matching a real game window's behavior).
    function onContextMenu(e: MouseEvent): void {
      e.preventDefault();
    }
    host.addEventListener('contextmenu', onContextMenu);

    (async () => {
      // Deliberately NO PixiJS CullerPlugin here: tried for the real
      // terrain layer (~8,700 sprites) and it made every frame ~10x SLOWER
      // (measured: dialog clicks went from ~0.5s to ~24s each), while a
      // plain `app.render()` of the whole unculled board costs ~2ms of CPU.
      // Sprite count is not the bottleneck; see SnapshotBoard's
      // `installHitArea` for what actually was.
      app = new PIXI.Application();
      const [, teamColors] = await Promise.all([
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
        fetchTeamColors(),
      ]);
      if (cancelled) {
        destroyApp(app);
        return;
      }
      host.appendChild(app.canvas);
      pixiApp = app;
      // Real, reported bug (bugs3.md #3): unit sprites always rendered in
      // their raw reference palette (magenta) instead of the unit's side
      // color -- `ImageCache` needs real palette/range data before it can
      // apply `~RC(flag_rgb>side_color_id)` (see `SnapshotBoard.
      // buildUnitVisual`). `sideRanges` is left empty: this recolor path
      // resolves a side's color id up front (`resolveSideColorId`, using
      // `defaultColors`) rather than relying on `ImageCache`'s own
      // side-number fallback.
      ImageCache.setColorData(teamColors ? { ...teamColors, sideRanges: {} } : null);
      // Phase 28a P5: this scenario's terrain bundle (built by apps/web/scripts/build-image-atlases.mjs).
      // Images not in it are fetched on their own, so a missing bundle only costs requests.
      ImageCache.setAtlasManifests([`/atlases/${snapshot.scenario.id}/terrain.json`]);
      // Phase 28a P6: recruitable types' bundles are registered (downloaded on first use)...
      ImageCache.addAtlasManifests(snapshot.teams.flatMap((team) => team.recruit ?? []).map(unitBundleManifestUrl));
      // ...and types on the board are downloaded now, so their first animation needs no network.
      registerUnitBundles(units);

      const newBoard = new SnapshotBoard(snapshot, {
        imageBaseUrl: '/game-images',
        engineImageBaseUrl: '/game-images-engine',
        onHexClick: wrappedOnHexClick,
        onHexRightClick,
        onHexHover: (x, y) => {
          hoveredHex = { x, y };
          onHexHoverChange?.({ x, y });
        },
        // Phase 28a P3: the rules (~17.5 MB JSON) are fetched, parsed and matched in a worker.
        terrainGraphicsRulesUrl: '/terrain-graphics-rules.json',
      });
      await newBoard.render();
      if (cancelled) {
        destroyApp(app, true);
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
      newBoard.setHighlights({ selected: selectedHex, cursor: cursorHex, reachable, attackTargets });
      newBoard.updateVillageOwnership(villageOwners);
      newBoard.updateFogShroud(hexVisibility);
      if (timeOfDay) newBoard.updateTimeOfDayTint(timeOfDay);
    })()
      .catch((err) => {
        console.error(err);
        status = `failed to load: ${err instanceof Error ? err.message : String(err)}`;
      })
      .finally(() => markReady());

    return () => {
      cancelled = true;
      host.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
      host.removeEventListener('pointerup', onPointerUpCapture, true);
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('pointerleave', onPointerLeave);
      host.removeEventListener('contextmenu', onContextMenu);
      pixiApp = undefined;
      // `app` may exist but not be initialised yet: `new PIXI.Application()`
      // returns immediately and `app.init()` is awaited inside the IIFE
      // above, so a teardown that lands in between (navigating away while
      // the board is still starting) reaches a half-built Application and
      // `destroy` throws `this._cancelResize is not a function`. Observed
      // as a pair of console errors on every quick navigation; harmless in
      // itself, but it buries real errors and fails any check that treats
      // page errors as failures.
      try {
        app?.destroy(true);
      } catch {
        // Nothing initialised, so nothing to release.
      }
    };
  });

  $effect(() => {
    const app = pixiApp;
    if (!app) return;
    if (paused) app.ticker.stop();
    else app.ticker.start();
  });

  /**
   * Phase 28a P6: registers and prefetches the image bundle of every unit
   * type in `list` (spawns, recruits, advancements appear here as they
   * happen). Bundles are only a cache: a type without one fetches files.
   */
  /**
   * Releases a PixiJS app, tolerating one that never finished starting.
   * `new PIXI.Application()` returns immediately and `app.init()` is
   * awaited afterwards, so a teardown landing in between reaches a
   * half-built Application whose `destroy` throws `this._cancelResize is
   * not a function`. Harmless in itself -- there is nothing to release
   * yet -- but it buried real errors in the console and failed any check
   * treating page errors as failures.
   */
  function destroyApp(app: PIXI.Application, removeView = false): void {
    // Idempotent: the async init path and the effect's own cleanup can
    // both reach the same app (the init awaits, the component unmounts,
    // both then tidy up), and PixiJS's second `destroy` walks fields the
    // first one already nulled.
    if (destroyedApps.has(app)) return;
    destroyedApps.add(app);
    try {
      app.destroy(removeView);
    } catch {
      // Never initialised: nothing to release.
    }
  }

  const destroyedApps = new WeakSet<PIXI.Application>();

  function registerUnitBundles(list: readonly SnapshotUnit[]): void {
    ImageCache.addAtlasManifests(new Set(list.map((unit) => unitBundleManifestUrl(unit.typeId))), { prefetch: true });
  }

  $effect(() => {
    const liveUnits = units;
    if (!board) return;
    registerUnitBundles(liveUnits);
    void board.updateUnits(liveUnits);
  });

  $effect(() => {
    board?.setHighlights({ selected: selectedHex, cursor: cursorHex, reachable, attackTargets });
  });

  $effect(() => {
    board?.setHoveredHex(hoveredHex);
  });

  $effect(() => {
    board?.updateVillageOwnership(villageOwners);
  });

  $effect(() => {
    board?.updateFogShroud(hexVisibility);
  });

  $effect(() => {
    if (terrain) void board?.updateTerrain(terrain);
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
  export async function playAnimationSequence(
    beats: readonly UnitAnimationCue[][],
    speedMultiplier = 1,
    onBeatComplete?: (beatIndex: number) => void,
  ): Promise<void> {
    if (!board) return;
    for (let i = 0; i < beats.length; i++) {
      await board.playAnimations(beats[i]!, undefined, speedMultiplier);
      onBeatComplete?.(i);
    }
  }

  /**
   * Real, reported bug: the HP bar only ever updated once, after a whole
   * attack's exchange fully resolved -- see `SnapshotBoard.previewHitpoints`'s
   * own doc comment. Exposed for `GameShell.svelte`'s per-blow
   * `onBeatComplete` callback (above) to call between beats.
   */
  export function previewHitpoints(key: string, hitpoints: number): void {
    board?.previewHitpoints(key, hitpoints);
  }

  /** Real, reported bug: no floating damage/heal numerals ever appeared. See `SnapshotBoard.spawnFloatingNumber`'s own doc comment. */
  export function spawnFloatingNumber(key: string, amount: number, kind: 'damage' | 'heal'): void {
    board?.spawnFloatingNumber(key, amount, kind);
  }

  /** Real, reported bug (bugs4.md #3): a unit that died mid-AI-turn kept a stale sprite on screen until the turn's deferred sync(). See `SnapshotBoard.removeUnitVisual`'s own doc comment. */
  export function removeUnitVisual(key: string): void {
    board?.removeUnitVisual(key);
  }

  /** Real, reported bug (bugs5.md #3): a just-recruited/recalled unit had no visual at all (so its own "recruited" animation cue silently did nothing) until the deferred sync() at the end of a whole turn's animation playback. See `SnapshotBoard.ensureUnitVisual`'s own doc comment. */
  export async function ensureUnitVisual(unit: SnapshotUnit): Promise<void> {
    await board?.ensureUnitVisual(unit);
  }

  /**
   * Phase 28a P0: the viewport (client) coordinates of hex (x, y) (engine
   * 0-based) at the current pan/zoom, or null before the board exists.
   * Used by browser measurement/verification scripts to click hexes.
   */
  export function hexClientPoint(x: number, y: number): { x: number; y: number } | null {
    if (!board || !canvasHost) return null;
    const { x: px, y: py } = hexToPixel({ x: x + 1, y: y + 1 });
    const rect = canvasHost.getBoundingClientRect();
    const scale = board.stage.scale.x;
    return { x: rect.left + board.stage.x + px * scale, y: rect.top + board.stage.y + py * scale };
  }

  /**
   * Phase 28a: for rendered-board screenshot comparisons only. Animated
   * terrain (water, lava...) is a ticker-driven `AnimatedSprite`, so two
   * captures of the same board otherwise land on different frames. Stops
   * every animated sprite at frame 0 and renders once.
   */
  export function freezeAnimationsForCapture(): boolean {
    if (!board || !pixiApp) return false;
    const visit = (node: PIXI.Container): void => {
      if (node instanceof PIXI.AnimatedSprite) node.gotoAndStop(0);
      for (const child of node.children) visit(child as PIXI.Container);
    };
    visit(board.stage);
    pixiApp.render();
    return true;
  }

  /**
   * Phase 28a: stops/starts the render loop for verification scripts that
   * do not need the board drawn (the golden pixel check). Under headless
   * Chromium's software GL a live full-map render loop takes several CPU
   * cores and starves the compositor workers.
   */
  export function setRenderingPaused(paused: boolean): boolean {
    if (!pixiApp) return false;
    if (paused) pixiApp.ticker.stop();
    else pixiApp.ticker.start();
    return true;
  }

  // Dev-only hooks for browser measurement/verification scripts (apps/web/scripts/measure-load.mjs,
  // image-golden.mjs, board-screenshots.mjs): the shared ImageCache, hex -> client coordinates,
  // animation freezing and pausing the render loop. Absent in production builds.
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV && typeof window !== 'undefined') {
    (window as unknown as { __wesnothDebug?: unknown }).__wesnothDebug = {
      imageCache: ImageCache,
      hexClientPoint,
      freezeAnimationsForCapture,
      setRenderingPaused,
      /** Live sprite positions, for debugging movement animation glitches -- see `SnapshotBoard.unitSpritePositions`. */
      unitSpritePositions: () => board?.unitSpritePositions() ?? null,
      /** Filters per unit sprite, for checking status looks (slowed/poisoned/petrified). */
      unitSpriteFilterCounts: () => board?.unitSpriteFilterCounts() ?? null,
      /** Missiles/halos on the latest animation frame, for checking particle effects. */
      animationOverlays: () => board?.lastAnimationOverlays ?? null,
    };
  }

  /**
   * Resolves once the map and its units are drawn -- bugs6.md: a scenario's
   * opening dialogue must not start over a still-blank board, or the
   * speakers it scrolls to and names are not there to see. Also resolves
   * if loading failed, so nothing waiting on it hangs.
   */
  export function whenReady(): Promise<void> {
    return readyPromise;
  }

  /** Phase 16: the board's on-screen area, which the `[message]` dialog covers (upstream's `gamemap_*` window variables). */
  export function viewportRect(): DOMRect | null {
    return canvasHost?.getBoundingClientRect() ?? null;
  }

  /**
   * Phase 15: the zoom hotkeys (`=`/`-`/`0`, upstream `zoomin`/`zoomout`/
   * `zoomdefault`). Scales about the viewport centre -- the wheel zoom
   * keeps the point under the cursor fixed instead, which a keypress has
   * no cursor for. Clamped to the same limits the wheel uses.
   */
  export function zoomBy(factor: number): void {
    if (!board || !pixiApp) return;
    const oldScale = board.stage.scale.x;
    const newScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, oldScale * factor));
    const actualFactor = newScale / oldScale;
    const cx = pixiApp.screen.width / 2;
    const cy = pixiApp.screen.height / 2;
    board.stage.x = cx - (cx - board.stage.x) * actualFactor;
    board.stage.y = cy - (cy - board.stage.y) * actualFactor;
    board.stage.scale.set(newScale);
  }

  /** Phase 15: `zoomdefault` -- back to 1:1, re-centring the board as the initial mount does. */
  export function zoomDefault(): void {
    if (!board || !pixiApp) return;
    board.stage.scale.set(1);
    const bounds = board.stage.getLocalBounds();
    board.stage.x = (pixiApp.screen.width - bounds.width) / 2 - bounds.x;
    board.stage.y = (pixiApp.screen.height - bounds.height) / 2 - bounds.y;
  }

  /** Phase 15: centre `(x, y)` (engine 0-based) unconditionally -- the keyboard cursor and "scroll to leader". */
  export function centerOnHex(x: number, y: number): void {
    if (!board || !pixiApp) return;
    const { x: px, y: py } = hexToPixel({ x: x + 1, y: y + 1 });
    const scale = board.stage.scale.x;
    board.stage.x = pixiApp.screen.width / 2 - px * scale;
    board.stage.y = pixiApp.screen.height / 2 - py * scale;
  }

  /**
   * Phase 17 `[zoom] factor=`: an absolute scale, as opposed to
   * `zoomBy`'s relative one. Same clamp and same centre-preserving
   * arithmetic.
   */
  export function zoomTo(factor: number): void {
    if (!board) return;
    const current = board.stage.scale.x;
    if (current <= 0) return;
    zoomBy(factor / current);
  }

  /** Phase 17 `[scroll]`: shift the view by a pixel delta (upstream's own `display::scroll`). */
  export function scrollByPixels(dx: number, dy: number): void {
    if (!board) return;
    board.stage.x -= dx;
    board.stage.y -= dy;
  }

  /**
   * Phase 17 `[lock_view]`/`[unlock_view]`: while locked, the player
   * cannot pan or zoom -- a cutscene owns the camera. Scripted moves
   * (`[scroll_to]` and friends) still work, as upstream.
   */
  export function setViewLocked(locked: boolean): void {
    viewLocked = locked;
  }

  /**
   * Phase 16: `[message]`'s scroll to the speaker -- `message.lua` calls
   * `scroll_to_hex(x, y, true, false, true)`, i.e. `ONSCREEN`: move only
   * when the hex (engine 0-based) is not already comfortably in view.
   * Centres it instantly (upstream scrolls smoothly).
   */
  export function scrollToHexIfOffscreen(x: number, y: number): void {
    if (!board || !pixiApp) return;
    const { x: px, y: py } = hexToPixel({ x: x + 1, y: y + 1 });
    const scale = board.stage.scale.x;
    const screenX = board.stage.x + px * scale;
    const screenY = board.stage.y + py * scale;
    const margin = 72 * scale;
    const { width, height } = pixiApp.screen;
    if (screenX >= margin && screenX <= width - margin && screenY >= margin && screenY <= height - margin) return;
    board.stage.x = width / 2 - px * scale;
    board.stage.y = height / 2 - py * scale;
  }
</script>

<div class="board-view" data-board-ready={board ? 'true' : 'false'}>
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
