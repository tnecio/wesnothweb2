/**
 * TS port of upstream Wesnoth's `game_board` (src/game_board.hpp/.cpp): ties
 * the map, the live unit set, and per-side teams together into one queryable
 * container. Fog/shroud visibility (`find_visible_unit`'s `see_all`
 * parameter) and the temporary_unit_{placer,remover,mover} RAII helpers
 * (used by combat simulation code to test hypothetical positions) are not
 * ported here -- both are Phase 2 (rules engine) concerns that build on top
 * of this container rather than belonging to the data model itself.
 */

import { TunnelManager } from '../pathfind/tunnels.js';
import { findVacantTile } from '../pathfind/pathfind.js';
import { Location } from './Location.js';
import { GameMap, type OverlayRule } from './Map.js';
import { Team } from './Team.js';
import { Unit } from './Unit.js';
import { UnitType } from './UnitType.js';
import { NONE_TERRAIN, TerrainTypeData, type MergeMode, type TerrainCode } from './Terrain.js';
import type { WmlConfig } from '../wml/config.js';

export class GameBoard {
  map: GameMap;
  /** Indexed by side number (1-based); `teams.get(side)`, not an array, since sides need not be contiguous once eliminated. */
  private readonly teamsBySide = new Map<number, Team>();
  private readonly unitsByLocation = new Map<string, Unit>();
  /** Units off the board (a side's recall list), keyed by side. */
  private readonly recallLists = new Map<number, Unit[]>();
  /** Which side (if any) currently owns each village, keyed by `Location.key()`. Mirrors `team::villages_`/`village_owner`. */
  private readonly villageOwners = new Map<string, number>();
  /** The scenario's `[tunnel]`s (`resources::tunnels`) -- see `pathfind/teleport.ts`. */
  readonly tunnels = new TunnelManager();

  /**
   * `n_unit::id_manager`'s counter (`next_underlying_unit_id` in a save):
   * how many real unit ids have been handed out. `assignUnitId` gives the
   * next one to a new unit.
   */
  nextUnitId = 0;

  /**
   * `unit::set_underlying_id`: a new unit without an `underlying_id` gets
   * the next number, and one without an `id=` becomes `<type>-<number>`
   * (upstream's "Merman Citizen-3"), so recalls and filters by id line up
   * with the real game.
   */
  assignUnitId(unit: Unit): void {
    if (unit.underlyingId === 0) unit.underlyingId = ++this.nextUnitId;
    if (unit.id === '') unit.id = `${unit.type.id || 'Unit'}-${unit.underlyingId}`;
  }

  /**
   * Effective `lawful_bonus` at a hex (upstream's `tod_manager::get_illuminated_time_of_day`),
   * installed by whoever owns the schedule; `null` means neutral everywhere.
   * Lets board-level rules like `[filter_location] time_of_day=` avoid depending on the session.
   */
  lawfulBonusAt: ((loc: Location) => number) | null = null;

  constructor(map: GameMap) {
    this.map = map;
  }

  // --- teams ---

  addTeam(team: Team): void {
    this.teamsBySide.set(team.side, team);
  }

  getTeam(side: number): Team | undefined {
    return this.teamsBySide.get(side);
  }

  teams(): Team[] {
    return [...this.teamsBySide.values()].sort((a, b) => a.side - b.side);
  }

  /** `get_team(side).shrouded(loc)` with shared maps honoured. */
  isShrouded(side: number, loc: Location): boolean {
    const team = this.teamsBySide.get(side);
    return !!team && team.shrouded(loc, this.teams());
  }

  /** `get_team(side).fogged(loc)` with shared vision honoured. */
  isFogged(side: number, loc: Location): boolean {
    const team = this.teamsBySide.get(side);
    return !!team && team.fogged(loc, this.teams());
  }

  /** Mirrors `game_board::team_is_defeated`: no leader unit left, or explicitly marked lost. */
  teamIsDefeated(side: number): boolean {
    const team = this.teamsBySide.get(side);
    if (!team) return true;
    if (team.lost) return true;
    if (team.noLeader) return false;
    return !this.unitsForSide(side).some((u) => u.canRecruit);
  }

  // --- units on the board ---

  addUnit(unit: Unit): void {
    this.unitsByLocation.set(unit.location.key(), unit);
    this.unitsVersion++;
  }

  removeUnitAt(loc: Location): Unit | undefined {
    const key = loc.key();
    const unit = this.unitsByLocation.get(key);
    this.unitsByLocation.delete(key);
    this.unitsVersion++;
    return unit;
  }

  /** Bumped whenever a unit is placed, moved or removed, for caches over where units stand. */
  unitsVersion = 0;

  /** Mirrors `game_board::find_unit`/`unit_map::find(loc)`: no visibility filtering. */
  unitAt(loc: Location): Unit | undefined {
    return this.unitsByLocation.get(loc.key());
  }

  hasUnitAt(loc: Location): boolean {
    return this.unitsByLocation.has(loc.key());
  }

  /** Moves a unit's location key in the index AND its own `.location` field to match. */
  moveUnit(from: Location, to: Location): void {
    const unit = this.removeUnitAt(from);
    if (!unit) return;
    unit.location = to;
    this.addUnit(unit);
  }

  allUnits(): Unit[] {
    return [...this.unitsByLocation.values()];
  }

  /** Every unit on the board, without copying (the board must not change while iterating). */
  unitsIterable(): IterableIterator<Unit> {
    return this.unitsByLocation.values();
  }

  unitsForSide(side: number): Unit[] {
    return this.allUnits().filter((u) => u.side === side);
  }

  // --- villages ---

  /** The owning side of `loc`, or `undefined` if it's not a village or is unowned. Mirrors `team::owns_village`/the reverse lookup over `team::villages_`. */
  villageOwner(loc: Location): number | undefined {
    return this.villageOwners.get(loc.key());
  }

  /**
   * Bumped by every `changeTerrain` -- lets a view know to redraw the map
   * (upstream's display invalidates the changed hexes).
   */
  terrainVersion = 0;

  /**
   * `game_board::change_terrain`: merges `terrain` in per `mode`
   * (`gamemap::set_terrain`); a hex that stops being a village is lost by
   * its owner, and one that becomes a village is not captured by a unit
   * standing on it. Returns false if the merge fails.
   */
  changeTerrain(loc: Location, terrain: TerrainCode, mode: MergeMode = 'BOTH', replaceIfFailed = false): boolean {
    const { newTerrain, villageChange } = this.map.setTerrain(loc, terrain, mode, replaceIfFailed);
    if (newTerrain.equals(NONE_TERRAIN)) return false;
    if (villageChange === 'former_village') this.villageOwners.delete(loc.key());
    this.terrainVersion++;
    return true;
  }

  /**
   * `[terrain_mask]` (`intf_terrain_mask`): `GameMap.overlay`, then every
   * side loses the villages that are no longer villages (`team::fix_villages`).
   */
  terrainMask(mask: GameMap, xpos: number, ypos: number, rules: readonly OverlayRule[], isOdd: boolean, ignoreSpecialLocations: boolean): void {
    this.map.overlay(mask, xpos, ypos, rules, isOdd, ignoreSpecialLocations);
    for (const key of [...this.villageOwners.keys()]) {
      const [x, y] = key.split(',').map(Number) as [number, number];
      if (!this.map.isVillage(new Location(x, y))) this.villageOwners.delete(key);
    }
    this.terrainVersion++;
  }

  /**
   * Restores a saved `map_data=` over the current map, hex by hex through
   * `changeTerrain` (so village bookkeeping follows). Maps of another size
   * are refused.
   */
  applyMapData(data: string): boolean {
    const saved = this.map.parseSibling(data);
    // Phase 28c: a map `[replace_map]` resized (The South Guard 1 grows it) comes back whole.
    if (saved.w() !== this.map.w() || saved.h() !== this.map.h()) {
      this.replaceMap(saved);
      return true;
    }
    const b = this.map.borderSize;
    for (let x = -b; x < this.map.w() + b; x++) {
      for (let y = -b; y < this.map.h() + b; y++) {
        const loc = new Location(x, y);
        const code = saved.getTerrain(loc);
        if (!code.equals(this.map.getTerrain(loc))) this.changeTerrain(loc, code);
      }
    }
    return true;
  }

  /**
   * Phase 28c: `game_board::replace_map` (`[replace_map]`): the board gets `newMap`, which may be another
   * size. A unit that would be off the new map goes to its side's recall list; a village that is no
   * longer a village is lost by its owner. Bumps `mapVersion` so whoever draws the board can tell.
   */
  replaceMap(newMap: GameMap): void {
    for (const unit of this.allUnits()) {
      if (newMap.onBoard(unit.location)) continue;
      this.removeUnitAt(unit.location);
      this.addToRecallList(unit.side, unit);
    }
    for (const key of [...this.villageOwners.keys()]) {
      const [x, y] = key.split(',').map(Number) as [number, number];
      if (!newMap.isVillage(new Location(x, y))) this.villageOwners.delete(key);
    }
    this.map = newMap;
    this.mapVersion++;
    // Terrain changed too: a save carries the whole map from now on (`toSaveData`'s `mapData`).
    this.terrainVersion++;
  }

  /** Bumped by `replaceMap`: the map object itself changed (its size may have). */
  mapVersion = 0;

  /**
   * Mirrors `team::get_village`: assigns `loc` to `side`, replacing any
   * previous owner (a captured village is simply reassigned, matching
   * `actions::get_village`'s "was already owned by someone else" branch).
   * No-ops if `loc` isn't actually a village. `side <= 0` neutralises it
   * instead (mirrors WML's `[capture_village]side=0` -- see
   * `wesnoth.map.set_owner`'s falsy-side branch in `wml-tags.lua`), so
   * `villageOwner`/`villageCount` treat it as unowned again rather than
   * owned by a nonexistent "side 0".
   */
  captureVillage(loc: Location, side: number): void {
    if (!this.map.isVillage(loc)) return;
    if (side <= 0) {
      this.villageOwners.delete(loc.key());
    } else {
      this.villageOwners.set(loc.key(), side);
    }
  }

  /** Mirrors `team::villages().size()`: how many villages `side` currently owns. */
  villageCount(side: number): number {
    let count = 0;
    for (const owner of this.villageOwners.values()) {
      if (owner === side) count++;
    }
    return count;
  }

  /**
   * Mirrors `team::villages()`: every village `side` currently owns.
   *
   * Real, reported bug: village ownership was live-only state that no save
   * captured, so a reloaded game re-derived it from the scenario's *initial*
   * unit placement (`gameBoardFromSnapshot`) -- every village captured during
   * play reverted to unowned, and the side's income with it. Upstream writes
   * these as `[village] x= y=` children of each `[side]`; this is the read
   * half of that, `captureVillage` the write half.
   */
  villagesOwnedBy(side: number): Location[] {
    const owned: Location[] = [];
    for (const [key, owner] of this.villageOwners) {
      if (owner === side) owned.push(Location.fromKey(key));
    }
    return owned;
  }

  // --- recall lists ---

  recallList(side: number): Unit[] {
    return this.recallLists.get(side) ?? [];
  }

  addToRecallList(side: number, unit: Unit): void {
    const list = this.recallLists.get(side);
    if (list) list.push(unit);
    else this.recallLists.set(side, [unit]);
  }

  /** Puts `unit` back at `index` of `side`'s recall list (clamped to its end) -- an undone recall or dismissal returns to the slot it came from. */
  insertIntoRecallList(side: number, unit: Unit, index: number): void {
    const list = this.recallLists.get(side);
    if (!list) {
      this.recallLists.set(side, [unit]);
      return;
    }
    list.splice(Math.max(0, Math.min(index, list.length)), 0, unit);
  }

  removeFromRecallList(side: number, underlyingId: number): Unit | undefined {
    const list = this.recallLists.get(side);
    if (!list) return undefined;
    const idx = list.findIndex((u) => u.underlyingId === underlyingId);
    if (idx === -1) return undefined;
    return list.splice(idx, 1)[0];
  }

  /**
   * Removes the recall-list unit at `index` (position in `recallList(side)`),
   * NOT by `underlyingId` -- this project doesn't auto-assign a unique
   * `underlying_id` to every unit (see `Unit.ts`), so several recall-list
   * entries commonly share the default `underlyingId=0`, which would make
   * `removeFromRecallList` remove the wrong one. Used by the recall
   * dialog's real "Dismiss unit" button, keyed the same safe way
   * `RecallOption.index` already is.
   */
  removeFromRecallListAt(side: number, index: number): Unit | undefined {
    const list = this.recallLists.get(side);
    if (!list || index < 0 || index >= list.length) return undefined;
    return list.splice(index, 1)[0];
  }

  /**
   * Empties `side`'s recall list entirely -- used by callers rebuilding a
   * board's full state from scratch (e.g. `GameSession.loadSaveData`),
   * which need a clean slate rather than `removeFromRecallList`'s one-at-a-
   * time, `underlyingId`-keyed removal (unsafe as a bulk-clear mechanism
   * here since this project doesn't auto-assign unique `underlying_id`s --
   * see `Unit.ts` -- so several entries commonly share `underlyingId=0`).
   */
  clearRecallList(side: number): void {
    this.recallLists.delete(side);
  }

  /**
   * Builds a full GameBoard from a `[scenario]` config: the map (from
   * `map_data=`; resolving `map_file=` to text is the caller's job, see
   * Map.ts's module doc comment), each `[side]` as a Team, and every
   * `[unit]`/`[side][unit]` reachable in the tree (walking nested tags,
   * since scenario `[unit]`s are commonly placed inside `[event]` blocks --
   * see the WML pipeline's Dead_Water integration test) as board units.
   * `resolveType` looks up a `UnitType` by id -- building that registry
   * from `data/core/units/` (with the multi-file inheritance flattening
   * real unit definitions use) is out of scope here; see IMPLEMENTATION_PLAN.md.
   *
   * `options.spawnUnitsFromTree` (default `true`, preserving every
   * existing caller's behavior) controls the tree-walk described above.
   * A caller that's about to run the scenario's real `[event]`s through
   * the real event pump (`events/pump.ts`) -- which spawns these same
   * `[unit]` tags itself, correctly, only when/if the owning event
   * actually fires -- should pass `false` here to avoid double-spawning
   * (once statically by this naive walk, once for real by the event that
   * actually places them). Inline `[side]` leaders are unaffected by this
   * flag: they're placed unconditionally, matching upstream (a side's
   * leader exists from scenario start, never gated behind an event).
   */
  static fromConfig(
    scenarioCfg: WmlConfig,
    terrainData: TerrainTypeData,
    resolveType: (id: string) => UnitType,
    options: { spawnUnitsFromTree?: boolean } = {},
  ): GameBoard {
    const map = GameMap.fromConfig(scenarioCfg, terrainData);
    const board = new GameBoard(map);

    for (const sideCfg of scenarioCfg.children('side')) {
      const team = Team.fromConfig(sideCfg);
      board.addTeam(team);

      // A [side] may specify its leader inline (type=/id=/name= directly on
      // [side], as Dead_Water's scenario 1 does for Kai Krellis) as well as
      // -- or instead of -- nested [unit]/[recall] children. The common
      // case (confirmed against real content: neither of Dead_Water scenario
      // 1's two [side] leaders have x=/y=) is no explicit location at all --
      // mirrors playsingle_controller's real placement, which falls back to
      // the map's marked starting position for that side number. Without
      // this fallback, every leader lacking x=/y= resolves to the same
      // Location.NULL key and silently overwrites each other in
      // unitsByLocation -- caught by this project's own integration test.
      if (sideCfg.hasAttribute('type')) {
        const leader = Unit.fromConfig(sideCfg, resolveType);
        leader.canRecruit = true;
        if (!leader.location.valid()) {
          leader.location = map.startingPosition(team.side);
        }
        if (leader.location.valid()) {
          board.addUnit(leader);
          board.captureVillage(leader.location, leader.side);
        } else {
          // `unit_creator::add_unit` with `allow_add_to_recall`: no hex for it (no x,y and no starting
          // position on this map, as Heir to the Throne 1's) puts the leader on the recall list.
          board.addToRecallList(team.side, leader);
        }
        // Deliberately NOT adding the leader's own type to `recruit=`.
        // Real, reported gameplay bug (bugs6.md): Dead Water 1 offered
        // "Child King" in its recruit list and the enemy side offered
        // "Dark Sorcerer" -- each side's own leader type -- where real
        // Wesnoth offers neither (its save of the same scenario lists
        // exactly `Mermaid Initiate,Merman Citizen,Merman Fighter,Merman
        // Hunter`). A side recruits what `[side] recruit=` names, plus
        // any `extra_recruit=`; a leader's own type is not recruitable
        // for being a leader's type.
      }
      // `team_builder::leader`/`handle_leader`: each `[leader]` child is one more unit, canrecruit=yes unless
      // it says otherwise, placed (`placement=map,leader`) at its x,y, else the side's starting position, else
      // the nearest free hex. Sceptre of Fire 1 gives the elves a second leader this way.
      for (const leaderCfg of sideCfg.children('leader')) {
        if (!leaderCfg.hasAttribute('type')) continue;
        const cfg = leaderCfg.clone();
        cfg.setAttribute('side', team.side);
        if (!cfg.hasAttribute('canrecruit')) cfg.setAttribute('canrecruit', true);
        const leader = Unit.fromConfig(cfg, resolveType);
        if (!leader.location.valid()) leader.location = map.startingPosition(team.side);
        if (leader.location.valid() && board.unitAt(leader.location)) {
          leader.location = findVacantTile(board, leader.location) ?? Location.NULL;
        }
        if (!leader.location.valid()) {
          board.addToRecallList(team.side, leader);
          continue;
        }
        board.addUnit(leader);
        board.captureVillage(leader.location, leader.side);
      }
      for (const unitCfg of sideCfg.children('unit')) {
        const unit = Unit.fromConfig(unitCfg, resolveType);
        board.addUnit(unit);
        board.captureVillage(unit.location, unit.side);
      }
      for (const recallCfg of sideCfg.children('recall')) {
        board.addToRecallList(team.side, Unit.fromConfig(recallCfg, resolveType));
      }
    }

    // Scenario-level [unit] tags, commonly nested inside [event] (see
    // GameBoard's module doc comment) -- walk the whole tree once. Skipped
    // when the caller is about to run real events instead (see this
    // function's doc comment on `options.spawnUnitsFromTree`).
    if (options.spawnUnitsFromTree ?? true) {
      const visit = (node: WmlConfig): void => {
        for (const { tag, config } of node.allChildren()) {
          if (tag === 'unit') {
            const loc = Location.fromConfig(config);
            if (loc.valid()) {
              const unit = Unit.fromConfig(config, resolveType);
              board.addUnit(unit);
              board.captureVillage(unit.location, unit.side);
            }
          } else if (tag !== 'side') {
            // [side]'s own [unit]/[recall] children are already handled above;
            // don't double-add them via the generic walk.
            visit(config);
          }
        }
      };
      visit(scenarioCfg);
    }

    return board;
  }
}
