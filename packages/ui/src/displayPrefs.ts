/**
 * Phase 22: the map-view preferences, kept per browser like the audio and accessibility settings.
 * Each is upstream's own preference of the same meaning and default (`preferences.hpp`):
 *
 *  - `scrollSpeed` (`scroll`, 1-100, default 50): camera scroll speed -- wheel panning, edge panning,
 *    and the animated `scroll_to_xy`, whose top speed is `scrollSpeed * 60` px/s. 100 jumps instead.
 *  - `mouseScrolling` (`mouse_scrolling`, on): pan when the pointer rests at the window's edge.
 *  - `scrollToAction` (`scroll_to_action`, on): bring other sides' moves and attacks on screen.
 *  - `grid` (`grid`, off): hex outlines over the map.
 *  - `zoom` (`tile_size`, 72): the hex size the map opens at -- upstream saves every zoom change.
 *  - `minimap`: the five minimap buttons (`minimap_draw_terrain`, `minimap_terrain_coding`,
 *    `minimap_draw_units`, `minimap_movement_coding`, `minimap_draw_villages`), all on.
 *  - Phase 28b: `disableAutoMoves` (`disable_auto_moves`, off): units don't carry on with their multi-turn
 *    orders by themselves when a turn begins.
 *  - Phase 23, ours (upstream has no phone layout): `topBarCollapsed` and `infoboxCollapsed`, whether
 *    the compact layout shows the top bar's full status and the infobox's body. Both open by default.
 *  - Phase 24, the rest of upstream's preferences the port has something to apply to:
 *    - `turbo` (off) and `turboSpeed` (`turbo_speed`, 2, one of `TURBO_SPEEDS`): Accelerated speed;
 *      `turboSpeed()` below is `display::turbo_speed`;
 *    - `skipAiMoves` (`skip_ai_moves`, off): AI sides' turns are not animated;
 *    - `turnDialog` (`turn_dialog`, off): "It is now X's turn" before each human turn;
 *    - `saveReplays` (`save_replays`, on) and `deleteSaves` (`delete_saves`, off): what happens to
 *      saves when a scenario is won;
 *    - `floatingLabels` (`floating_labels`, on): the damage and healing numbers;
 *    - `showSideColors` (`show_side_colors`, on): the team colour ellipses under units;
 *    - `animateMap` (`animate_map`, on) and `animateWater` (`animate_water`, on);
 *    - `showCombat` (`show_combat`, on): attack and death animations;
 *    - `askDelete` (`ask_delete`, on): deleting a save asks first;
 *    - `showAttackMissIndicator` (`show_attack_miss_indicator`, off): "miss" floats over a missed unit;
 *    - `monteCarlo` (`damage_prediction_allow_monte_carlo_simulation`, on).
 *    The auto-save limit (`auto_save_max`) stays where Phase 26 keeps it, with the saves.
 *
 * `parseDisplayPrefs` is pure (tested in node); `displayPrefs` is the live, reactive store.
 */
import { createSubscriber } from 'svelte/reactivity';

export interface MinimapPrefs {
  drawTerrain: boolean;
  terrainCoding: boolean;
  drawUnits: boolean;
  movementCoding: boolean;
  drawVillages: boolean;
}

export interface DisplayPrefs {
  scrollSpeed: number;
  mouseScrolling: boolean;
  scrollToAction: boolean;
  grid: boolean;
  zoom: number;
  minimap: MinimapPrefs;
  topBarCollapsed: boolean;
  infoboxCollapsed: boolean;
  disableAutoMoves: boolean;
  turbo: boolean;
  turboSpeed: number;
  skipAiMoves: boolean;
  turnDialog: boolean;
  saveReplays: boolean;
  deleteSaves: boolean;
  floatingLabels: boolean;
  showSideColors: boolean;
  animateMap: boolean;
  animateWater: boolean;
  showCombat: boolean;
  askDelete: boolean;
  showAttackMissIndicator: boolean;
  monteCarlo: boolean;
}

/** The Accelerated speed slider's steps (`preferences_dialog`'s `accl_speeds_`). */
export const TURBO_SPEEDS: readonly number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4, 8, 16];

export const DEFAULT_DISPLAY_PREFS: Readonly<DisplayPrefs> = {
  scrollSpeed: 50,
  mouseScrolling: true,
  scrollToAction: true,
  grid: false,
  zoom: 72,
  minimap: { drawTerrain: true, terrainCoding: true, drawUnits: true, movementCoding: true, drawVillages: true },
  topBarCollapsed: false,
  infoboxCollapsed: false,
  disableAutoMoves: false,
  turbo: false,
  turboSpeed: 2,
  skipAiMoves: false,
  turnDialog: false,
  saveReplays: true,
  deleteSaves: false,
  floatingLabels: true,
  showSideColors: true,
  animateMap: true,
  animateWater: true,
  showCombat: true,
  askDelete: true,
  showAttackMissIndicator: false,
  monteCarlo: true,
};

export const DISPLAY_PREFS_KEY = 'wesnothweb2.display';

/** Reads what `displayPrefs` wrote; anything missing or malformed takes its default. */
export function parseDisplayPrefs(raw: string | null | undefined): DisplayPrefs {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
  } catch {
    // Unreadable: the defaults.
  }
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
  const d = DEFAULT_DISPLAY_PREFS;
  const speed = data['scrollSpeed'];
  const zoom = data['zoom'];
  const mini = (data['minimap'] && typeof data['minimap'] === 'object' ? data['minimap'] : {}) as Record<string, unknown>;
  return {
    // prefs::scroll_speed clamps to 1..100.
    scrollSpeed: typeof speed === 'number' && Number.isFinite(speed) ? Math.min(100, Math.max(1, Math.round(speed))) : d.scrollSpeed,
    mouseScrolling: bool(data['mouseScrolling'], d.mouseScrolling),
    scrollToAction: bool(data['scrollToAction'], d.scrollToAction),
    grid: bool(data['grid'], d.grid),
    zoom: typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0 ? zoom : d.zoom,
    minimap: {
      drawTerrain: bool(mini['drawTerrain'], d.minimap.drawTerrain),
      terrainCoding: bool(mini['terrainCoding'], d.minimap.terrainCoding),
      drawUnits: bool(mini['drawUnits'], d.minimap.drawUnits),
      movementCoding: bool(mini['movementCoding'], d.minimap.movementCoding),
      drawVillages: bool(mini['drawVillages'], d.minimap.drawVillages),
    },
    topBarCollapsed: bool(data['topBarCollapsed'], d.topBarCollapsed),
    disableAutoMoves: bool(data['disableAutoMoves'], d.disableAutoMoves),
    infoboxCollapsed: bool(data['infoboxCollapsed'], d.infoboxCollapsed),
    turbo: bool(data['turbo'], d.turbo),
    turboSpeed: typeof data['turboSpeed'] === 'number' && TURBO_SPEEDS.includes(data['turboSpeed']) ? data['turboSpeed'] : d.turboSpeed,
    skipAiMoves: bool(data['skipAiMoves'], d.skipAiMoves),
    turnDialog: bool(data['turnDialog'], d.turnDialog),
    saveReplays: bool(data['saveReplays'], d.saveReplays),
    deleteSaves: bool(data['deleteSaves'], d.deleteSaves),
    floatingLabels: bool(data['floatingLabels'], d.floatingLabels),
    showSideColors: bool(data['showSideColors'], d.showSideColors),
    animateMap: bool(data['animateMap'], d.animateMap),
    animateWater: bool(data['animateWater'], d.animateWater),
    showCombat: bool(data['showCombat'], d.showCombat),
    askDelete: bool(data['askDelete'], d.askDelete),
    showAttackMissIndicator: bool(data['showAttackMissIndicator'], d.showAttackMissIndicator),
    monteCarlo: bool(data['monteCarlo'], d.monteCarlo),
  };
}

function load(): string | null {
  try {
    return localStorage.getItem(DISPLAY_PREFS_KEY);
  } catch {
    return null;
  }
}

class DisplayPrefsStore {
  #value: DisplayPrefs = parseDisplayPrefs(load());
  #notify: () => void = () => {};
  #subscribe = createSubscriber((update) => {
    this.#notify = update;
    return () => {
      this.#notify = () => {};
    };
  });

  /** The current preferences (reactive when read in a component or effect). */
  get value(): Readonly<DisplayPrefs> {
    this.#subscribe();
    return this.#value;
  }

  /** Reads without subscribing -- for event handlers and animation frames. */
  peek(): Readonly<DisplayPrefs> {
    return this.#value;
  }

  update(patch: Partial<Omit<DisplayPrefs, 'minimap'>> & { minimap?: Partial<MinimapPrefs> }): void {
    const next = { ...this.#value, ...patch, minimap: { ...this.#value.minimap, ...patch.minimap } };
    this.#value = parseDisplayPrefs(JSON.stringify(next));
    try {
      localStorage.setItem(DISPLAY_PREFS_KEY, JSON.stringify(this.#value));
    } catch {
      /* lasts for this page only */
    }
    this.#notify();
  }
}

export const displayPrefs = new DisplayPrefsStore();

/** `prefers-reduced-motion`: camera moves jump instead of gliding (Phase 20's motion policy). */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

let shiftHeld = false;
if (typeof window !== 'undefined') {
  const track = (e: KeyboardEvent): void => {
    shiftHeld = e.shiftKey;
  };
  window.addEventListener('keydown', track, true);
  window.addEventListener('keyup', track, true);
  window.addEventListener('blur', () => (shiftHeld = false));
}

/**
 * `display::turbo_speed`: the Accelerated speed when it is on, else 1 -- and holding Shift flips it, as
 * upstream's does. Unit animations, camera glides, floating labels and an `accelerate=yes` `[delay]` run
 * this many times faster.
 */
export function turboSpeed(prefs: Readonly<DisplayPrefs> = displayPrefs.peek()): number {
  return prefs.turbo !== shiftHeld ? prefs.turboSpeed : 1;
}
