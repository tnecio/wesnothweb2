/**
 * TS port of upstream Wesnoth's `game_board` (src/game_board.hpp/.cpp): ties
 * the map, the live unit set, and per-side teams together into one queryable
 * container. Fog/shroud visibility (`find_visible_unit`'s `see_all`
 * parameter) and the temporary_unit_{placer,remover,mover} RAII helpers
 * (used by combat simulation code to test hypothetical positions) are not
 * ported here -- both are Phase 2 (rules engine) concerns that build on top
 * of this container rather than belonging to the data model itself.
 */

import { Location } from './Location.js';
import { GameMap } from './Map.js';
import { Team } from './Team.js';
import { Unit } from './Unit.js';
import { UnitType } from './UnitType.js';
import { TerrainTypeData } from './Terrain.js';
import type { WmlConfig } from '../wml/config.js';

export class GameBoard {
  map: GameMap;
  /** Indexed by side number (1-based); `teams.get(side)`, not an array, since sides need not be contiguous once eliminated. */
  private readonly teamsBySide = new Map<number, Team>();
  private readonly unitsByLocation = new Map<string, Unit>();
  /** Units off the board (a side's recall list), keyed by side. */
  private readonly recallLists = new Map<number, Unit[]>();

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
  }

  removeUnitAt(loc: Location): Unit | undefined {
    const key = loc.key();
    const unit = this.unitsByLocation.get(key);
    this.unitsByLocation.delete(key);
    return unit;
  }

  /** Mirrors `game_board::find_unit`/`unit_map::find(loc)`: no visibility filtering. */
  unitAt(loc: Location): Unit | undefined {
    return this.unitsByLocation.get(loc.key());
  }

  hasUnitAt(loc: Location): boolean {
    return this.unitsByLocation.has(loc.key());
  }

  /** Moves a unit's location key in the index; does not touch its .location field (caller's job, mirrors upstream's split responsibility). */
  moveUnit(from: Location, to: Location): void {
    const unit = this.removeUnitAt(from);
    if (!unit) return;
    unit.location = to;
    this.addUnit(unit);
  }

  allUnits(): Unit[] {
    return [...this.unitsByLocation.values()];
  }

  unitsForSide(side: number): Unit[] {
    return this.allUnits().filter((u) => u.side === side);
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

  removeFromRecallList(side: number, underlyingId: number): Unit | undefined {
    const list = this.recallLists.get(side);
    if (!list) return undefined;
    const idx = list.findIndex((u) => u.underlyingId === underlyingId);
    if (idx === -1) return undefined;
    return list.splice(idx, 1)[0];
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
   */
  static fromConfig(
    scenarioCfg: WmlConfig,
    terrainData: TerrainTypeData,
    resolveType: (id: string) => UnitType,
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
        }
        if (leader.id) team.canRecruit.add(leader.type.id);
      }
      for (const unitCfg of sideCfg.children('unit')) {
        board.addUnit(Unit.fromConfig(unitCfg, resolveType));
      }
      for (const recallCfg of sideCfg.children('recall')) {
        board.addToRecallList(team.side, Unit.fromConfig(recallCfg, resolveType));
      }
    }

    // Scenario-level [unit] tags, commonly nested inside [event] (see
    // GameBoard's module doc comment) -- walk the whole tree once.
    const visit = (node: WmlConfig): void => {
      for (const { tag, config } of node.allChildren()) {
        if (tag === 'unit') {
          const loc = Location.fromConfig(config);
          if (loc.valid()) board.addUnit(Unit.fromConfig(config, resolveType));
        } else if (tag !== 'side') {
          // [side]'s own [unit]/[recall] children are already handled above;
          // don't double-add them via the generic walk.
          visit(config);
        }
      }
    };
    visit(scenarioCfg);

    return board;
  }
}
