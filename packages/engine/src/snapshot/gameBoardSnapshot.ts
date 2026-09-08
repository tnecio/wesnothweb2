/**
 * Client-side reconstruction of a live, mutable `GameBoard` from the static
 * JSON snapshot `apps/web/scripts/build-scenario-snapshot.mjs` produces (see
 * that script's own module doc comment for why a build-time snapshot exists
 * at all instead of live in-browser WML loading -- the short version: the
 * WML pipeline's file access is synchronous/Node-only).
 *
 * This is a NEW file, not a change to any existing model file: `model/*.ts`
 * (owned by earlier phases' work) stays untouched even though this module
 * leans heavily on its public API to build real `Unit`/`UnitType`/`Team`/
 * `GameBoard` instances from plain data.
 *
 * ## Why a flat per-terrain movement cost, not real per-terrain costs
 *
 * The snapshot's units are built from a STUB `UnitType` (see the build
 * script's own doc comment: real `data/core/units/` loading needs
 * `base_unit`/gender-variation inheritance flattening that's a separate,
 * documented, deferred gap -- `IMPLEMENTATION_PLAN.md`). A stub `MoveType`
 * with an EMPTY `[movement_costs]` table makes `MoveType.movementCost()`
 * return `UNREACHABLE` (99) for every terrain, because `resolveValue` has no
 * per-terrain-id entry to match and falls back to its "unreachable" default
 * -- this project's own tests have hit exactly this failure mode three
 * times already (see `docs/PROGRESS.md`). `buildFlatMoveType` below is the
 * honest, documented simplification: every terrain costs exactly
 * `movementCost` (default 1) movement point to enter, regardless of type --
 * enough to make pathfinding/movement genuinely functional against the stub
 * unit types, without pretending to have real per-terrain-type data this
 * project doesn't have yet.
 *
 * The same reasoning applies to `[defense]` (terrain-dependent "chance to
 * be hit"): leaving it empty would make `MoveType.defenseModifier()` return
 * `UNREACHABLE` (99) for every hex too (same `resolveValue` default-value
 * fallback), which would make every attack's chance-to-hit degenerate to
 * ~99% -- technically a "real" computation over fake data, but one that
 * makes the combat-prediction UI (this phase's whole point) look broken
 * rather than like a documented simplification. `buildFlatMoveType` also
 * fills `[defense]` with a flat, admittedly made-up, mid-range value
 * (default 40) for the same reason.
 *
 * `buildFlatMoveType` is deliberately keyed off
 * `terrainData.getTerrainInfo(code).id`, not the raw terrain code string,
 * so the exact same function works whether called with a real
 * `TerrainTypeData` (server-side, `build-scenario-snapshot.mjs`, which
 * already has real `terrain.cfg` data loaded for other reasons) or an empty
 * one (client-side, `gameBoardFromSnapshot` below, which has no
 * `terrain.cfg` WML pipeline available in the browser) -- an empty
 * `TerrainTypeData`'s `getTerrainInfo` synthesizes a default `TerrainType`
 * whose `id` is just the terrain code's own string (`TerrainType.
 * fromDefault`), so keying off `.id` "just works" as a same-code lookup
 * either way.
 */

import { WmlConfig } from '../wml/config.js';
import { Location } from '../model/Location.js';
import { GameMap } from '../model/Map.js';
import { Team, type SideController } from '../model/Team.js';
import { Unit } from '../model/Unit.js';
import { AttackType, UnitType, type Alignment } from '../model/UnitType.js';
import { MoveType } from '../model/MoveType.js';
import { TerrainTypeData, type TerrainCode, parseTerrainCode } from '../model/Terrain.js';
import { GameBoard } from '../model/GameBoard.js';

export interface AttackTypeSnapshot {
  id: string;
  name: string;
  type: string;
  range: string;
  minRange: number;
  maxRange: number;
  damage: number;
  numAttacks: number;
  attackWeight: number;
  defenseWeight: number;
  accuracy: number;
  parry: number;
  alignment?: Alignment;
}

export interface UnitTypeSnapshot {
  id: string;
  name: string;
  raceId: string;
  alignment: Alignment;
  level: number;
  hitpoints: number;
  movement: number;
  vision: number;
  jamming: number;
  maxAttacksPerTurn: number;
  cost: number;
  recallCost: number;
  experienceNeededBase: number;
  advancesTo: string[];
  undeadVariation: string;
  zoc: boolean;
  hideHelp: boolean;
  doNotList: boolean;
  attacks: AttackTypeSnapshot[];
}

export interface SnapshotTerrainHex {
  x: number;
  y: number;
  code: string;
}

export interface SnapshotUnit {
  id: string | null;
  name: string | null;
  typeId: string;
  image: string | null;
  side: number;
  x: number;
  y: number;
  canRecruit: boolean;
  hitpoints: number;
  maxHitpoints: number;
}

export interface SnapshotTeam {
  side: number;
  controller: string;
  gold: number;
  teamName: string;
  color: string;
}

/**
 * Extends the vertical-slice-era rendering-only snapshot
 * (`packages/renderer`'s `ScenarioSnapshot`) with everything needed to
 * rebuild a real, mutable `GameBoard` client-side: each referenced unit
 * type's full stat set (`unitTypes`, keyed by type id -- shared across
 * every unit of that type, mirroring the real type/instance split
 * `UnitType.ts`/`Unit.ts` already models) and the raw map text
 * (`map.data`) so `GameMap.fromMapString` (the same real parser
 * `GameBoard.fromConfig` uses) can rebuild the exact same board layout
 * without needing a WML config tree.
 *
 * Deliberately NOT importing `packages/renderer`'s `ScenarioSnapshot` type
 * here -- that would be the wrong dependency direction (`packages/engine`
 * must not depend on `packages/renderer`, see `docs/ARCHITECTURE.md`).
 * This interface is a structurally-compatible superset of it instead, so
 * the exact same parsed JSON object satisfies both types.
 */
export interface GameBoardSnapshot {
  scenario: { id: string; name: string };
  map: {
    width: number;
    height: number;
    totalWidth?: number;
    totalHeight?: number;
    border: number;
    /** Raw `map_data=`-format text (see `Map.ts`'s `parseGameMapText`), needed to rebuild a real `GameMap` client-side. */
    data: string;
  };
  terrain: SnapshotTerrainHex[];
  teams: SnapshotTeam[];
  units: SnapshotUnit[];
  /** Every unit type referenced by `units`, keyed by `typeId`. */
  unitTypes: Record<string, UnitTypeSnapshot>;
}

export interface FlatMoveTypeOptions {
  /** Flat movement-point cost to enter any hex, regardless of terrain. Default 1 -- see module doc comment. */
  movementCost?: number;
  /** Flat terrain defense value (0-100, "chance to be hit" convention -- see `Unit.defenseModifier`). Default 40 -- see module doc comment. */
  defensePercent?: number;
}

/**
 * Builds a `MoveType` whose movement cost and terrain defense are flat
 * values for every terrain code in `codesInUse` -- see this module's doc
 * comment for why. Shared between the server-side snapshot builder (real
 * `TerrainTypeData`) and the client-side loader below (empty
 * `TerrainTypeData`).
 */
export function buildFlatMoveType(
  codesInUse: readonly TerrainCode[],
  terrainData: TerrainTypeData,
  options: FlatMoveTypeOptions = {},
): MoveType {
  const movementCost = options.movementCost ?? 1;
  const defensePercent = options.defensePercent ?? 40;

  const cfg = new WmlConfig();
  const costs = cfg.addChild('movement_costs');
  const defense = cfg.addChild('defense');
  const seen = new Set<string>();
  for (const code of codesInUse) {
    const id = terrainData.getTerrainInfo(code).id;
    if (seen.has(id)) continue;
    seen.add(id);
    costs.setAttribute(id, movementCost);
    defense.setAttribute(id, defensePercent);
  }
  return MoveType.fromConfig(cfg, terrainData);
}

function attackTypeFromSnapshot(snap: AttackTypeSnapshot): AttackType {
  return new AttackType(
    snap.id,
    snap.name,
    snap.type,
    snap.range,
    snap.minRange,
    snap.maxRange,
    snap.damage,
    snap.numAttacks,
    snap.attackWeight,
    snap.defenseWeight,
    snap.accuracy,
    snap.parry,
    snap.alignment,
    [], // specials: none in the stub unit-type data this snapshot carries.
  );
}

function unitTypeFromSnapshot(snap: UnitTypeSnapshot, moveType: MoveType): UnitType {
  return new UnitType(
    snap.id,
    snap.name,
    snap.raceId,
    snap.alignment,
    snap.level,
    snap.hitpoints,
    snap.movement,
    snap.vision,
    snap.jamming,
    snap.maxAttacksPerTurn,
    snap.cost,
    snap.recallCost,
    snap.experienceNeededBase,
    snap.advancesTo,
    snap.undeadVariation,
    snap.zoc,
    snap.hideHelp,
    snap.doNotList,
    moveType,
    snap.attacks.map(attackTypeFromSnapshot),
    [], // abilities: none in the stub unit-type data this snapshot carries.
  );
}

function parseController(str: string): SideController {
  switch (str) {
    case 'human':
    case 'ai':
    case 'network':
    case 'network_ai':
    case 'reserved':
      return str;
    default:
      return 'human';
  }
}

export interface LoadedGameBoard {
  readonly board: GameBoard;
  /** Live `Unit` instances indexed by `unitKeyFor(snapshotUnit)`, for callers that need to map a snapshot's own unit entries back to their live counterparts. */
  readonly unitsByKey: ReadonlyMap<string, Unit>;
}

/** A stable key for `SnapshotUnit`s that (unlike WML `id=`) is never blank -- most Dead_Water scenario 1 units have no `id=`. */
export function unitKeyFor(u: Pick<SnapshotUnit, 'id' | 'x' | 'y'>): string {
  return u.id && u.id.length > 0 ? `id:${u.id}` : `pos:${u.x},${u.y}`;
}

/**
 * Rebuilds a live, mutable `GameBoard` from a `GameBoardSnapshot` -- the
 * browser-side counterpart to `GameBoard.fromConfig` (which needs a parsed
 * WML config tree this snapshot deliberately avoids shipping, see this
 * module's doc comment). Every unit starts fresh (full moves/attacks for
 * the turn, matching `Unit.create`'s defaults), mirroring the snapshot's
 * "start of turn 1" moment.
 */
export function gameBoardFromSnapshot(snapshot: GameBoardSnapshot): LoadedGameBoard {
  // Empty on purpose -- see module doc comment on why `buildFlatMoveType`
  // works correctly against an empty TerrainTypeData.
  const terrainData = TerrainTypeData.fromConfigs([]);

  const codesInUse: TerrainCode[] = [];
  const seenCodes = new Set<string>();
  for (const hex of snapshot.terrain) {
    if (seenCodes.has(hex.code)) continue;
    seenCodes.add(hex.code);
    codesInUse.push(parseTerrainCode(hex.code));
  }
  const moveType = buildFlatMoveType(codesInUse, terrainData);

  const typeCache = new Map<string, UnitType>();
  for (const [id, snap] of Object.entries(snapshot.unitTypes)) {
    typeCache.set(id, unitTypeFromSnapshot(snap, moveType));
  }

  const map = GameMap.fromMapString(snapshot.map.data, terrainData, snapshot.map.border);
  const board = new GameBoard(map);

  for (const t of snapshot.teams) {
    board.addTeam(
      new Team(t.side, {
        controller: parseController(t.controller),
        gold: t.gold,
        teamName: t.teamName,
        color: t.color,
      }),
    );
  }

  const unitsByKey = new Map<string, Unit>();
  for (const u of snapshot.units) {
    const type = typeCache.get(u.typeId);
    if (!type) {
      throw new Error(`gameBoardFromSnapshot: unit references unknown typeId "${u.typeId}"`);
    }
    const unit = Unit.create(type, u.side, new Location(u.x, u.y), {
      id: u.id ?? undefined,
      name: u.name ?? undefined,
      canRecruit: u.canRecruit,
    });
    unit.hitpoints = u.hitpoints;
    unit.maxHitpoints = u.maxHitpoints;
    board.addUnit(unit);
    unitsByKey.set(unitKeyFor(u), unit);
  }

  return { board, unitsByKey };
}
