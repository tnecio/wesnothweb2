import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefinesFromDir, type DefineMap } from '../../src/wml/index.js';
import { WmlConfig } from '../../src/wml/config.js';
import { Location } from '../../src/model/Location.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { UnitType, AttackType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { RngDeterministic } from '../../src/rng/RngDeterministic.js';
import { MtRng } from '../../src/rng/MtRng.js';
import { recruitUnit, recallUnit, dismissUnit, canRecruitOn, checkRecruitLocation } from '../../src/actions/recruit.js';
import { calculateHealing, applySideHealing } from '../../src/actions/heal.js';
import { advanceUnitTo, chooseAdvancementRandomly } from '../../src/actions/advancement.js';
import { killXp, combatXp } from '../../src/actions/gameConfig.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');

function loadTerrainData(): TerrainTypeData {
  const defines: DefineMap = new Map();
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  const cfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), { dataRoot, defines });
  return TerrainTypeData.fromConfigs(cfg.children('terrain_type'));
}

function flatMoveType(terrainData: TerrainTypeData): MoveType {
  return MoveType.fromConfig(new WmlConfig(), terrainData);
}

function makeUnitType(id: string, hitpoints: number, moveType: MoveType, cost = 10, recallCost = -1, level = 1, advancesTo: string[] = []): UnitType {
  return new UnitType(id, id, '', 'neutral', level, hitpoints, 5, 5, 0, 1, cost, recallCost, 32, advancesTo, '', false, false, false, moveType, [AttackType.fromConfig(new WmlConfig())], []);
}

describe('gameConfig formulas (pinned against real game_config.cpp values)', () => {
  it('killXp: level*8, or 4 for a level-0 unit', () => {
    expect(killXp(1)).toBe(8);
    expect(killXp(3)).toBe(24);
    expect(killXp(0)).toBe(4);
  });
  it('combatXp: level*1', () => {
    expect(combatXp(0)).toBe(0);
    expect(combatXp(5)).toBe(5);
  });
});

describe('recruit/recall/dismiss', () => {
  it('recruiting spends exactly the unit type cost and places a fresh, fully-healed, moveless unit on a real keep+castle map', () => {
    const terrainData = loadTerrainData();
    const moveType = flatMoveType(terrainData);
    // Kh = human keep, Ch = human castle -- real terrain codes.
    const mapText = 'Gg, Gg, Gg, Gg\nGg, Kh, Ch, Gg\nGg, Gg, Gg, Gg\nGg, Gg, Gg, Gg';
    const map = GameMap.fromMapString(mapText, terrainData);
    const board = new GameBoard(map);
    const team = new Team(1, { gold: 50 });
    board.addTeam(team);

    const leaderType = makeUnitType('leader', 30, moveType);
    // Map text/wml coordinate mapping confirmed by direct debugging (raw
    // index N == wml N, same convention established earlier for
    // Home_1.map): a 4x4 raw grid with Kh/Ch on its second row/cols 2-3
    // puts them at wml(1,1)/wml(2,1), NOT wml(2,2)/wml(3,2) as a first
    // attempt at this test assumed -- that landed on plain "Gg" instead,
    // which is exactly why canRecruitOn came back false.
    const keepLoc = Location.fromWml(1, 1); // Kh
    const leader = Unit.create(leaderType, 1, keepLoc, { canRecruit: true });
    board.addUnit(leader);

    const recruitType = makeUnitType('grunt', 20, moveType, 15);
    const castleLoc = Location.fromWml(2, 1); // Ch, connected to the keep

    expect(canRecruitOn(board, leader, castleLoc)).toBe(true);
    const check = checkRecruitLocation(board, 1, castleLoc, keepLoc, () => true);
    expect(check.result).toBe('ok');

    const result = recruitUnit(board, team, recruitType, castleLoc, keepLoc);

    expect(team.gold).toBe(35); // 50 - 15
    expect(result.unit.hitpoints).toBe(20); // healed to full
    expect(result.unit.movesLeft).toBe(0); // can't act the turn it's recruited
    expect(result.unit.attacksLeft).toBe(0);
    expect(board.unitAt(castleLoc)).toBe(result.unit);
  });

  it('recall uses the unit-instance recallCost override when set, otherwise the team default, and preserves saved hp/xp', () => {
    const terrainData = loadTerrainData();
    const moveType = flatMoveType(terrainData);
    const mapText = 'Gg, Gg, Gg, Gg\nGg, Kh, Ch, Gg\nGg, Gg, Gg, Gg\nGg, Gg, Gg, Gg';
    const map = GameMap.fromMapString(mapText, terrainData);
    const board = new GameBoard(map);
    const team = new Team(1, { gold: 100, recallCost: 20 });
    board.addTeam(team);

    const veteranType = makeUnitType('veteran', 40, moveType, 10, 12); // recallCost=12, overrides team default
    const veteran = Unit.create(veteranType, 1, Location.NULL);
    veteran.hitpoints = 25; // damaged, should stay damaged across recall
    veteran.experience = 7;
    board.addToRecallList(1, veteran);

    const removed = board.removeFromRecallList(1, veteran.underlyingId);
    expect(removed).toBe(veteran);

    const result = recallUnit(board, team, veteran, Location.fromWml(2, 1), Location.fromWml(1, 1));
    expect(team.gold).toBe(88); // 100 - 12 (the unit's own recallCost, not the team's 20 default)
    expect(result.unit.hitpoints).toBe(25); // recalled units keep saved hp, unlike fresh recruits
    expect(result.unit.experience).toBe(7);
  });

  it('dismissUnit removes exactly the targeted unit by underlyingId, leaving others untouched', () => {
    const terrainData = loadTerrainData();
    const moveType = flatMoveType(terrainData);
    const board = new GameBoard(GameMap.fromMapString('Gg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg', terrainData));
    board.addTeam(new Team(1));
    const type = makeUnitType('grunt', 20, moveType);
    const a = Unit.create(type, 1, Location.NULL);
    const b = Unit.create(type, 1, Location.NULL);
    board.addToRecallList(1, a);
    board.addToRecallList(1, b);

    const dismissed = dismissUnit(board, 1, a.underlyingId);
    expect(dismissed).toBe(a);
    expect(board.recallList(1)).toEqual([b]);
  });
});

describe('healing', () => {
  it('a unit resting (not moved/attacked) in a friendly-village-free spot heals the base resting amount, capped at max hp', () => {
    const terrainData = loadTerrainData();
    const moveType = flatMoveType(terrainData);
    const board = new GameBoard(GameMap.fromMapString('Gg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg', terrainData));
    board.addTeam(new Team(1));
    const type = makeUnitType('grunt', 30, moveType);
    const unit = Unit.create(type, 1, Location.fromWml(2, 2));
    unit.hitpoints = 20;
    unit.resting = true;
    board.addUnit(unit);

    const outcomes = calculateHealing(board, 1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.amount).toBeGreaterThan(0);
    expect(unit.hitpoints + outcomes[0]!.amount).toBeLessThanOrEqual(unit.maxHitpoints);

    applySideHealing(board, 1);
    expect(unit.hitpoints).toBe(20 + outcomes[0]!.amount);
  });

  it('never heals a unit above its own max hitpoints', () => {
    const terrainData = loadTerrainData();
    const moveType = flatMoveType(terrainData);
    const board = new GameBoard(GameMap.fromMapString('Gg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg', terrainData));
    board.addTeam(new Team(1));
    const type = makeUnitType('grunt', 30, moveType);
    const unit = Unit.create(type, 1, Location.fromWml(2, 2));
    unit.hitpoints = 29; // one below max -- REST_HEAL_AMOUNT (2) would overshoot to 31 uncapped
    unit.resting = true;
    board.addUnit(unit);

    const [outcome] = calculateHealing(board, 1);
    expect(outcome!.amount).toBe(1); // capped to exactly what's missing, not the full rest-heal amount
    expect(unit.hitpoints + outcome!.amount).toBe(30);
  });
});

describe('advancement', () => {
  it('advancing to a new type fully heals the unit (a deliberate reward -- confirmed against actions/advancement.cpp\'s get_advanced_unit, which explicitly calls heal_fully() after advance_to(), not a ratio-scaling of current/max hp) and keeps overflow xp', () => {
    const terrainData = loadTerrainData();
    const moveType = flatMoveType(terrainData);
    const baseType = makeUnitType('grunt', 30, moveType, 10, -1, 1, ['veteran']);
    const advancedType = makeUnitType('veteran', 60, moveType, 20, -1, 2);
    const unit = Unit.create(baseType, 1, Location.fromWml(1, 1));
    unit.hitpoints = 15; // damaged -- must not matter, advancing always fully heals
    unit.experience = 35; // over the level-1 threshold (32 for a default experience=32 type)

    const result = advanceUnitTo(unit, advancedType);

    expect(unit.type).toBe(advancedType);
    expect(unit.maxHitpoints).toBe(60);
    expect(unit.hitpoints).toBe(60); // fully healed, not ratio-scaled
    expect(unit.level).toBe(2);
    expect(unit.experience).toBeGreaterThanOrEqual(0);
    expect(result.toTypeId).toBe(advancedType.id);
  });

  it('chooseAdvancementRandomly only ever returns one of the unit type\'s own declared advancesTo options', () => {
    const terrainData = loadTerrainData();
    const moveType = flatMoveType(terrainData);
    const baseType = makeUnitType('grunt', 30, moveType, 10, -1, 1, ['optionA', 'optionB']);
    const unit = Unit.create(baseType, 1, Location.fromWml(1, 1));
    const typesById = new Map([
      ['optionA', makeUnitType('optionA', 40, moveType)],
      ['optionB', makeUnitType('optionB', 45, moveType)],
    ]);
    const rng = new RngDeterministic(new MtRng(2026));

    for (let i = 0; i < 20; i++) {
      const chosen = chooseAdvancementRandomly(unit, rng, (id) => typesById.get(id)!);
      expect(['optionA', 'optionB']).toContain(chosen.id);
    }
  });
});
