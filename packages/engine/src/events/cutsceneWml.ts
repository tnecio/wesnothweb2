/**
 * TS port of WML's cutscene and camera tags -- the ones that used to be
 * registered here as headless no-ops because there was nothing they
 * could do: `[delay]`, `[scroll_to]`, `[scroll_to_unit]`, `[scroll]`,
 * `[lock_view]`/`[unlock_view]`, `[zoom]`, `[color_adjust]`,
 * `[screen_fade]`, `[move_unit_fake]`/`[move_units_fake]`,
 * `[animate_unit]`.
 *
 * Upstream these block their event by running a nested animation loop on
 * the same stack (`unit_display::move_unit`, `display::fade_to`,
 * `intf_delay`'s `play_slice` spin). Here each one yields a `CutsceneBeat`
 * (see `interaction.ts`) and resumes when whoever is driving the pump
 * says the beat is done -- instantly for a headless caller, after the
 * animation for `packages/ui`. That is what puts a `[message]` and the
 * movement before it in the right order at last.
 *
 * Sources: `data/lua/wml-tags.lua` (`scroll_to`, `scroll_to_unit`,
 * `scroll`, `lock_view`, `unlock_view`, `zoom`, `color_adjust`,
 * `screen_fade`, `delay`), `src/game_events/action_wml.cpp:354-430`
 * (`[move_unit_fake]`/`[move_units_fake]`, incl. its A*-routing between
 * waypoints), `data/lua/wml/animate_unit.lua`.
 *
 * NOT ported: `[animate_unit]`'s `[primary_attack]`/`[secondary_attack]`,
 * `hits=`, `value=`, `[facing]` and nested `[animate]` sequences (this
 * port's animation layer, `packages/renderer`, has no animator object to
 * drive frame by frame -- it plays one named animation per cue);
 * `[scroll_to]`'s `check_fogged=` (the display already draws only what
 * the viewing side can see); `[store_zoom]`.
 */

import type { WmlConfig } from '../wml/config.js';
import type { EventContext } from './context.js';
import { Location } from '../model/Location.js';
import { findPath } from '../pathfind/pathfind.js';
import { Unit } from '../model/Unit.js';
import { findLocations, findUnits } from './filter.js';
import type { CutsceneBeat, FakeUnitWalk, Flow } from './interaction.js';

/** Yields one beat and waits for the display to say it is done. */
function* playBeat(beat: CutsceneBeat): Flow {
  yield { kind: 'beat', beat };
}

// --- [delay] ---

function* actionDelay(cfg: WmlConfig, ctx: EventContext): Flow {
  // `intf_delay` (game_lua_kernel.cpp:4491): a delay during PRELOAD/
  // PRESTART/INITIAL does nothing at all, so a scenario that opens with a
  // scripted pause doesn't stall before the board is even up.
  if (!ctx.gameStarted) return;
  const ms = cfg.getNumber('time', 0);
  if (ms <= 0) return;
  yield* playBeat({ kind: 'delay', ms, accelerate: cfg.getBoolean('accelerate', false) });
}

// --- [scroll_to] / [scroll_to_unit] / [scroll] ---

function* actionScrollTo(cfg: WmlConfig, ctx: EventContext): Flow {
  const target = findLocations(ctx.board, cfg)[0];
  if (!target) return;
  yield* scrollToLocation(cfg, target);
}

function* actionScrollToUnit(cfg: WmlConfig, ctx: EventContext): Flow {
  if (!sideFilterPasses(cfg, ctx, 'for_side')) return;
  const unit = findUnits(ctx.board, cfg)[0];
  if (!unit) return;
  yield* scrollToLocation(cfg, unit.location);
}

function* scrollToLocation(cfg: WmlConfig, location: Location): Flow {
  yield* playBeat({
    kind: 'scrollTo',
    location,
    immediate: cfg.getBoolean('immediate', false),
    onlyIfNeeded: cfg.getBoolean('only_if_needed', false),
    highlight: cfg.getBoolean('highlight', false),
  });
}

function* actionScroll(cfg: WmlConfig, ctx: EventContext): Flow {
  if (!sideFilterPasses(cfg, ctx, 'side')) return;
  yield* playBeat({ kind: 'scrollBy', dx: cfg.getNumber('x', 0), dy: cfg.getNumber('y', 0) });
}

/**
 * `utils.get_sides`-style gating: a scroll asked for on behalf of
 * particular sides only happens when one of them is a human the local
 * player controls. No side given means "everyone".
 */
function sideFilterPasses(cfg: WmlConfig, ctx: EventContext, key: string): boolean {
  if (!cfg.hasAttribute(key)) return true;
  const wanted = cfg
    .getString(key)
    .split(/[\s,]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (wanted.length === 0) return true;
  return wanted.some((side) => ctx.board.teams().find((t) => t.side === side)?.controller === 'human');
}

// --- [lock_view] / [unlock_view] / [zoom] ---

function* actionLockView(): Flow {
  yield* playBeat({ kind: 'lockView', locked: true });
}

function* actionUnlockView(): Flow {
  yield* playBeat({ kind: 'lockView', locked: false });
}

function* actionZoom(cfg: WmlConfig): Flow {
  yield* playBeat({ kind: 'zoom', factor: cfg.getNumber('factor', 1), relative: cfg.getBoolean('relative', false) });
}

// --- [color_adjust] / [screen_fade] ---

function* actionColorAdjust(cfg: WmlConfig): Flow {
  yield* playBeat({
    kind: 'colorAdjust',
    red: cfg.getNumber('red', 0),
    green: cfg.getNumber('green', 0),
    blue: cfg.getNumber('blue', 0),
  });
}

function* actionScreenFade(cfg: WmlConfig): Flow {
  yield* playBeat({
    kind: 'screenFade',
    red: cfg.getNumber('red', 0),
    green: cfg.getNumber('green', 0),
    blue: cfg.getNumber('blue', 0),
    alpha: cfg.getNumber('alpha', 0),
    durationMs: cfg.getNumber('duration', 0),
  });
}

// --- [move_unit_fake] / [move_units_fake] ---

/**
 * `fake_unit_path` (`action_wml.cpp:125-191`): the x=/y= lists are
 * waypoints, not a step-by-step path -- consecutive ones are joined by
 * the route the unit would actually walk.
 */
function fakePath(ctx: EventContext, cfg: WmlConfig, walker: Unit): Location[] {
  const xs = cfg.getString('x', '').split(',');
  const ys = cfg.getString('y', '').split(',');
  const waypoints: Location[] = [];
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const x = Number(xs[Math.min(i, xs.length - 1)]);
    const y = Number(ys[Math.min(i, ys.length - 1)]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    waypoints.push(Location.fromWml(x, y));
  }
  if (waypoints.length === 0) return [];

  const path: Location[] = [waypoints[0]!];
  for (let i = 1; i < waypoints.length; i++) {
    const from = path[path.length - 1]!;
    const to = waypoints[i]!;
    if (from.equals(to)) continue;
    // Routed as the unit it is pretending to be, so terrain costs match.
    walker.location = from;
    const leg = findPath(ctx.board, walker, to, { seeAll: true, ignoreUnit: true }).steps;
    // No route (impassable terrain for this type): jump straight there
    // rather than dropping the whole animation.
    path.push(...(leg.length === 0 ? [to] : leg.slice(1)));
  }
  walker.location = path[0]!;
  return path;
}

function fakeWalk(ctx: EventContext, cfg: WmlConfig): FakeUnitWalk | undefined {
  const typeId = cfg.getString('type', '');
  if (typeId === '') {
    ctx.log('error', '[move_unit_fake] missing required type=');
    return undefined;
  }
  const side = cfg.getNumber('side', 1);
  let walker: Unit;
  try {
    walker = Unit.create(ctx.resolveType(typeId), side, Location.NULL);
  } catch (e) {
    ctx.log('error', `[move_unit_fake] unknown type=${typeId}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
  const path = fakePath(ctx, cfg, walker);
  if (path.length < 2) return undefined;
  return {
    spec: {
      typeId,
      side,
      variation: cfg.getString('variation', ''),
      imageMods: cfg.getString('image_mods', ''),
      gender: cfg.getString('gender', ''),
    },
    path,
    unit: walker,
  };
}

function* actionMoveUnitFake(cfg: WmlConfig, ctx: EventContext): Flow {
  const walk = fakeWalk(ctx, cfg);
  if (!walk) return;
  yield* playBeat({ kind: 'moveFakeUnits', walks: [walk] });
}

/** `[move_units_fake]`: several `[fake_unit]`s walking their own paths at once. */
function* actionMoveUnitsFake(cfg: WmlConfig, ctx: EventContext): Flow {
  const walks: FakeUnitWalk[] = [];
  for (const unitCfg of cfg.children('fake_unit')) {
    const walk = fakeWalk(ctx, ctx.variables.expandConfig(unitCfg));
    if (walk) walks.push(walk);
  }
  if (walks.length === 0) return;
  yield* playBeat({ kind: 'moveFakeUnits', walks });
}

// --- [animate_unit] ---

function* actionAnimateUnit(cfg: WmlConfig, ctx: EventContext): Flow {
  const filterCfg = cfg.child('filter');
  const unit = filterCfg ? findUnits(ctx.board, ctx.variables.expandConfig(filterCfg))[0] : ctx.board.unitAt(ctx.loc1);
  if (!unit) return;
  const flag = cfg.getString('flag', '');
  if (flag === '') {
    ctx.log('error', '[animate_unit] missing required flag=');
    return;
  }
  yield* playBeat({
    kind: 'animateUnit',
    unit,
    flag,
    text: cfg.getString('text', ''),
    withBars: cfg.getBoolean('with_bars', false),
  });
}

/** Registers every cutscene/camera tag -- called by `createDefaultActionRegistry`. */
export function registerCutsceneActions(register: (tag: string, handler: (cfg: WmlConfig, ctx: EventContext) => void | Flow) => void): void {
  register('delay', actionDelay);
  register('scroll_to', actionScrollTo);
  register('scroll_to_unit', actionScrollToUnit);
  register('scroll', actionScroll);
  register('lock_view', actionLockView);
  register('unlock_view', actionUnlockView);
  register('zoom', actionZoom);
  register('color_adjust', actionColorAdjust);
  register('screen_fade', actionScreenFade);
  register('move_unit_fake', actionMoveUnitFake);
  register('move_units_fake', actionMoveUnitsFake);
  register('animate_unit', actionAnimateUnit);
}

export { playBeat };
