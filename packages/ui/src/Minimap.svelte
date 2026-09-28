<script lang="ts">
  /**
   * Phase 22: the minimap (upstream's `[theme] mini-map` and the five
   * `minimap-button-*`s beside it). What it draws is decided by the
   * renderer's `buildMinimap` (a port of `prep_minimap_for_rendering`); this
   * component only paints that list:
   *
   *  - the raw image (terrain tiles, villages, units) into an offscreen canvas
   *    at upstream's pixels-per-hex, redrawn when the board changes;
   *  - that image scaled into the visible canvas, nearest-neighbour, keeping
   *    its aspect ratio and centred (`fitMinimap`), on upstream's background;
   *  - the white outline of what the board shows (`minimapViewRect`),
   *    repainted whenever the camera moves -- a blit, not a rebuild.
   *
   * Clicking or dragging on it centres the board there at once, as
   * upstream's minimap scroll does (`scroll_to_tile(loc, WARP)`).
   *
   * For screen readers the picture carries nothing the keyboard hex cursor
   * doesn't already announce, so it is hidden from them; the buttons are
   * ordinary toggle buttons.
   */
  import {
    buildMinimap,
    fitMinimap,
    minimapViewRect,
    minimapPointToBoard,
    minimapHexRect,
    imageUrl,
    type MinimapInput,
    type MinimapOptions,
    type MinimapStyle,
    type MinimapDrawList,
    type Rect,
    type View,
  } from '@wesnothweb2/renderer';
  import { t, tx } from './i18n/locale.js';

  let {
    input,
    options,
    style,
    camera = null,
    onNavigate,
    onToggle,
    onZoomDefault,
  }: {
    input: MinimapInput | null;
    options: MinimapOptions;
    style: MinimapStyle;
    /** The board's current view and canvas size (`GameBoardView.viewState`), for the outline. */
    camera?: { view: View; viewport: { width: number; height: number } } | null;
    /** Centre the board on this point (unscaled board pixels). */
    onNavigate: (point: { x: number; y: number }) => void;
    onToggle: (key: keyof MinimapOptions) => void;
    /** `minimap-button-1`: upstream's `zoomdefault`. */
    onZoomDefault: () => void;
  } = $props();

  /** Upstream's minimap background (`draw_minimap`: 31, 31, 23). */
  const BACKGROUND = 'rgb(31, 31, 23)';

  let host = $state<HTMLDivElement | undefined>();
  let canvas = $state<HTMLCanvasElement | undefined>();
  let size = $state({ width: 0, height: 0 });
  /** The raw image, rebuilt when the draw list changes or one of its tiles finishes loading. */
  let raw: HTMLCanvasElement | null = null;
  /** Where the raw image was last drawn in the canvas (CSS px) -- upstream's `minimap_location_`. */
  let location: Rect = { x: 0, y: 0, w: 0, h: 0 };
  let tileGeneration = $state(0);

  const images = new Map<string, HTMLImageElement>();

  /** The tile at `path`, if loaded; starts loading it (and repaints once it arrives) otherwise. */
  function tile(path: string): HTMLImageElement | null {
    let img = images.get(path);
    if (!img) {
      img = new Image();
      // Tiles come from the game data bucket in production; CORS mode keeps the canvas readable.
      img.crossOrigin = 'anonymous';
      img.onload = () => tileGeneration++;
      img.onerror = () => {};
      img.src = imageUrl(path);
      images.set(path, img);
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  const list = $derived<MinimapDrawList | null>(input ? buildMinimap(input, options, style) : null);

  const rgb = (c: readonly [number, number, number]): string => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

  function paintRaw(l: MinimapDrawList): HTMLCanvasElement {
    const c = raw ?? document.createElement('canvas');
    c.width = l.width;
    c.height = l.height;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, c.width, c.height);
    for (const cell of l.terrain) {
      if ('color' in cell) {
        ctx.fillStyle = rgb(cell.color);
        ctx.fillRect(cell.rect.x, cell.rect.y, cell.rect.w, cell.rect.h);
        continue;
      }
      for (const path of cell.images) {
        const img = tile(path);
        if (img) ctx.drawImage(img, cell.rect.x, cell.rect.y, cell.rect.w, cell.rect.h);
      }
    }
    for (const mark of [...l.villages, ...l.units]) {
      ctx.fillStyle = rgb(mark.color);
      ctx.fillRect(mark.rect.x, mark.rect.y, mark.rect.w, mark.rect.h);
    }
    return c;
  }

  // Rebuild the raw image when what it shows changes (or a tile arrives).
  $effect(() => {
    void tileGeneration;
    raw = list ? paintRaw(list) : null;
    paint();
  });

  // Repaint (a blit and a rectangle) when the camera moves or the canvas resizes.
  $effect(() => {
    void camera;
    void size;
    paint();
  });

  function paint(): void {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = size;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, width, height);
    if (!raw || !list || !input) return;
    location = fitMinimap({ width: raw.width, height: raw.height }, { x: 0, y: 0, w: width, h: height });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(raw, location.x, location.y, location.w, location.h);
    if (camera) {
      const r = minimapViewRect(camera.view, camera.viewport, { w: input.width, h: input.height }, location);
      ctx.strokeStyle = 'rgb(255, 255, 255)';
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    }
  }

  $effect(() => {
    if (!host) return;
    const el = host;
    const observer = new ResizeObserver(() => {
      size = { width: el.clientWidth, height: el.clientHeight };
    });
    observer.observe(el);
    return () => observer.disconnect();
  });

  let dragging = false;

  function navigateTo(e: PointerEvent): void {
    if (!canvas || !input || location.w === 0) return;
    const rect = canvas.getBoundingClientRect();
    const px = Math.min(location.x + location.w - 1, Math.max(location.x, e.clientX - rect.left));
    const py = Math.min(location.y + location.h - 1, Math.max(location.y, e.clientY - rect.top));
    onNavigate(minimapPointToBoard(px, py, { w: input.width, h: input.height }, location));
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    dragging = true;
    canvas?.setPointerCapture(e.pointerId);
    navigateTo(e);
  }

  function onPointerMove(e: PointerEvent): void {
    if (dragging) navigateTo(e);
  }

  function onPointerUp(e: PointerEvent): void {
    dragging = false;
    canvas?.releasePointerCapture(e.pointerId);
  }

  /** The centre of hex (x, y) (engine 0-based) on the visible canvas, in CSS px from its top-left. */
  function hexCentre(x: number, y: number): { x: number; y: number } | null {
    if (!list || !raw || location.w === 0) return null;
    const r = minimapHexRect(x, y, list.scale);
    // Villages and units are drawn three quarters of a hex wide from the rect's left.
    const rx = r.x + (list.scale * 3) / 8;
    const ry = r.y + list.scale / 2;
    return { x: location.x + (rx * location.w) / raw.width, y: location.y + (ry * location.h) / raw.height };
  }

  // Dev-only hook for browser checks (apps/web/scripts/minimap-camera-playthrough.mjs): the colour drawn
  // at a hex, and where a hex is on screen, so a check can click it. Absent in production builds.
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV && typeof window !== 'undefined') {
    (window as unknown as { __wesnothMinimap?: unknown }).__wesnothMinimap = {
      clientPointOfHex(x: number, y: number): { x: number; y: number } | null {
        const c = hexCentre(x, y);
        if (!c || !canvas) return null;
        const rect = canvas.getBoundingClientRect();
        return { x: rect.left + c.x, y: rect.top + c.y };
      },
      colorAtHex(x: number, y: number): [number, number, number] | null {
        const c = hexCentre(x, y);
        if (!c || !canvas) return null;
        const dpr = window.devicePixelRatio || 1;
        const d = canvas.getContext('2d')!.getImageData(Math.floor(c.x * dpr), Math.floor(c.y * dpr), 1, 1).data;
        return [d[0]!, d[1]!, d[2]!];
      },
    };
  }

  /**
   * Upstream's buttons under the minimap, in its order (`data/themes/_initial.cfg`'s
   * `minimap-button-1..6`): default zoom, then the five minimap toggles. Each is a 25 px square
   * button (`button_square_25`) with the command's icon (`icons/action/<command>_25.png`, or the theme's
   * own overlay for units and villages); a toggle that is on shows the pressed images. Tooltips are
   * the hotkey commands' names (`auto_tooltip`).
   */
  const buttons: ReadonlyArray<{ key: keyof MinimapOptions; label: () => string; icon: string }> = [
    { key: 'drawTerrain', label: () => t('Toggle Minimap Terrain Drawing'), icon: 'minimap-draw-terrain_25' },
    { key: 'drawUnits', label: () => t('Toggle Minimap Unit Drawing'), icon: 'editor-tool-unit_25' },
    { key: 'drawVillages', label: () => t('Toggle Minimap Village Drawing'), icon: 'editor-tool-village_25' },
    { key: 'movementCoding', label: () => t('Toggle Minimap Unit Coding'), icon: 'minimap-unit-coding_25' },
    { key: 'terrainCoding', label: () => t('Toggle Minimap Terrain Coding'), icon: 'minimap-terrain-coding_25' },
  ];
  const icon = (name: string, pressed: boolean): string => imageUrl(`engine/icons/action/${name}${pressed ? '-pressed' : ''}.png`);
  const frame = (pressed: boolean): string => imageUrl(`engine/buttons/button_square/button_square_25${pressed ? '-pressed' : ''}.png`);
</script>

<div class="minimap" data-testid="minimap">
  <div class="map" bind:this={host}>
    <canvas
      bind:this={canvas}
      aria-hidden="true"
      style={`width: ${size.width}px; height: ${size.height}px`}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
    ></canvas>
  </div>
  <div class="buttons" role="toolbar" aria-label={tx('Minimap')}>
    <button type="button" title={t('Default Zoom')} aria-label={t('Default Zoom')} onclick={onZoomDefault} style={`background-image: url("${frame(false)}")`}>
      <img src={icon('zoomdefault_25', false)} alt="" />
    </button>
    {#each buttons as b (b.key)}
      <button
        type="button"
        aria-pressed={options[b.key]}
        title={b.label()}
        aria-label={b.label()}
        data-testid={`minimap-${b.key}`}
        style={`background-image: url("${frame(options[b.key])}")`}
        onclick={() => onToggle(b.key)}><img src={icon(b.icon, options[b.key])} alt="" /></button
      >
    {/each}
  </div>
</div>

<style>
  .minimap {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 0 0 auto;
    margin-bottom: 0.5rem;
  }
  .map {
    height: 10rem;
    min-width: 0;
    position: relative;
    background: rgb(31, 31, 23);
    border: 1px solid #4a4432;
  }
  canvas {
    display: block;
    cursor: crosshair;
    touch-action: none;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 1px;
  }
  .buttons button {
    width: 25px;
    height: 25px;
    padding: 0;
    border: 0;
    background: transparent center / 25px 25px no-repeat;
    cursor: pointer;
    display: grid;
    place-items: center;
  }
  .buttons img {
    width: 25px;
    height: 25px;
    pointer-events: none;
  }
  /* Phase 23, a finger: upstream's 25 px squares drawn at 40 px, spaced apart. */
  @media (pointer: coarse) {
    .buttons {
      gap: 4px;
    }
    .buttons button,
    .buttons img {
      width: 40px;
      height: 40px;
      background-size: 40px 40px;
    }
  }
  .buttons button:focus-visible {
    outline: 2px solid #ffd54a;
    outline-offset: 1px;
  }
</style>
