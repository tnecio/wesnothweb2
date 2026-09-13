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
import { recruitUnit, recallUnit, dismissUnit, dismissUnitAt, canRecruitOn, checkRecruitLocation, generateTraits } from '../../src/actions/recruit.js';
import { GLOBAL_TRAITS } from '../../src/model/UnitType.js';
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

    const result = recruitUnit(board, team, recruitType, castleLoc, keepLoc, new RngDeterministic(new MtRng(2026)));

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

  it("dismissUnitAt removes exactly the unit at that recall-list POSITION, even when several entries share the default underlyingId=0 -- real, reported bug class: dismissUnit's underlyingId key is ambiguous for exactly this common case (this project doesn't auto-assign unique underlying_ids, so most recall-list units share underlyingId=0)", () => {
    const terrainData = loadTerrainData();
    const moveType = flatMoveType(terrainData);
    const board = new GameBoard(GameMap.fromMapString('Gg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg, Gg', terrainData));
    board.addTeam(new Team(1));
    const type = makeUnitType('grunt', 20, moveType);
    const a = Unit.create(type, 1, Location.NULL);
    const b = Unit.create(type, 1, Location.NULL);
    const c = Unit.create(type, 1, Location.NULL);
    expect(a.underlyingId).toBe(0);
    expect(b.underlyingId).toBe(0);
    expect(c.underlyingId).toBe(0); // all three share the same default -- dismissUnit(board, 1, 0) could only ever remove the FIRST of them.
    board.addToRecallList(1, a);
    board.addToRecallList(1, b);
    board.addToRecallList(1, c);

    const dismissed = dismissUnitAt(board, 1, 1); // the middle entry, by position.
    expect(dismissed).toBe(b);
    expect(board.recallList(1)).toEqual([a, c]);
  });

  it('recruiting gives the fresh unit exactly numTraits (2) real random traits, drawn from the real global pool -- real, reported bug: recruited units never got any traits at all', () => {
    const terrainData = loadTerrainData();
    const moveType = flatMoveType(terrainData);
    const map = GameMap.fromMapString('Gg, Gg, Gg, Gg\nGg, Kh, Ch, Gg\nGg, Gg, Gg, Gg\nGg, Gg, Gg, Gg', terrainData);
    const board = new GameBoard(map);
    const team = new Team(1, { gold: 50 });
    board.addTeam(team);

    const recruitType = makeUnitType('grunt', 20, moveType);
    const result = recruitUnit(board, team, recruitType, Location.fromWml(2, 1), Location.fromWml(1, 1), new RngDeterministic(new MtRng(2026)));

    const traitIds = result.unit.modifications.filter((m) => m.kind === 'trait').map((m) => m.cfg.getString('id'));
    expect(traitIds).toHaveLength(2);
    expect(new Set(traitIds).size).toBe(2); // no trait picked twice
    const globalIds = new Set(GLOBAL_TRAITS.map((t) => t.getString('id')));
    for (const id of traitIds) expect(globalIds.has(id)).toBe(true);
    expect(result.unit.traitNames).toEqual(traitIds); // strong/quick/intelligent/resilient display the same as their id
  });
});

describe('generateTraits (mirrors unit::generate_traits)', () => {
  function trait(attrs: Record<string, string>): WmlConfig {
    const cfg = new WmlConfig();
    for (const [k, v] of Object.entries(attrs)) cfg.setAttribute(k, v);
    return cfg;
  }

  it('adds every musthave trait unconditionally, even past numTraits, and does not random-fill beyond numTraits once musthave traits already fill it', () => {
    const terrainData = loadTerrainData();
    const moveType = flatMoveType(terrainData);
    const type = new UnitType(
      'mudcrawler', 'mudcrawler', '', 'neutral', 1, 20, 5, 5, 0, 1, 10, -1, 32, [], '', false, false, false, moveType,
      [AttackType.fromConfig(new WmlConfig())], [], 1,
      [trait({ id: 'mechanical', availability: 'musthave' }), ...GLOBAL_TRAITS],
    );
    const picked = generateTraits(type, new RngDeterministic(new MtRng(1)));
    expect(picked.map((m) => m.cfg.getString('id'))).toEqual(['mechanical']);
  });

  it('honors require_traits: a trait requiring another unpicked trait is skipped until that trait has been picked', () => {
    const terrainData = loadTerrainData();
    const moveType = flatMoveType(terrainData);
    const type = new UnitType(
      'test', 'test', '', 'neutral', 1, 20, 5, 5, 0, 1, 10, -1, 32, [], '', false, false, false, moveType,
      [AttackType.fromConfig(new WmlConfig())], [], 2,
      [trait({ id: 'strong_swimmer', require_traits: 'strong' }), trait({ id: 'strong' })],
    );
    const picked = generateTraits(type, new RngDeterministic(new MtRng(1)));
    expect(picked.map((m) => m.cfg.getString('id'))).toEqual(['strong', 'strong_swimmer']);
  });

  it('honors exclude_traits: once one of a mutually-exclusive pair is picked, the other is never a candidate, so a slot can go unfilled', () => {
    const terrainData = loadTerrainData();
    const moveType = flatMoveType(terrainData);
    const type = new UnitType(
      'test', 'test', '', 'neutral', 1, 20, 5, 5, 0, 1, 10, -1, 32, [], '', false, false, false, moveType,
      [AttackType.fromConfig(new WmlConfig())], [], 2,
      [trait({ id: 'weak', exclude_traits: 'strong' }), trait({ id: 'strong' })],
    );
    const picked = generateTraits(type, new RngDeterministic(new MtRng(1)));
    expect(picked).toHaveLength(1); // whichever of weak/strong got picked first excludes the other, and there's no 3rd candidate
    expect(['weak', 'strong']).toContain(picked[0]!.cfg.getString('id'));
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

  it('real, reported bug: advancing fully heals but does NOT restore moves/attacks -- they carry over (clamped) from before the triggering combat', () => {
    const terrainData = loadTerrainData();
    const moveType = flatMoveType(terrainData);
    const baseType = makeUnitType('grunt', 30, moveType, 10, -1, 1, ['veteran']);
    const advancedType = makeUnitType('veteran', 60, moveType, 20, -1, 2);
    const unit = Unit.create(baseType, 1, Location.fromWml(1, 1));
    unit.experience = 35;
    // Simulates the real sequence: the unit spent its move and its one
    // attack to make the very attack that leveled it up.
    unit.movesLeft = 0;
    unit.attacksLeft = 0;

    advanceUnitTo(unit, advancedType);

    expect(unit.hitpoints).toBe(60); // still fully healed
    expect(unit.movesLeft).toBe(0); // NOT reset to the new type's movement=5
    expect(unit.attacksLeft).toBe(0); // NOT reset to the new type's max_attacks=1
    expect(unit.maxMoves).toBe(5); // the new type's own max IS updated
    expect(unit.maxAttacksPerTurn).toBe(1);
  });

  it('advancing clamps carried-over moves/attacks down to the new type\'s (possibly lower) max, rather than leaving an impossible excess', () => {
    const terrainData = loadTerrainData();
    const moveType = flatMoveType(terrainData);
    const baseType = new UnitType('scout', 'scout', '', 'neutral', 1, 20, 9, 5, 0, 2, 10, -1, 32, ['footman'], '', false, false, false, moveType, [AttackType.fromConfig(new WmlConfig())], []);
    const advancedType = makeUnitType('footman', 40, moveType, 20, -1, 2); // movement=5, maxAttacksPerTurn=1 -- both lower than scout's.
    const unit = Unit.create(baseType, 1, Location.fromWml(1, 1));
    unit.experience = 100;
    unit.movesLeft = 9; // scout's full movement -- didn't move at all this turn.
    unit.attacksLeft = 2;

    advanceUnitTo(unit, advancedType);

    expect(unit.movesLeft).toBe(5); // clamped to the new (lower) max, not left at 9
    expect(unit.attacksLeft).toBe(1);
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
