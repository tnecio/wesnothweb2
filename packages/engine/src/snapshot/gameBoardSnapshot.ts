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
 * ## Real per-unit-type stats (current state)
 *
 * `build-scenario-snapshot.mjs` now ships, alongside the scalar
 * `unitTypes` summary below, everything needed to reconstruct REAL per-type
 * `UnitType`s client-side through the actual, tested `UnitType.fromConfig`/
 * `MoveType.fromConfig`/`overlay` engine code -- not a re-invented
 * simplified client-side table:
 *
 *  - `unitTypeConfigs`: each unit type's fully-flattened (`base_unit=`/
 *    `[male]`/`[female]` resolved -- see `model/UnitTypeDatabase.ts`)
 *    `[unit_type]` config, as `WmlConfig.toJSON()`.
 *  - `movementTypeConfigs`: the real `[movetype]` registry (`name=` ->
 *    config) `movement_type=` refers to.
 *  - `terrainTypeConfigs`: every real `[terrain_type]` from `data/core/
 *    terrain.cfg`, needed so `MoveType`'s alias-chasing (`mvt_alias=`/
 *    `def_alias=`) resolves exactly as it does server-side.
 *
 * `buildSnapshotContext` below builds a real `TerrainTypeData` and a real
 * per-id `UnitType` cache from these when present, calling the exact same
 * `UnitType.fromConfig` the build script and every engine test use.
 *
 * ## Fallback: flat per-terrain movement cost (older/hand-built snapshots)
 *
 * Snapshots that DON'T carry `unitTypeConfigs` (e.g. hand-built test
 * fixtures elsewhere in this repo, or a stale snapshot generated before this
 * field existed) fall back to the earlier, honestly-documented
 * simplification: every unit type shares ONE flat `MoveType` built by
 * `buildFlatMoveType`, whose `[movement_costs]` table gives every terrain
 * code in use a flat cost (default 1) and whose `[defense]` table gives a
 * flat mid-range value (default 40). Without this fallback, an EMPTY
 * `[movement_costs]` table makes `MoveType.movementCost()` return
 * `UNREACHABLE` (99) for every terrain (`resolveValue` has no per-terrain-id
 * entry to match) -- this project's own tests hit exactly this failure mode
 * three times before it was documented (see `docs/PROGRESS.md`); leaving
 * `[defense]` empty has the same problem, degenerating every attack's
 * chance-to-hit to ~99%.
 *
 * `buildFlatMoveType` is deliberately keyed off
 * `terrainData.getTerrainInfo(code).id`, not the raw terrain code string,
 * so the exact same function works whether called with a real
 * `TerrainTypeData` or an empty one (`TerrainType.fromDefault`'s `id` is
 * just the terrain code's own string, so keying off `.id` "just works" as a
 * same-code lookup either way).
 */

import { WmlConfig, type WmlConfigJson } from '../wml/config.js';
import {
  EventManager,
  EventPump,
  VariableStore,
  ActionRegistry,
  createDefaultActionRegistry,
  type RecordedMessage,
  type ScenarioObjectives,
} from '../events/index.js';
import { Location, type Direction } from '../model/Location.js';
import { GameMap } from '../model/Map.js';
import { Team, type SideController } from '../model/Team.js';
import { Unit } from '../model/Unit.js';
import { AttackType, UnitType, type Alignment, type RegistryEntry } from '../model/UnitType.js';
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
  /** Real image path collected from `data/core/units.cfg`/the campaign's `_main.cfg`, or `null` if none was found. */
  image?: string | null;
  /** Real `[unit_type] flag_rgb=`, defaulting to "magenta" (matches `unit_type::flag_rgb()`'s own default) -- the reference palette a unit's sprite is recolored FROM, via `~RC(flagRgb>side's color id)`. See `SnapshotUnit.flagRgb`. */
  flagRgb?: string;
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
  /** This unit's real `flag_rgb=` (see `UnitTypeSnapshot.flagRgb`'s own doc comment), for team-color recoloring -- `undefined` reads as the real default ("magenta"). */
  flagRgb?: string;
  /** `Unit.facing` -- drives the idle sprite's mirror on the renderer side; see `@wesnothweb2/renderer`'s `SnapshotUnit.facing` (this interface's structural twin) for the full explanation. */
  facing?: Direction;
  /**
   * XP/moves/attacks/status fields the renderer needs for the real HP/XP
   * bars, moves-left orb, and status tint (see `@wesnothweb2/renderer`'s
   * `SnapshotUnit`, this interface's structural twin, for what draws from
   * them) -- optional here, unlike on that copy, since THIS interface also
   * doubles as `GameBoardSnapshot.units`' element type (the static, build-
   * script-produced JSON `gameBoardFromSnapshot` reads for a fresh board;
   * `build-scenario-snapshot.mjs` doesn't emit these, and doesn't need to,
   * since `gameBoardFromSnapshot` always builds live `Unit`s from real
   * `UnitType` defaults regardless). Always populated by `GameSession.
   * renderUnits` (the live re-render path this was actually added for).
   */
  experience?: number;
  maxExperience?: number;
  level?: number;
  canAdvance?: boolean;
  movesLeft?: number;
  maxMoves?: number;
  attacksLeft?: number;
  maxAttacksPerTurn?: number;
  /** Real reachability for the moves-left orb -- see `@wesnothweb2/renderer`'s `SnapshotUnit` (structurally the same interface) and `actions/unitCanAct.ts`'s `unitCanAct`. */
  canMove?: boolean;
  canAttackHere?: boolean;
  statuses?: readonly string[];
  /** `Unit.loyal` -- whether to draw the real loyal-icon overlay (`misc/loyal-icon.png`). */
  loyal?: boolean;
  /** A stable per-instance render/sprite-identity key -- NOT the real `Unit.underlyingId` (which defaults to 0 and isn't reliably unique). Never set by anything in this module (only `GameSession.renderUnits`, in `packages/ui`, the LIVE re-render path, populates it, from a session-local `WeakMap<Unit, number>`); see `@wesnothweb2/renderer`'s `SnapshotUnit` (structurally the same interface, independently declared) for the full explanation. */
  underlyingId?: number;
}

export interface SnapshotTeam {
  side: number;
  controller: string;
  gold: number;
  teamName: string;
  color: string;
  /** Unit type ids this side may recruit, straight from `[side] recruit=` -- see `Team.canRecruit`. */
  recruit?: string[];
  /**
   * `[side] income=`/`village_gold=` -- optional (older snapshots don't
   * carry these), defaulting to `Team`'s own real WML defaults (0/1) on
   * read, same backward-compat pattern as `terrainFlags`. Without these, a
   * side's gold-carryover finishing bonus (`computeGoldCarryover`, which
   * needs the real income figures) silently computed as if the side had
   * `income=0` regardless of what the scenario's own WML actually set --
   * a real bug invisible against Dead Water (whose side 1 happens to also
   * default to `income=0`) but caught immediately by a synthetic debug
   * campaign that deliberately set a non-zero `income=` to exercise this
   * exact path (see docs/PROGRESS.md).
   */
  income?: number;
  incomePerVillage?: number;
  /** `[side] village_support=` -- how many unit levels' upkeep each owned village covers for free (`Team.supportPerVillage`); same optional/defaulting rationale as `incomePerVillage` above. */
  supportPerVillage?: number;
  /** `[side] fog=`/`shroud=`/`share_vision=` (optional: older snapshots have neither). */
  fog?: boolean;
  shroud?: boolean;
  shareVision?: 'all' | 'shroud' | 'none';
  /** `[side] shroud_data=`/`fog_data=`, in `ShroudMap.write()` format. */
  shroudData?: string;
  fogData?: string;
  /**
   * `[side] no_leader=` -- real, reported bug: without this, a side with
   * `no_leader=yes` and no units yet placed (e.g. an AI antagonist whose
   * leader is spawned by a later scripted event, common in cutscene-heavy
   * campaigns like Under the Burning Suns) read as already-defeated
   * (`GameBoard.teamIsDefeated`'s "no canRecruit unit" fallback) the
   * moment any victory check ran, ending the scenario in an instant false
   * "Victory!" before the antagonist ever appeared. Optional/defaulting
   * to `false` for older snapshots, same pattern as the fields above.
   */
  noLeader?: boolean;
}

/** One `[story][part]` -- see `apps/web/scripts/build-scenario-snapshot.mjs`'s `extractStory`. */
export interface StoryPart {
  text: string;
  /** The part's `[background_layer] image=`, if any. */
  image: string | null;
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
  /** Every unit type referenced by `units` OR spawned by `scenarioConfigJson`'s events OR recruitable via a side's `recruit=` list, keyed by `typeId`. */
  unitTypes: Record<string, UnitTypeSnapshot>;
  /**
   * The scenario's full `[scenario]` config (after real macro/preprocessor
   * expansion at build time -- see `apps/web/scripts/build-scenario-
   * snapshot.mjs`), serialized via `WmlConfig.toJSON()`. Lets the browser
   * run the scenario's real `[event]` handlers (prestart/start, etc.)
   * through the real event pump (`runScenarioStartupEvents` below),
   * recovering real `[message]`/`[story]`-driven behavior and the
   * `[event]`-spawned units this snapshot's own `units` list deliberately
   * does NOT pre-bake (see `spawnUnitsFromTree: false` at the call site
   * that produces this snapshot) -- running the events for real, once,
   * client-side is more correct than statically walking the WML tree for
   * every `[unit]` tag regardless of which event (if any) actually places
   * it, and it's what actually fixes "no support for message/story tags"
   * rather than working around it.
   */
  scenarioConfigJson: WmlConfigJson;
  /** The scenario's `[story][part]` blocks (real narrative text + background art, if any), meant to be shown as a click-through sequence before interactive play begins. Empty if the scenario has no `[story]`. */
  story?: StoryPart[];
  /**
   * Real castle/keep/village flags (from `data/core/terrain.cfg`'s
   * `recruit_onto`/`recruit_from`/`gives_income`) for every terrain code
   * the map actually uses, keyed by the code string (`Terrain.ts`'s
   * `writeTerrainCode`). Without this, `gameBoardFromSnapshot`'s
   * client-side `GameMap` has no `[terrain_type]` data at all (see this
   * module's doc comment on `buildFlatMoveType`'s "empty TerrainTypeData"
   * simplification), so `map.isKeep()`/`isCastle()` would always return
   * false and a leader could never be recognized as standing on a keep --
   * this is what makes recruiting possible client-side. Optional so
   * older/hand-built snapshots (e.g. this module's own tests) without it
   * still work, just with no castle/keep recognition, as before.
   */
  terrainFlags?: Record<string, TerrainCodeFlags>;
  /**
   * Every real `[terrain_type]` from `data/core/terrain.cfg` (all ~285 of
   * them, not just codes this map uses -- alias chains like `mvt_alias=`
   * can reference terrain ids that never appear on THIS particular map),
   * as `WmlConfig.toJSON()`. Lets `buildSnapshotContext` build a real,
   * full-fidelity `TerrainTypeData` client-side (superseding `terrainFlags`,
   * which only carried three booleans per code) so real per-unit-type
   * `MoveType` alias resolution matches the server exactly. Optional for
   * the same backward-compatibility reason as `terrainFlags`.
   */
  terrainTypeConfigs?: WmlConfigJson[];
  /** The real `[movetype]` registry (`name=` -> config) -- see this module's doc comment. Optional, same reason. */
  movementTypeConfigs?: Record<string, WmlConfigJson>;
  /**
   * Every unit type's fully-flattened `[unit_type]` config (see
   * `model/UnitTypeDatabase.ts`), keyed by id, as `WmlConfig.toJSON()`.
   * When present, `buildSnapshotContext` builds each `UnitType` via the
   * real `UnitType.fromConfig(cfg, movementTypeConfigs, terrainTypeConfigs)`
   * instead of the flat-shared-MoveType fallback -- see this module's doc
   * comment. Optional, same backward-compatibility reason as `terrainFlags`.
   */
  unitTypeConfigs?: Record<string, WmlConfigJson>;
  /**
   * The real `[units][weapon_specials]` registry (id -> that special's own
   * tag name + config, e.g. `poison` -> `{tag: "poison", config: [poison]
   * id=poison ... [/poison]'s config}`), as `WmlConfig.toJSON()` -- see
   * `UnitTypeDatabase.ts`'s `collectSpecialRegistry` (including why the
   * tag name travels alongside the config, not just the bare attributes).
   * Lets `buildSnapshotContext` resolve real content's `[attack]
   * specials_list=marksman,poison` shorthand (common in `data/core/
   * units/`) client-side the same way the build script does, instead of
   * those units silently having no specials recognized at all. Optional,
   * same backward-compatibility reason as `terrainFlags`.
   */
  weaponSpecialConfigs?: Record<string, { tag: string; config: WmlConfigJson }>;
  /** The real `[units][abilities]` registry, resolving `[unit_type] abilities_list=skirmisher` shorthand -- see `weaponSpecialConfigs`'s own doc comment, same rationale for abilities instead of weapon specials. */
  abilityConfigs?: Record<string, { tag: string; config: WmlConfigJson }>;
}

/** Real castle/keep/village flags for one terrain code -- see `GameBoardSnapshot.terrainFlags`. */
export interface TerrainCodeFlags {
  castle: boolean;
  keep: boolean;
  village: boolean;
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

/** Every distinct terrain code `snapshot.terrain` uses, in first-seen order -- shared by `createTypeResolver`/`gameBoardFromSnapshot`. */
function terrainCodesInUse(snapshot: GameBoardSnapshot): TerrainCode[] {
  const codesInUse: TerrainCode[] = [];
  const seenCodes = new Set<string>();
  for (const hex of snapshot.terrain) {
    if (seenCodes.has(hex.code)) continue;
    seenCodes.add(hex.code);
    codesInUse.push(parseTerrainCode(hex.code));
  }
  return codesInUse;
}

/**
 * Builds the `TerrainTypeData` `buildSnapshotContext` uses. Prefers
 * `snapshot.terrainTypeConfigs` (the real, full `data/core/terrain.cfg`
 * `[terrain_type]` set -- see that field's doc comment) when present, for
 * full-fidelity alias resolution. Falls back to `snapshot.terrainFlags`
 * (synthesizing one minimal `[terrain_type]`-equivalent config per code
 * carrying just its real castle/keep/village flags -- enough for
 * `GameMap.isKeep()`/`isCastle()`, not for real movement/defense alias
 * chasing) for older snapshots, then to a genuinely empty `TerrainTypeData`
 * for snapshots with neither (e.g. hand-built test fixtures) --
 * `buildFlatMoveType` documents why that's still safe for movement/defense
 * purposes in that case; castle/keep just aren't recognized then.
 */
function buildTerrainTypeData(snapshot: GameBoardSnapshot): TerrainTypeData {
  if (snapshot.terrainTypeConfigs) {
    return TerrainTypeData.fromConfigs(snapshot.terrainTypeConfigs.map((json) => WmlConfig.fromJSON(json)));
  }
  if (!snapshot.terrainFlags) return TerrainTypeData.fromConfigs([]);
  const configs: WmlConfig[] = [];
  for (const [codeStr, flags] of Object.entries(snapshot.terrainFlags)) {
    const cfg = new WmlConfig();
    cfg.setAttribute('id', codeStr);
    cfg.setAttribute('string', codeStr);
    cfg.setAttribute('gives_income', flags.village);
    cfg.setAttribute('recruit_onto', flags.castle);
    cfg.setAttribute('recruit_from', flags.keep);
    configs.push(cfg);
  }
  return TerrainTypeData.fromConfigs(configs);
}

/** The `TerrainTypeData` and per-id `UnitType` cache shared by `createTypeResolver`/`gameBoardFromSnapshot` -- see `buildSnapshotContext`. */
interface SnapshotContext {
  readonly terrainData: TerrainTypeData;
  /** Per-id unit types; with `unitTypeConfigs` each type is built on first lookup (see `buildSnapshotContextUncached`). */
  readonly typeCache: { get(id: string): UnitType | undefined };
}

/**
 * Builds the real `TerrainTypeData` and a per-id `UnitType` cache for
 * `snapshot`. When `snapshot.unitTypeConfigs` is present, each `UnitType` is
 * built via the real `UnitType.fromConfig(cfg, movementTypes, terrainData)`
 * -- real per-type movement/defense/resistance tables, real alias chasing,
 * exactly as `build-scenario-snapshot.mjs` computed them server-side.
 * Otherwise falls back to the flat-shared-`MoveType` construction from
 * `snapshot.unitTypes`' scalar fields -- see this module's doc comment.
 */
function buildSnapshotContext(snapshot: GameBoardSnapshot): SnapshotContext {
  // Built once per snapshot object: `GameSession` asks for it through both `gameBoardFromSnapshot` and
  // `createTypeResolver`, and parsing ~330 unit type configs twice cost ~200-400 ms of main-thread time
  // while loading a scenario (Phase 28a P3 profile). Sharing also means board units and later-resolved
  // types use the same `UnitType` instances.
  const cached = snapshotContexts.get(snapshot);
  if (cached) return cached;
  const context = buildSnapshotContextUncached(snapshot);
  snapshotContexts.set(snapshot, context);
  return context;
}

const snapshotContexts = new WeakMap<GameBoardSnapshot, SnapshotContext>();

function buildSnapshotContextUncached(snapshot: GameBoardSnapshot): SnapshotContext {
  const terrainData = buildTerrainTypeData(snapshot);
  if (snapshot.unitTypeConfigs) {
    const unitTypeConfigs = snapshot.unitTypeConfigs;
    const movementTypes = new Map<string, WmlConfig>();
    if (snapshot.movementTypeConfigs) {
      for (const [name, json] of Object.entries(snapshot.movementTypeConfigs)) {
        movementTypes.set(name, WmlConfig.fromJSON(json));
      }
    }
    const weaponSpecials = new Map<string, RegistryEntry>();
    if (snapshot.weaponSpecialConfigs) {
      for (const [id, entry] of Object.entries(snapshot.weaponSpecialConfigs)) {
        weaponSpecials.set(id, { tag: entry.tag, config: WmlConfig.fromJSON(entry.config) });
      }
    }
    const abilities = new Map<string, RegistryEntry>();
    if (snapshot.abilityConfigs) {
      for (const [id, entry] of Object.entries(snapshot.abilityConfigs)) {
        abilities.set(id, { tag: entry.tag, config: WmlConfig.fromJSON(entry.config) });
      }
    }
    // Built on first lookup: a snapshot carries every type a scenario could ever need (~330), but a game
    // resolves only a handful, and parsing all of them up front was ~250 ms in one main-thread task while
    // loading Dead Water 1 (Phase 28a P4 profile).
    const built = new Map<string, UnitType>();
    const typeCache = {
      get(id: string): UnitType | undefined {
        let type = built.get(id);
        if (type) return type;
        if (!Object.prototype.hasOwnProperty.call(unitTypeConfigs, id)) return undefined;
        type = UnitType.fromConfig(WmlConfig.fromJSON(unitTypeConfigs[id]!), movementTypes, terrainData, { weaponSpecials, abilities });
        built.set(id, type);
        return type;
      },
    };
    return { terrainData, typeCache };
  }

  const typeCache = new Map<string, UnitType>();
  const moveType = buildFlatMoveType(terrainCodesInUse(snapshot), terrainData);
  for (const [id, snap] of Object.entries(snapshot.unitTypes)) {
    typeCache.set(id, unitTypeFromSnapshot(snap, moveType));
  }
  return { terrainData, typeCache };
}

/**
 * Builds a `(id: string) => UnitType` resolver covering every unit type in
 * `snapshot.unitTypes`/`snapshot.unitTypeConfigs` (~332 real types, see
 * `GameBoardSnapshot.unitTypes`'s doc comment -- not just types already
 * present on the board), sharing `buildSnapshotContext` with
 * `gameBoardFromSnapshot`. Callers that need to resolve a type *after*
 * initial board construction -- `runScenarioStartupEvents` (an `[event]`'s
 * `[unit]` tag can name any type) and a client-side recruit flow (a side's
 * `recruit=` list can name any type) -- both need this, since
 * `gameBoardFromSnapshot`'s own internal type cache is not exposed.
 */
export function createTypeResolver(snapshot: GameBoardSnapshot): (id: string) => UnitType {
  const { typeCache } = buildSnapshotContext(snapshot);

  return (id: string) => {
    const type = typeCache.get(id);
    if (!type) {
      throw new Error(`createTypeResolver: unknown typeId "${id}"`);
    }
    return type;
  };
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
  const { terrainData, typeCache } = buildSnapshotContext(snapshot);

  const map = GameMap.fromMapString(snapshot.map.data, terrainData, snapshot.map.border);
  const board = new GameBoard(map);

  for (const t of snapshot.teams) {
    board.addTeam(
      new Team(t.side, {
        controller: parseController(t.controller),
        gold: t.gold,
        teamName: t.teamName,
        color: t.color,
        canRecruit: new Set(t.recruit ?? []),
        income: t.income ?? 0,
        incomePerVillage: t.incomePerVillage ?? 1,
        supportPerVillage: t.supportPerVillage ?? 1,
        shareVision: t.shareVision ?? 'all',
        noLeader: t.noLeader ?? false,
      }),
    );
    const team = board.getTeam(t.side)!;
    team.fog.enabled = t.fog ?? false;
    team.fog.read(t.fogData ?? '');
    team.shroud.enabled = t.shroud ?? false;
    team.shroud.read(t.shroudData ?? '');
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
    // Real, reported bug: a scenario-authored [unit] experience= override
    // (e.g. a debug scenario setting a unit up one hit from advancing) was
    // silently dropped here -- same shape as the hitpoints override just
    // above, just never written. Optional since older/static snapshots
    // built before build-scenario-snapshot.mjs started emitting these
    // don't have them (real Unit.create defaults already apply in that
    // case, same as before this fix).
    if (u.experience !== undefined) unit.experience = u.experience;
    if (u.maxExperience !== undefined) unit.maxExperience = u.maxExperience;
    board.assignUnitId(unit);
    board.addUnit(unit);
    // Mirrors `GameBoard.fromConfig`'s own initial-placement capture (real
    // `unit_creator`'s default `allow_get_village=true`) -- this snapshot's
    // `units` list doesn't separately carry village-ownership state, so
    // re-deriving it here from each unit's real starting position gives
    // the same result without needing a new snapshot field.
    board.captureVillage(unit.location, unit.side);
    unitsByKey.set(unitKeyFor(u), unit);
  }

  return { board, unitsByKey };
}

export interface RunScenarioEventsOptions {
  /** Looks up a `UnitType` by id for any `[unit]` tag an event spawns -- see `GameBoardSnapshot.unitTypes`' doc comment on why it needs to cover more than just the units present at t=0. */
  resolveType: (id: string) => UnitType;
  /** Shared across calls if you plan to `runScenarioStartupEvents` more than once (e.g. prestart now, a later turn-based event later) so state (disabled non-repeatable handlers) persists. Defaults to a fresh registry via `createDefaultActionRegistry()`. */
  registry?: ActionRegistry;
  /** Reuses an existing `VariableStore` (e.g. to preserve variables across multiple event-firing calls) instead of starting fresh. */
  variables?: VariableStore;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export interface ScenarioEventsResult {
  /** `[message]` output recorded while running the requested events, in firing order -- see `RecordedMessage`. */
  messages: RecordedMessage[];
  /** The live variable store used, in case the caller wants to inspect/reuse it (e.g. for a later `runScenarioStartupEvents` call in the same session). */
  variables: VariableStore;
  /** Real `[objectives]` firings, by side -- see `EventContext.objectivesBySide`'s own doc comment. */
  objectivesBySide: Map<number, ScenarioObjectives>;
}

/**
 * Runs a scenario's real `[event]` handlers (by name, e.g. `'prestart'`
 * then `'start'`, matching upstream's real startup sequence) against a live
 * `board` through the real event pump (`events/pump.ts`), mutating the
 * board exactly as the scenario's own WML says to (spawning `[unit]`s,
 * `[message]` dialogue recorded rather than displayed as a blocking dialog
 * -- see `RecordedMessage`). This is the client-side counterpart to
 * `gameBoardFromSnapshot`: call that first to get a bare board (map/teams/
 * any pre-baked units), then this to bring it to life the way the real
 * scenario intends.
 */
export function runScenarioStartupEvents(
  board: GameBoard,
  scenarioConfigJson: WmlConfigJson,
  eventNames: readonly string[],
  options: RunScenarioEventsOptions,
): ScenarioEventsResult {
  const scenarioCfg = WmlConfig.fromJSON(scenarioConfigJson);
  const manager = new EventManager();
  manager.loadScenarioEvents(scenarioCfg);

  const variables = options.variables ?? new VariableStore();
  const pump = new EventPump(manager, {
    board,
    variables,
    resolveType: options.resolveType,
    registry: options.registry ?? createDefaultActionRegistry(),
    log: options.log,
  });

  for (const name of eventNames) {
    pump.fire(name);
  }

  return { messages: pump.ctx.messages, variables, objectivesBySide: pump.ctx.objectivesBySide };
}
