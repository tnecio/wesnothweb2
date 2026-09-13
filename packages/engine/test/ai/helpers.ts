import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefinesFromDir, type DefineMap } from '../../src/wml/index.js';
import { WmlConfig } from '../../src/wml/config.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { UnitType, AttackType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { RngDeterministic } from '../../src/rng/RngDeterministic.js';
import { MtRng } from '../../src/rng/MtRng.js';
import type { AiHost } from '../../src/ai/types.js';

/**
 * Shared test helpers for `test/ai/**` (originally `simpleAi.test.ts`'s
 * own local helpers, extracted here for Phase 29's real AI candidate-
 * action tests, which need the exact same "real keep/castle/village
 * terrain classification + hand-verifiable unit stats" board). See
 * `simpleAi.test.ts`'s own former module doc comment (now here) for the
 * rationale: real terrain data is loaded from `data/core/terrain.cfg`
 * (`TerrainTypeData.fromConfigs([])`'s "no registered terrain types"
 * fallback makes every `isKeep`/`isCastle`/`isVillage` check false -- see
 * `Terrain.ts`'s `findOrCreate`), while unit types themselves are hand-
 * built with deliberately simple, hand-verifiable stats (matching
 * `combat.test.ts`'s own established pattern) since the point of these
 * tests is the AI's DECISIONS, not real unit balance.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');

export function loadTerrainData(): TerrainTypeData {
  const defines: DefineMap = new Map();
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  const cfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), { dataRoot, defines });
  return TerrainTypeData.fromConfigs(cfg.children('terrain_type'));
}

/**
 * `[movement_costs]`/`[defense]` are keyed by real *terrain type id*
 * (e.g. `flat`, `castle`), NOT the map's `Gg`-style terrain *code* --
 * confirmed directly against `data/core/terrain.cfg`: `Gg` (grassland)
 * aliases to `Gt`, whose own `id=` is `flat`; `Kh`/`Ch` (keep/castle)
 * both alias to `Ct`, whose `id=` is `castle`; the village overlay
 * `^Vh`'s alias chain includes `Gt` too, so `flat`/`castle` cover all
 * four terrain codes `makeBoard` below uses (see `MoveType.ts`'s own
 * module doc comment on this key convention -- `combat.test.ts`'s
 * simpler `flatMoveType` gets away with using the raw code as the key
 * only because it uses an EMPTY `TerrainTypeData`, whose `fromDefault`
 * fallback makes a code alias to itself).
 */
export function flatMoveType(terrainData: TerrainTypeData, defensePercent = 50): MoveType {
  const cfg = new WmlConfig();
  const defense = cfg.addChild('defense');
  defense.setAttribute('flat', defensePercent);
  defense.setAttribute('castle', defensePercent);
  const movementCosts = cfg.addChild('movement_costs');
  movementCosts.setAttribute('flat', 1);
  movementCosts.setAttribute('castle', 1);
  return MoveType.fromConfig(cfg, terrainData);
}

export function makeWeapon(damage: number, numAttacks: number): AttackType {
  const cfg = new WmlConfig();
  cfg.setAttribute('name', 'test-weapon');
  cfg.setAttribute('type', 'blade');
  cfg.setAttribute('range', 'melee');
  cfg.setAttribute('damage', damage);
  cfg.setAttribute('number', numAttacks);
  return AttackType.fromConfig(cfg);
}

export function makeUnitType(id: string, hitpoints: number, moveType: MoveType, weapon: AttackType, cost = 10, usage = ''): UnitType {
  return new UnitType(id, id, '', 'neutral', 1, hitpoints, 5, 5, 0, 1, cost, -1, 500, [], '', false, false, false, moveType, [weapon], [], 2, [], false, usage);
}

/**
 * A 6x6 (WML-coordinate) grass board with a keep+castle in the top-left
 * corner (Kh at wml (1,1), Ch at wml (2,1) and (1,2)) and a village at wml
 * (4,4), all real terrain codes. The raw map text is 8x8 -- `GameMap.
 * fromMapString`'s default 1-tile border consumes the outermost raw
 * row/column on every side (confirmed directly: a naive 6x6 raw grid
 * parses to a 4x4 *playable* area with the intended top-left content
 * landing on the border, i.e. off-board -- see `combat.test.ts`'s own
 * note on this same pitfall), so the intended 6x6 content is padded with
 * one extra border row/column of filler terrain on every side.
 */
export function makeBoard(terrainData: TerrainTypeData): GameBoard {
  const mapText = [
    'Gg, Gg, Gg, Gg, Gg, Gg, Gg, Gg',
    'Gg, Kh, Ch, Gg, Gg, Gg, Gg, Gg',
    'Gg, Ch, Gg, Gg, Gg, Gg, Gg, Gg',
    'Gg, Gg, Gg, Gg, Gg, Gg, Gg, Gg',
    'Gg, Gg, Gg, Gg, Gg^Vh, Gg, Gg, Gg',
    'Gg, Gg, Gg, Gg, Gg, Gg, Gg, Gg',
    'Gg, Gg, Gg, Gg, Gg, Gg, Gg, Gg',
    'Gg, Gg, Gg, Gg, Gg, Gg, Gg, Gg',
  ].join('\n');
  const map = GameMap.fromMapString(mapText, terrainData);
  const board = new GameBoard(map);
  board.addTeam(new Team(1, { gold: 100, controller: 'ai' }));
  board.addTeam(new Team(2, { gold: 100 }));
  return board;
}

/**
 * Phase 29's `AiHost` test double -- every field is overridable; sensible,
 * inert defaults for the rest (RNG seeded for determinism, no time-of-day
 * bonus, no fired events recorded unless the caller supplies its own
 * `raise`). Used by every RCA-framework/candidate-action test.
 */
export function makeAiHost(board: GameBoard, overrides: Partial<AiHost> = {}): AiHost {
  return {
    board,
    rng: new RngDeterministic(new MtRng(1)),
    resolveType: (id: string) => {
      throw new Error(`makeAiHost: no resolveType configured, asked for "${id}"`);
    },
    lawfulBonusAt: () => 0,
    maxLiminalBonus: 0,
    turnNumber: () => 1,
    timeOfDayId: () => '',
    raise: () => undefined,
    fire: () => undefined,
    pump: () => undefined,
    log: () => undefined,
    scenarioEnded: () => false,
    ...overrides,
  };
}
