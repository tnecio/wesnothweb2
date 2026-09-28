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
  import { dataUrl } from './dataUrls.js';
  import { ENGINE_IMAGES, GAME_IMAGES } from './gameData.js';
  import { fmt, th, tx } from './i18n/locale.js';
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
    pixelToHex,
    unitBundleManifestUrl,
    clampView,
    zoomAbout,
    centerOn,
    zoomIndexFor,
    scaleForZoom,
    pinchZoom,
    stepZoom,
    clampZoom,
    scrollTargetForHexes,
    worldBounds,
    ZOOM_LEVELS,
    DEFAULT_ZOOM,
    ScrollAnimation,
    scrollWarps,
    edgeScrollAmount,
    type View,
    type ScrollType,
  } from '@wesnothweb2/renderer';
  import { displayPrefs, prefersReducedMotion } from './displayPrefs.js';
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
    items = [],
    labels = [],
    timeOfDay = undefined,
    onSound,
    onHexClick,
    onHexRightClick,
    onHexHoverChange,
    onViewportResize,
    hoverDefensePercent,
    paused = false,
    onViewChange,
    edgeScroll = false,
    grid = false,
  }: {
    /**
     * Phase 16: stop rendering while something covers the whole board (the
     * story screen), like upstream's `display::set_prevent_draw` in
     * `story_viewer::pre_show`. The render loop otherwise redraws the full
     * map every frame and starves the overlay's own timers and input.
     */
    paused?: boolean;
    /**
     * Phase 22: whether resting the pointer at the window's edge may pan the map now (the game is in
     * play and no dialog covers it). The "Mouse scrolling" preference and `[lock_view]` apply on top.
     */
    edgeScroll?: boolean;
    /** Phase 22: the grid overlay (`prefs::grid`, toggled by Ctrl+G). */
    grid?: boolean;
    /** Phase 22: the camera moved (pan, zoom, glide, resize) -- the minimap's outline follows it. */
    onViewChange?: (state: { view: View; viewport: { width: number; height: number } }) => void;
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
    /** Map items the viewing side sees (`GameSession.mapItems`). */
    items?: readonly { x: number; y: number; image: string; halo: string }[];
    /** Map labels the viewing side sees (`GameSession.mapLabels`). */
    labels?: readonly { x: number; y: number; text: string; color: string }[];
    /** Phase 19: a frame sound (`sound=`) starts in an animation being played -- a comma list, one of which is picked. */
    onSound?: (files: string) => void;
    /** The current global ToD's red=/green=/blue= colour shift -- see `SnapshotBoard.updateTimeOfDayTint`. Omit for no tint (a scenario with no [time] schedule). */
    timeOfDay?: Pick<TimeOfDayEntry, 'red' | 'green' | 'blue'>;
    /** A click or tap on hex (x, y). `touch` (Phase 23): it was a finger (or pen), which may want a confirming second tap. */
    onHexClick: (x: number, y: number, input?: { touch: boolean }) => void;
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
    /** Called when the board's on-screen area changes size without the window resizing (e.g. a collapsed infobox), for overlays placed over it. */
    onViewportResize?: () => void;
    /** Real terrain-defense percentage the currently selected unit would have at (x, y), for the hover status line -- `undefined`/`null` when nothing is selected or the hex is off-board. */
    hoverDefensePercent?: (x: number, y: number) => number | null;
  } = $props();

  const DRAG_THRESHOLD_PX = 6;

  /**
   * Phase 22: the camera. Every change to where the board sits goes through
   * `applyView`, which bounds-checks it (`camera.ts`'s port of upstream's
   * `bounds_check_position`), so no gesture, hotkey or script can lose the map
   * off screen. `zoom` is the hex size in px -- continuous between upstream's
   * smallest and largest levels, a deliberate departure (see `camera.ts`'s
   * `pinchZoom`); `lastZoom` is what `zoomdefault` toggles back to.
   */
  let zoom = clampZoom(displayPrefs.peek().zoom);
  let lastZoom = zoom;

  function mapSize(): { w: number; h: number } {
    return { w: snapshot.map.width, h: snapshot.map.height };
  }

  /** The middle of the map (and its border), in unscaled board pixels. */
  function mapCentre(): { x: number; y: number } {
    const b = worldBounds(mapSize());
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  }

  function viewportSize(): { width: number; height: number } | null {
    return pixiApp ? { width: pixiApp.screen.width, height: pixiApp.screen.height } : null;
  }

  function currentView(): View | null {
    return board ? { x: board.stage.x, y: board.stage.y, scale: board.stage.scale.x } : null;
  }

  function applyView(view: View): void {
    const viewport = viewportSize();
    if (!board || !viewport) return;
    const v = clampView(view, mapSize(), viewport);
    board.stage.x = v.x;
    board.stage.y = v.y;
    board.stage.scale.set(v.scale);
    onViewChange?.({ view: v, viewport });
  }

  /** `set_zoom`: to hex size `next` (clamped), keeping screen point `anchor` fixed (default: the centre). */
  function setZoom(next: number, anchor?: { x: number; y: number }): void {
    const view = currentView();
    const viewport = viewportSize();
    next = clampZoom(next);
    if (!view || !viewport || Math.abs(next - zoom) < 0.01) return;
    cancelScroll();
    zoom = next;
    if (next !== DEFAULT_ZOOM) lastZoom = next;
    const at = anchor ?? { x: viewport.width / 2, y: viewport.height / 2 };
    applyView(zoomAbout(view, scaleForZoom(next), at, mapSize(), viewport));
    // prefs::set_tile_size: the next game opens at this zoom. Written once the zoom settles, not per frame of a pinch.
    clearTimeout(saveZoomTimer);
    saveZoomTimer = setTimeout(() => displayPrefs.update({ zoom }), 300);
  }
  let saveZoomTimer: ReturnType<typeof setTimeout> | undefined;
  /** Ctrl+wheel: the zoom changes by e^(-delta * this) -- a ~100 px mouse notch is about 20%. */
  const WHEEL_ZOOM_PER_PIXEL = 0.0022;

  let canvasHost: HTMLDivElement | undefined = $state();
  /** Transient loading/error text only -- the ready-state label is `readyLabel` below, kept live via `$derived` rather than a one-time snapshot of `units.length` at mount (that used to freeze at the pre-events count, e.g. "2 units" even once the scenario's startup events had spawned nine more). */
  let status = $state<string | null>(tx('loading scenario...'));
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
  const readyLabel = $derived(fmt(tx('$name -- $units units, $width x $height hexes'), { name: snapshot.scenario.name, units: units.length, width: snapshot.map.width, height: snapshot.map.height }));

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
    let disconnectResize = (): void => {};

    /*
     * Phase 23, touch. Every finger on the board is tracked; one drags the map as the mouse does,
     * two pinch (the level nearest the spread, `pinchZoomIndex`, anchored between them) and pan
     * (their midpoint). Holding one still for `LONG_PRESS_MS` opens the context menu, as a
     * right-click does. A gesture that became a pinch or a long press taps nothing when it ends.
     */
    const LONG_PRESS_MS = 500;
    const LONG_PRESS_SLOP_PX = 10;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { startDistance: number; startZoom: number; lastMid: { x: number; y: number } } | null = null;
    /** True from a pinch or long press until every finger has lifted: no hex tap comes out of it. */
    let gestureConsumed = false;
    let longPressTimer: ReturnType<typeof setTimeout> | undefined;
    /** How the last press on the board was made, handed on with the hex tap it produces. */
    let lastPointerType = 'mouse';

    function cancelLongPress(): void {
      clearTimeout(longPressTimer);
      longPressTimer = undefined;
    }

    function wrappedOnHexClick(x: number, y: number): void {
      if (suppressNextClick || gestureConsumed) {
        suppressNextClick = false;
        return;
      }
      onHexClick(x, y, { touch: lastPointerType !== 'mouse' });
    }

    function twoFingers(): { mid: { x: number; y: number }; distance: number } | null {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return null;
      return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.hypot(a.x - b.x, a.y - b.y) };
    }

    /** Opens the context menu for the hex under client point (x, y) -- a long press. */
    function longPress(x: number, y: number): void {
      longPressTimer = undefined;
      if (!board || !onHexRightClick || pointers.size !== 1 || dragDistance > LONG_PRESS_SLOP_PX) return;
      gestureConsumed = true;
      dragActive = false;
      const rect = host.getBoundingClientRect();
      const scale = board.stage.scale.x;
      const hex = pixelToHex((x - rect.left - board.stage.x) / scale, (y - rect.top - board.stage.y) / scale);
      if (hex.x < 1 || hex.y < 1 || hex.x > snapshot.map.width || hex.y > snapshot.map.height) return;
      // The finger lifting afterwards makes a click; it must not land on the menu's "click outside closes me".
      const swallow = (e: Event): void => {
        e.stopPropagation();
        e.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 700);
      onHexRightClick(hex.x - 1, hex.y - 1, x, y);
    }

    function onPointerDown(e: PointerEvent): void {
      lastPointerType = e.pointerType;
      if (!board || viewLocked) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (pointers.size === 0) gestureConsumed = false;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      cancelScroll();
      if (pointers.size === 1) {
        dragActive = true;
        dragDistance = 0;
        dragStart = { x: e.clientX, y: e.clientY };
        dragOrigin = { x: board.stage.x, y: board.stage.y };
        if (e.pointerType !== 'mouse') {
          const { clientX, clientY } = e;
          longPressTimer = setTimeout(() => longPress(clientX, clientY), LONG_PRESS_MS);
        }
        return;
      }
      // A second finger: the drag becomes a pinch.
      cancelLongPress();
      dragActive = false;
      gestureConsumed = true;
      const two = twoFingers();
      if (two) pinch = { startDistance: Math.max(1, two.distance), startZoom: zoom, lastMid: two.mid };
    }

    function onPointerMove(e: PointerEvent): void {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!board) return;
      if (pinch) {
        const two = twoFingers();
        if (!two) return;
        const rect = host.getBoundingClientRect();
        // Pan with the midpoint, then zoom about it.
        const scale = board.stage.scale.x;
        applyView({ x: board.stage.x + two.mid.x - pinch.lastMid.x, y: board.stage.y + two.mid.y - pinch.lastMid.y, scale });
        pinch.lastMid = two.mid;
        setZoom(pinchZoom(pinch.startZoom, two.distance / pinch.startDistance), { x: two.mid.x - rect.left, y: two.mid.y - rect.top });
        return;
      }
      if (!dragActive) return;
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      dragDistance = Math.max(dragDistance, Math.hypot(dx, dy));
      if (dragDistance > LONG_PRESS_SLOP_PX) cancelLongPress();
      applyView({ x: dragOrigin.x + dx, y: dragOrigin.y + dy, scale: board.stage.scale.x });
    }

    /** A finger lifting: the gesture it belonged to ends when the last one does. */
    function releasePointer(e: PointerEvent): void {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) {
        cancelLongPress();
        dragActive = false;
      }
    }

    function onPointerUpCapture(e: PointerEvent): void {
      if (dragActive && dragDistance > DRAG_THRESHOLD_PX) suppressNextClick = true;
      releasePointer(e);
    }

    function onWindowPointerUp(e: PointerEvent): void {
      releasePointer(e);
    }

    /**
     * Phase 22, the user's call: the wheel pans, as upstream's
     * (`mouse_handler_base::mouse_wheel`: `scroll_speed` px per notch, Alt
     * swaps the axes), and Ctrl+wheel zooms about the pointer -- smoothly, by
     * how far the wheel turned (a mouse notch is about a quarter, a trackpad
     * pinch arrives as Ctrl+wheel in small steps), not upstream's level steps.
     */
    function onWheel(e: WheelEvent): void {
      if (!board || viewLocked) return;
      e.preventDefault();
      // deltaMode: 0 pixels (a notch is ~100), 1 lines (a notch is 3), 2 pages.
      const unit = e.deltaMode === 1 ? 100 / 3 : e.deltaMode === 2 ? 800 : 1;
      if (e.ctrlKey) {
        const d = Math.max(-300, Math.min(300, e.deltaY * unit));
        const rect = host.getBoundingClientRect();
        setZoom(zoom * Math.exp(-d * WHEEL_ZOOM_PER_PIXEL), { x: e.clientX - rect.left, y: e.clientY - rect.top });
        return;
      }
      const perPixel = displayPrefs.peek().scrollSpeed / 100;
      let dx = e.deltaX * unit * perPixel;
      let dy = e.deltaY * unit * perPixel;
      if (e.altKey) [dx, dy] = [dy, dx];
      cancelScroll();
      applyView({ x: board.stage.x - dx, y: board.stage.y - dy, scale: board.stage.scale.x });
    }

    // `pointerdown`/`pointermove` on the host are enough for a drag that
    // stays over the canvas; `pointerup` is also listened to on `window`
    // (in addition to the capture listener below) so a drag ending outside
    // the canvas still clears `dragActive`.
    host.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowPointerUp);
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
      // Phase 23: a browser's own long-press `contextmenu` (Android) must not reach the menu we opened
      // for the same press -- it closes on any context menu event outside itself.
      if (pointers.size > 0 || lastPointerType !== 'mouse') e.stopPropagation();
    }
    host.addEventListener('contextmenu', onContextMenu);

    /*
     * Phase 22: edge-of-screen panning, `controller_base::handle_scroll`:
     * with the pointer within 10 px (`mouse_scroll_threshold`) of the
     * window's edge, pan that way at `scroll_speed * 0.036` px/ms, starting
     * from a 1 ms step so a brush past the edge barely moves. Upstream turns
     * it off over its menu buttons; here, over any control, so reaching for
     * a button at the edge doesn't drag the map along. Nothing happens once
     * the pointer leaves the page or the window loses focus.
     */
    const EDGE_THRESHOLD = 10;
    let edgePointer: { x: number; y: number; overControl: boolean } | null = null;
    let edgeScrolling = false;
    let edgeLast = 0;
    let edgeFrame = 0;
    function onWindowPointerMoveForEdge(e: PointerEvent): void {
      // A finger near the edge is dragging or tapping, not resting there.
      if (e.pointerType !== 'mouse') {
        edgePointer = null;
        return;
      }
      const target = e.target instanceof Element ? e.target : null;
      edgePointer = { x: e.clientX, y: e.clientY, overControl: !!target?.closest('button, a, input, select, textarea, [role="menu"], [role="menuitem"]') };
    }
    function clearEdgePointer(): void {
      edgePointer = null;
    }
    function onDocumentMouseOut(e: MouseEvent): void {
      if (!e.relatedTarget) edgePointer = null;
    }
    function edgeTick(now: number): void {
      edgeFrame = requestAnimationFrame(edgeTick);
      const p = edgePointer;
      let dx = 0;
      let dy = 0;
      if (p && !p.overControl && edgeScroll && !viewLocked && !dragActive && board && displayPrefs.peek().mouseScrolling && document.hasFocus()) {
        if (p.y < EDGE_THRESHOLD) dy -= 1;
        if (p.y > window.innerHeight - EDGE_THRESHOLD) dy += 1;
        if (p.x < EDGE_THRESHOLD) dx -= 1;
        if (p.x > window.innerWidth - EDGE_THRESHOLD) dx += 1;
      }
      if (dx === 0 && dy === 0) {
        edgeScrolling = false;
        return;
      }
      // If we weren't scrolling already, start small.
      const dt = edgeScrolling ? now - edgeLast : 1;
      edgeScrolling = true;
      edgeLast = now;
      const amount = edgeScrollAmount(dt, displayPrefs.peek().scrollSpeed);
      cancelScroll();
      scrollByPixels(dx * amount, dy * amount);
    }
    window.addEventListener('pointermove', onWindowPointerMoveForEdge);
    window.addEventListener('blur', clearEdgePointer);
    document.addEventListener('mouseout', onDocumentMouseOut);
    edgeFrame = requestAnimationFrame(edgeTick);

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
      // Phase 28a P5: this scenario's terrain bundle (built by apps/web/scripts/build-image-atlases.mjs),
      // scoped under its campaign directory: a bare scenario id is only unique within its own campaign
      // (Dead Water and Under the Burning Suns both ship a 13_Epilogue), so the id alone could fetch the
      // wrong campaign's terrain bundle (a real bug, found 2026-09-27). Images not in the bundle are
      // fetched on their own, so a missing/mis-scoped one only costs requests, never a wrong-looking board.
      // Terrain shared by many scenarios (one bundle, cached across all of them), then this scenario's own.
      ImageCache.setAtlasManifests(
        snapshot.assetDir
          ? [dataUrl('atlases/_common/terrain.json'), dataUrl(`atlases/${snapshot.assetDir}/${snapshot.scenario.id}/terrain.json`)]
          : [],
      );
      // Phase 28a P6: recruitable types' bundles are registered (downloaded on first use)...
      ImageCache.addAtlasManifests(snapshot.teams.flatMap((team) => team.recruit ?? []).map((id) => dataUrl(unitBundleManifestUrl(id))));
      // ...and types on the board are downloaded now, so their first animation needs no network.
      registerUnitBundles(units);

      const newBoard = new SnapshotBoard(snapshot, {
        imageBaseUrl: GAME_IMAGES,
        engineImageBaseUrl: ENGINE_IMAGES,
        onHexClick: wrappedOnHexClick,
        onHexRightClick,
        onHexHover: (x, y) => {
          hoveredHex = { x, y };
          onHexHoverChange?.({ x, y });
        },
        // Phase 28a P3: the rules (~17.5 MB JSON) are fetched, parsed and matched in a worker.
        terrainGraphicsRulesUrl: dataUrl('terrain-graphics-rules.json'),
      });
      await newBoard.render();
      if (cancelled) {
        destroyApp(app, true);
        return;
      }
      board = newBoard;
      app.stage.addChild(newBoard.stage);

      // Open at the saved zoom, centred on the map (clamped: a map smaller than the screen sits in its middle).
      const openScale = scaleForZoom(zoom);
      applyView(centerOn({ x: 0, y: 0, scale: openScale }, mapCentre(), mapSize(), { width: app.screen.width, height: app.screen.height }));
      // Re-bounds-check whenever the canvas changes size (window resize, side panel reflow).
      const resizeObserver = new ResizeObserver(() => {
        // Pixi's `resizeTo` follows window resizes only; the canvas must also follow its host when the
        // layout around it changes (Phase 23: collapsing the infobox grows the board, no window resize).
        app?.resize();
        const view = currentView();
        if (view) applyView(view);
        onViewportResize?.();
      });
      resizeObserver.observe(host);
      disconnectResize = () => resizeObserver.disconnect();

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
        status = fmt(tx('failed to load: $error'), { error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => markReady());

    return () => {
      cancelled = true;
      disconnectResize();
      host.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', onWindowPointerUp);
      cancelLongPress();
      host.removeEventListener('pointerup', onPointerUpCapture, true);
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('pointerleave', onPointerLeave);
      host.removeEventListener('contextmenu', onContextMenu);
      cancelAnimationFrame(edgeFrame);
      window.removeEventListener('pointermove', onWindowPointerMoveForEdge);
      window.removeEventListener('blur', clearEdgePointer);
      document.removeEventListener('mouseout', onDocumentMouseOut);
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
    ImageCache.addAtlasManifests(new Set(list.map((unit) => dataUrl(unitBundleManifestUrl(unit.typeId)))), { prefetch: true });
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
    void board?.setGridVisible(grid);
  });

  $effect(() => {
    board?.updateFogShroud(hexVisibility);
  });

  $effect(() => {
    if (terrain) void board?.updateTerrain(terrain);
  });

  $effect(() => {
    void board?.updateItems(items);
  });

  $effect(() => {
    board?.updateLabels(labels);
  });

  $effect(() => {
    if (board) board.soundSink = onSound ?? null;
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
  /** Skip Animation: the animation and camera glide in progress end at once. */
  export function skipAnimations(): void {
    board?.skipAnimations();
    cancelScroll();
  }

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
  export async function ensureUnitVisual(unit: SnapshotUnit, options: { hidden?: boolean } = {}): Promise<void> {
    await board?.ensureUnitVisual(unit, options);
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
   * Phase 19: the hex at the centre of the viewed map area (engine 0-based) at the
   * current pan/zoom -- where sound sources measure their distance from
   * (`display::hex_clicked_on` at the middle of `map_area`). Null before the board exists.
   */
  export function viewCenterHex(): { x: number; y: number } | null {
    if (!board || !canvasHost) return null;
    const rect = canvasHost.getBoundingClientRect();
    const scale = board.stage.scale.x || 1;
    const coord = pixelToHex((rect.width / 2 - board.stage.x) / scale, (rect.height / 2 - board.stage.y) / scale);
    return { x: coord.x - 1, y: coord.y - 1 };
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
      viewCenterHex,
      freezeAnimationsForCapture,
      setRenderingPaused,
      /** Phase 22: where the camera is (stage position/scale, canvas size) and the zoom level in hex px. */
      camera: () => ({ ...viewState(), zoom: zoomLevel() }),
      /** Phase 22: whether the grid overlay shows, over how many hexes. */
      grid: () => board?.gridState() ?? null,
      /** Phase 22: start a camera scroll to hex (x, y) (engine 0-based) the way `type` asks; resolves on arrival. */
      scrollToHex: (x: number, y: number, type: ScrollType) => scrollToHex(x, y, type),
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

  /** Phase 15 `zoomin`/`zoomout`: to the next of upstream's levels in that direction, about the viewport centre (from between two levels, the nearer one that way). */
  export function zoomStep(increase: boolean): void {
    setZoom(stepZoom(zoom, increase));
  }

  /**
   * Phase 17 `[zoom] relative=yes`: `set_zoom(factor * zoom, true)` -- the
   * result snaps to the nearest level (Phase 22), about the viewport centre.
   */
  export function zoomBy(factor: number): void {
    setZoom(ZOOM_LEVELS[zoomIndexFor(zoom * factor)]!);
  }

  /** Phase 17 `[zoom] factor=`: an absolute scale, snapped the same way. */
  export function zoomTo(factor: number): void {
    setZoom(ZOOM_LEVELS[zoomIndexFor(factor * DEFAULT_ZOOM)]!);
  }

  /**
   * `zoomdefault` (`display::toggle_default_zoom`): to 1:1, or -- already
   * there -- back to the zoom it came from.
   */
  export function zoomDefault(): void {
    setZoom(zoom !== DEFAULT_ZOOM ? DEFAULT_ZOOM : lastZoom);
  }

  /** The current zoom as upstream's hex size in px (for checks and the status line). */
  export function zoomLevel(): number {
    return zoom;
  }

  /** Phase 17 `[scroll]`: shift the view by a pixel delta (upstream's own `display::scroll`), bounds-checked. */
  export function scrollByPixels(dx: number, dy: number): void {
    const view = currentView();
    if (view) applyView({ ...view, x: view.x - dx, y: view.y - dy });
  }

  /**
   * Phase 17 `[lock_view]`/`[unlock_view]`: while locked, the player
   * cannot pan or zoom -- a cutscene owns the camera -- and unforced
   * scrolls (following unit actions) stay put, as `scroll_to_xy`'s own
   * `view_locked_` check. Scripted scrolls are forced and still move.
   */
  export function setViewLocked(locked: boolean): void {
    viewLocked = locked;
  }

  /** The glide in flight, if any: a new scroll or the player grabbing the map cancels it. */
  let scrollInFlight: { cancel: () => void } | null = null;

  function cancelScroll(): void {
    scrollInFlight?.cancel();
  }

  /** Longest a glide may take before it jumps to the end: a hidden tab stops animation frames, and nothing may wait on one forever. */
  const SCROLL_TIMEOUT_MS = 4000;

  function glideTo(target: View, type: ScrollType): Promise<void> {
    cancelScroll();
    const from = currentView();
    if (!from) return Promise.resolve();
    const { scrollSpeed } = displayPrefs.peek();
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (hidden || scrollWarps(type, scrollSpeed, 1, prefersReducedMotion())) {
      applyView(target);
      return Promise.resolve();
    }
    const anim = new ScrollAnimation(target.x - from.x, target.y - from.y, scrollSpeed);
    return new Promise((resolve) => {
      let raf = 0;
      let last = performance.now();
      const finish = (): void => {
        cancelAnimationFrame(raf);
        clearTimeout(timeout);
        scrollInFlight = null;
        resolve();
      };
      const timeout = setTimeout(() => {
        applyView(target);
        finish();
      }, SCROLL_TIMEOUT_MS);
      const frame = (now: number): void => {
        const step = anim.step((now - last) / 1000);
        last = now;
        applyView({ x: from.x + step.x, y: from.y + step.y, scale: from.scale });
        if (step.done) finish();
        else raf = requestAnimationFrame(frame);
      };
      scrollInFlight = { cancel: finish };
      raf = requestAnimationFrame(frame);
    });
  }

  interface ScrollRequest {
    type: ScrollType;
    /**
     * `force`: move even under `[lock_view]` or with "follow unit actions"
     * off. Upstream's default -- only the unit-action displays
     * (`unit_display::move_unit`, attacks, recruits, heals) pass false.
     */
    force?: boolean;
    addSpacing?: number;
    onlyIfPossible?: boolean;
  }

  /**
   * Phase 22: `display::scroll_to_tiles` -- bring `hexes` (engine 0-based,
   * already filtered for fog where upstream's `check_fogged` applies) on
   * screen the way `type` asks, gliding unless it warps. Resolves when the
   * camera has arrived, so a caller can hold the next beat until then.
   */
  export function scrollToHexes(hexes: readonly { x: number; y: number }[], request: ScrollRequest): Promise<void> {
    const force = request.force ?? true;
    if (!force && (viewLocked || !displayPrefs.peek().scrollToAction)) return Promise.resolve();
    const view = currentView();
    const viewport = viewportSize();
    if (!view || !viewport) return Promise.resolve();
    const target = scrollTargetForHexes(view, hexes, request.type, mapSize(), viewport, {
      addSpacing: request.addSpacing,
      onlyIfPossible: request.onlyIfPossible,
    });
    return target ? glideTo(target, request.type) : Promise.resolve();
  }

  /** `scroll_to_tile`: one hex. */
  export function scrollToHex(x: number, y: number, type: ScrollType, force = true): Promise<void> {
    return scrollToHexes([{ x, y }], { type, force });
  }

  /** Phase 15: centre `(x, y)` (engine 0-based) at once -- `scroll_to_tile(loc, WARP)`, what next-unit and goto-leader use. */
  export function centerOnHex(x: number, y: number): void {
    void scrollToHex(x, y, 'warp');
  }

  /** Phase 16/22: bring `(x, y)` on screen only if it is not already -- `ONSCREEN`, or `ONSCREEN_WARP` with `instant`. */
  export function scrollToHexIfOffscreen(x: number, y: number, instant = false): Promise<void> {
    return scrollToHex(x, y, instant ? 'onscreen-warp' : 'onscreen');
  }

  /** Phase 22, for the minimap and checks: the current view and the canvas size. */
  export function viewState(): { view: View; viewport: { width: number; height: number } } | null {
    const view = currentView();
    const viewport = viewportSize();
    return view && viewport ? { view, viewport } : null;
  }

  /** Phase 22, the minimap: centre world point `p` (unscaled board pixels) at once. */
  export function centerOnWorldPoint(p: { x: number; y: number }): void {
    const view = currentView();
    const viewport = viewportSize();
    if (!view || !viewport) return;
    cancelScroll();
    applyView(centerOn(view, p, mapSize(), viewport));
  }
</script>

<div class="board-view" data-board-ready={board ? 'true' : 'false'}>
  <p class="status" class:busy={status !== null}>
    {status ?? readyLabel} <span class="hint">{tx('(drag or scroll to pan, Ctrl+scroll to zoom)')}</span>
    {#if hoveredHex}
      &middot; {tx('Hex')}: ({hoveredHex.x}, {hoveredHex.y})
      {#if hoverDefensePercent}
        {@const def = hoverDefensePercent(hoveredHex.x, hoveredHex.y)}
        {#if def !== null && def !== undefined}
          &middot; {th('Defense')}: {def}%
        {/if}
      {/if}
    {/if}
  </p>
  <div class="canvas-host" bind:this={canvasHost} role="application" aria-label={tx('Game board')} aria-roledescription={tx('map')}></div>
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
    font-family: var(--font-ui);
    font-size: 0.8rem;
    color: #aaa;
    background: #181818;
  }
  .canvas-host {
    flex: 1 1 auto;
    min-height: 0;
    touch-action: none;
  }
  /* Phase 23, a phone: the line is about the mouse (there is no hover under a finger), and the infobox shows the tapped hex's terrain.
     While the scenario loads (or failed to), it stays, without the mouse advice: it is the only sign of progress. */
  @media (max-width: 720px), (max-height: 500px) {
    .status:not(.busy),
    .hint {
      display: none;
    }
  }
  /* A phone: the board shares the column with the side panel (see GameShell), so it must be able to shrink. */
  @media (max-width: 720px) {
    .board-view {
      flex: 1 1 0;
      min-height: 0;
    }
  }
</style>
