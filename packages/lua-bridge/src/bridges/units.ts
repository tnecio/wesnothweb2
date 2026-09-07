/**
 * Bridges a slice of Lua's `wesnoth.units.*` to the real, tested
 * `@wesnothweb2/engine` `GameBoard`/`Unit` (`packages/engine/src/model/`) --
 * Task 2's second-priority target per the task brief ("basic
 * `wesnoth.units.get`/unit field access ... bridging to a real `GameBoard`").
 *
 * Implemented: `wesnoth.units.get(x, y)` (1-based WML coordinates, matching
 * real Wesnoth's Lua API), returning nil if no unit is there, or else a
 * proxy object exposing `x`/`y` (read-only, derived from the unit's
 * `Location`), `side` (read/write), `hitpoints`/`max_hitpoints`
 * (`hitpoints` read/write, `max_hitpoints` read-only), `id` (read-only), and
 * `valid` (always `true` for a unit actually found on the board) -- the
 * handful of fields the task brief calls out explicitly (hitpoints, side,
 * x/y) plus `id`/`max_hitpoints` since they're one-line additions once the
 * plumbing exists.
 *
 * NOT implemented: the other several dozen fields/methods real Wesnoth's
 * unit userdata exposes (`moves`, `attacks`, `status`, `traits`,
 * `resistance_against`, `__cfg`, `matches`, ...), `wesnoth.units.find_on_map`/
 * `find_on_recall`/other query methods, and write access to `x`/`y`
 * (real Wesnoth allows assigning `unit.x`/`unit.y` to move a unit, which
 * needs `GameBoard.moveUnit`, not just a field write) -- straightforward
 * extensions once real content needs them, deferred to keep this bridge's
 * surface matched to what's actually been exercised end-to-end (see
 * test/unitsBridge.test.ts).
 */
import type { GameBoard } from '@wesnothweb2/engine/src/model/GameBoard.js';
import { Location } from '@wesnothweb2/engine/src/model/Location.js';
import type { Unit } from '@wesnothweb2/engine/src/model/Unit.js';
import { lua, interop, setNestedCFunction, type LuaState } from '../luaEnv.js';

/** A plain JS object exposing exactly the Lua-facing field names/semantics for one `Unit`. */
function makeUnitAdapter(unit: Unit): object {
  return {
    get x(): number {
      return unit.location.wmlX;
    },
    get y(): number {
      return unit.location.wmlY;
    },
    get side(): number {
      return unit.side;
    },
    set side(value: number) {
      unit.side = value;
    },
    get hitpoints(): number {
      return unit.hitpoints;
    },
    set hitpoints(value: number) {
      unit.hitpoints = value;
    },
    get max_hitpoints(): number {
      return unit.maxHitpoints;
    },
    get id(): string {
      return unit.id;
    },
    get valid(): boolean {
      return true;
    },
  };
}

/** Installs `wesnoth.units.get` (assumes bootstrap.ts's `wesnoth.units` table already exists). */
export function installUnitsBridge(L: LuaState, board: GameBoard): void {
  const getFn = (state: LuaState): number => {
    const x = Number(interop.tojs(state, 1));
    const y = Number(interop.tojs(state, 2));
    const unit = board.unitAt(Location.fromWml(x, y));
    if (!unit) {
      lua.lua_pushnil(state);
      return 1;
    }
    interop.push(state, makeUnitAdapter(unit));
    return 1;
  };
  setNestedCFunction(L, ['wesnoth', 'units', 'get'], getFn);
}
