import { describe, expect, it } from 'vitest';
import { WmlConfig } from '../../src/wml/config.js';
import { Location } from '../../src/model/Location.js';
import { Unit } from '../../src/model/Unit.js';
import { UnitType, AttackType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { RngDeterministic } from '../../src/rng/RngDeterministic.js';
import { MtRng } from '../../src/rng/MtRng.js';
import { playAiTurn } from '../../src/ai/simpleAi.js';
import { loadTerrainData, flatMoveType, makeWeapon, makeUnitType, makeBoard } from './helpers.js';

/**
 * `playAiTurn` tests. Real keep/castle/village terrain classification is
 * loaded from the real `data/core/terrain.cfg` (same established pattern
 * as `recruitHealAdvancement.test.ts`, since `TerrainTypeData.fromConfigs
 * ([])`'s "no registered terrain types" fallback makes every `isKeep`/
 * `isCastle`/`isVillage` check false -- see `Terrain.ts`'s `findOrCreate`).
 * Unit types themselves are hand-built with deliberately simple,
 * hand-verifiable stats, matching `combat.test.ts`'s own established
 * pattern -- the point of these tests is the AI's DECISIONS, not real
 * unit balance. Helpers now live in `./helpers.ts` (Phase 29: shared with
 * the real AI's own candidate-action tests, which need the same board).
 */

const terrainData = loadTerrainData();

describe('playAiTurn: recruiting', () => {
  it('recruits while it can afford to and a vacant castle tile remains, preferring the better power-per-cost type', () => {
    const board = makeBoard(terrainData);
    const moveType = flatMoveType(terrainData, 0); // 0% defense everywhere -- irrelevant to this test.
    const cheapType = makeUnitType('cheap', 10, moveType, makeWeapon(2, 1), 10);
    const strongType = makeUnitType('strong', 30, moveType, makeWeapon(6, 2), 20); // much better power/cost than cheap

    const team = board.getTeam(1)!;
    team.gold = 45;
    team.canRecruit = new Set(['cheap', 'strong']);
    const resolveType = (id: string): UnitType => (id === 'cheap' ? cheapType : strongType);

    const leaderType = makeUnitType('leader', 30, moveType, makeWeapon(1, 1), 0);
    const leader = Unit.create(leaderType, 1, Location.fromWml(1, 1), { canRecruit: true });
    board.addUnit(leader);

    const rng = new RngDeterministic(new MtRng(1));
    const actions = playAiTurn(board, 1, rng, { resolveType });

    const recruitActions = actions.filter((a) => a.kind === 'recruit');
    expect(recruitActions.length).toBeGreaterThan(0);
    // Only 2 castle tiles are vacant (the keep itself holds the leader, plus the Ch at (2,1)/(1,2) wml-coords)
    // -- with 45 gold and "strong" (20g) preferred, expect exactly 2 recruits of "strong" (40g spent, 5g left, can't afford a 3rd).
    expect(recruitActions).toHaveLength(2);
    expect(team.gold).toBe(5);
    const recruitedUnits = board.unitsForSide(1).filter((u) => u.type.id === 'strong');
    expect(recruitedUnits).toHaveLength(2);
  });

  it('recruits nothing when it cannot afford any recruit-list type', () => {
    const board = makeBoard(terrainData);
    const moveType = flatMoveType(terrainData, 0);
    const strongType = makeUnitType('strong', 30, moveType, makeWeapon(6, 2), 20);
    const team = board.getTeam(1)!;
    team.gold = 5;
    team.canRecruit = new Set(['strong']);
    const resolveType = (): UnitType => strongType;

    const leaderType = makeUnitType('leader', 30, moveType, makeWeapon(1, 1), 0);
    const leader = Unit.create(leaderType, 1, Location.fromWml(1, 1), { canRecruit: true });
    board.addUnit(leader);

    const rng = new RngDeterministic(new MtRng(1));
    const actions = playAiTurn(board, 1, rng, { resolveType });
    expect(actions.filter((a) => a.kind === 'recruit')).toHaveLength(0);
    expect(team.gold).toBe(5);
  });
});

describe('playAiTurn: combat decisions', () => {
  it('attacks a much weaker adjacent-reachable enemy (a clearly good trade)', () => {
    const board = makeBoard(terrainData);
    const moveType = flatMoveType(terrainData, 100); // 100 = "always hit" (see flatMoveType's doc comment), deterministic outcome.
    const strongType = makeUnitType('strong', 40, moveType, makeWeapon(10, 3));
    const weakType = makeUnitType('weak', 8, moveType, makeWeapon(1, 1));

    const attacker = Unit.create(strongType, 1, Location.fromWml(3, 3), { canRecruit: true });
    const target = Unit.create(weakType, 2, Location.fromWml(4, 3));
    board.addUnit(attacker);
    board.addUnit(target);

    const rng = new RngDeterministic(new MtRng(3));
    const actions = playAiTurn(board, 1, rng, { resolveType: () => strongType });

    const attackActions = actions.filter((a) => a.kind === 'attack');
    expect(attackActions).toHaveLength(1);
    expect(target.hitpoints).toBeLessThan(8);
    expect(attacker.attacksLeft).toBe(0);
  });

  it('does NOT attack when the trade is clearly bad (a much stronger adjacent enemy)', () => {
    const board = makeBoard(terrainData);
    const moveType = flatMoveType(terrainData, 100); // always hit -- isolates the score threshold, not chance-to-hit variance.
    const weakType = makeUnitType('weak', 8, moveType, makeWeapon(1, 1));
    const strongType = makeUnitType('strong', 40, moveType, makeWeapon(10, 3));

    const attacker = Unit.create(weakType, 1, Location.fromWml(3, 3), { canRecruit: true });
    const target = Unit.create(strongType, 2, Location.fromWml(4, 3));
    board.addUnit(attacker);
    board.addUnit(target);

    const rng = new RngDeterministic(new MtRng(3));
    const actions = playAiTurn(board, 1, rng, { resolveType: () => weakType });

    expect(actions.filter((a) => a.kind === 'attack')).toHaveLength(0);
    expect(target.hitpoints).toBe(40);
    expect(attacker.attacksLeft).toBe(1); // never attacked
  });

  it('real, reported bug: an ally standing on the only reachable attack position must not vanish while the AI evaluates attacking from its hex', () => {
    // `findRoutes` only blocks *enemy*-occupied hexes (allies are legal to
    // path *through* but not to stop on), so an ally-occupied hex still
    // shows up as a "destination" the AI's attack-scoring loop considers.
    // `evaluateAttack` used to temporarily relocate the unit under
    // evaluation onto that hex via `board.moveUnit` with no occupancy
    // check, silently overwriting (and permanently losing) whatever unit
    // already stood there. Colinear mover -> ally -> target chain: the
    // ONLY hex adjacent to `target` that `mover` can reach in one move is
    // `ally`'s own hex.
    const board = makeBoard(terrainData);
    const moveType = flatMoveType(terrainData, 100);
    const type = makeUnitType('soldier', 20, moveType, makeWeapon(5, 2));

    const mover = Unit.create(type, 1, Location.fromWml(3, 3), { canRecruit: true });
    mover.movesLeft = 1;
    mover.maxMoves = 1;
    const ally = Unit.create(type, 1, Location.fromWml(4, 3));
    ally.movesLeft = 0;
    ally.attacksLeft = 0;
    const target = Unit.create(type, 2, Location.fromWml(5, 3));
    board.addUnit(mover);
    board.addUnit(ally);
    board.addUnit(target);

    const rng = new RngDeterministic(new MtRng(3));
    playAiTurn(board, 1, rng, { resolveType: () => type });

    expect(board.unitAt(Location.fromWml(4, 3))).toBe(ally);
    expect(board.allUnits()).toContain(ally);
  });
});

describe('playAiTurn: real, reported bug -- AI actions carried no animation data at all', () => {
  it('an attack action carries a real AiAnimationEvent with the attacker/defender/weapon indices/result', () => {
    const board = makeBoard(terrainData);
    const moveType = flatMoveType(terrainData, 100);
    const strongType = makeUnitType('strong', 40, moveType, makeWeapon(10, 3));
    const weakType = makeUnitType('weak', 8, moveType, makeWeapon(1, 1));

    const attacker = Unit.create(strongType, 1, Location.fromWml(3, 3), { canRecruit: true });
    const target = Unit.create(weakType, 2, Location.fromWml(4, 3));
    board.addUnit(attacker);
    board.addUnit(target);

    const rng = new RngDeterministic(new MtRng(3));
    const actions = playAiTurn(board, 1, rng, { resolveType: () => strongType });

    const attackAction = actions.find((a) => a.kind === 'attack')!;
    expect(attackAction.animation).toBeDefined();
    expect(attackAction.animation).toMatchObject({
      kind: 'attack',
      attacker,
      attackerWeaponIndex: 0,
      defender: target,
    });
    if (attackAction.animation?.kind === 'attack') {
      expect(attackAction.animation.result.blows.length).toBeGreaterThan(0);
    }
  });

  it('a movement-fallback action carries a real AiAnimationEvent with the full path', () => {
    const board = makeBoard(terrainData);
    const moveType = flatMoveType(terrainData, 0);
    const type = makeUnitType('soldier', 20, moveType, makeWeapon(3, 1));

    const unit = Unit.create(type, 1, Location.fromWml(1, 6), { canRecruit: true }); // far corner, away from the village
    const enemy = Unit.create(type, 2, Location.fromWml(6, 6)); // far away, not reachable this turn
    board.addUnit(unit);
    board.addUnit(enemy);
    unit.attacksLeft = 0; // isolate decideMove's own fallback from the attack-branch's pre-attack repositioning (also animated, but separately -- see the "attack action" test above).

    const rng = new RngDeterministic(new MtRng(5));
    const actions = playAiTurn(board, 1, rng, { resolveType: () => type });

    const moveAction = actions.find((a) => a.kind === 'move' && a.message.length > 0)!;
    expect(moveAction).toBeDefined();
    expect(moveAction.animation).toMatchObject({ kind: 'move', unit });
    if (moveAction.animation?.kind === 'move') {
      expect(moveAction.animation.path.length).toBeGreaterThan(1);
      expect(moveAction.animation.path[moveAction.animation.path.length - 1]).toEqual(unit.location);
    }
  });

  it('a recruit action carries a real AiAnimationEvent with the new unit and its leader', () => {
    const board = makeBoard(terrainData);
    const moveType = flatMoveType(terrainData, 0);
    const cheapType = makeUnitType('cheap', 10, moveType, makeWeapon(2, 1), 10);

    const team = board.getTeam(1)!;
    team.gold = 15;
    team.canRecruit = new Set(['cheap']);
    const leaderType = makeUnitType('leader', 30, moveType, makeWeapon(1, 1), 0);
    const leader = Unit.create(leaderType, 1, Location.fromWml(1, 1), { canRecruit: true });
    board.addUnit(leader);

    const rng = new RngDeterministic(new MtRng(1));
    const actions = playAiTurn(board, 1, rng, { resolveType: (id) => (id === 'cheap' ? cheapType : leaderType) });

    const recruitAction = actions.find((a) => a.kind === 'recruit')!;
    expect(recruitAction.animation).toMatchObject({ kind: 'recruit', leader });
    if (recruitAction.animation?.kind === 'recruit') {
      expect(recruitAction.animation.unit.type.id).toBe('cheap');
    }
  });
});

describe('playAiTurn: plague (real, reported bug: AI attacks never wired resolveType into executeAttack, so a plague kill never spawned a replacement)', () => {
  it('an AI-controlled plague kill spawns a real Walking Corpse on the killer\'s side', () => {
    const board = makeBoard(terrainData);
    const moveType = flatMoveType(terrainData, 100); // always hit -- deterministic.
    const zombieType = makeUnitType('Walking Corpse', 20, moveType, makeWeapon(3, 1));

    const plagueCfg = new WmlConfig();
    plagueCfg.setAttribute('name', 'plague-weapon');
    plagueCfg.setAttribute('type', 'blade');
    plagueCfg.setAttribute('range', 'melee');
    plagueCfg.setAttribute('damage', 10);
    plagueCfg.setAttribute('number', 1);
    const specials = plagueCfg.addChild('specials');
    const plague = new WmlConfig();
    plague.setAttribute('id', 'plague');
    plague.setAttribute('type', 'Walking Corpse');
    specials.addChild('plague', plague);
    const plaguebearerType = makeUnitType('Debug Plaguebearer', 40, moveType, AttackType.fromConfig(plagueCfg));
    const weakType = makeUnitType('weak', 5, moveType, makeWeapon(1, 1));

    const attacker = Unit.create(plaguebearerType, 1, Location.fromWml(3, 3), { canRecruit: true });
    const target = Unit.create(weakType, 2, Location.fromWml(4, 3));
    board.addUnit(attacker);
    board.addUnit(target);

    const rng = new RngDeterministic(new MtRng(3));
    const resolveType = (id: string): UnitType => (id === 'Walking Corpse' ? zombieType : plaguebearerType);
    const actions = playAiTurn(board, 1, rng, { resolveType });

    expect(actions.filter((a) => a.kind === 'attack')).toHaveLength(1);
    const spawned = board.unitAt(Location.fromWml(4, 3));
    expect(spawned).toBeDefined();
    expect(spawned!.type.id).toBe('Walking Corpse');
    expect(spawned!.side).toBe(1);
  });
});

describe('playAiTurn: movement fallback', () => {
  it('captures a reachable unowned village when no attack is available', () => {
    const board = makeBoard(terrainData);
    const moveType = flatMoveType(terrainData, 0);
    const type = makeUnitType('scout', 20, moveType, makeWeapon(3, 1));
    type.moveType; // no-op, just documenting scout has ample movement via its move type below
    const fastMoveType = MoveType.fromConfig(
      (() => {
        const cfg = new WmlConfig();
        const defense = cfg.addChild('defense');
        defense.setAttribute('flat', 0);
        const movementCosts = cfg.addChild('movement_costs');
        movementCosts.setAttribute('flat', 1);
        return cfg;
      })(),
      terrainData,
    );
    const scoutType = new UnitType('scout', 'scout', '', 'neutral', 1, 20, 8, 5, 0, 1, 10, -1, 500, [], '', false, false, false, fastMoveType, [makeWeapon(3, 1)], []);

    const unit = Unit.create(scoutType, 1, Location.fromWml(2, 3), { canRecruit: true }); // adjacent to the village at wml (4,4)
    board.addUnit(unit);

    const rng = new RngDeterministic(new MtRng(5));
    playAiTurn(board, 1, rng, { resolveType: () => scoutType });

    const villageLoc = Location.fromWml(4, 4);
    expect(board.villageOwner(villageLoc)).toBe(1);
    expect(unit.location.equals(villageLoc)).toBe(true);
  });

  it('moves toward the nearest enemy when no attack or village capture is available', () => {
    const board = makeBoard(terrainData);
    const moveType = flatMoveType(terrainData, 0);
    const type = makeUnitType('soldier', 20, moveType, makeWeapon(3, 1));

    const unit = Unit.create(type, 1, Location.fromWml(1, 6), { canRecruit: true }); // far corner, away from the village
    const enemy = Unit.create(type, 2, Location.fromWml(6, 6)); // far away, not reachable this turn
    board.addUnit(unit);
    board.addUnit(enemy);

    const startDist = Location.fromWml(1, 6);
    void startDist;
    const rng = new RngDeterministic(new MtRng(5));
    playAiTurn(board, 1, rng, { resolveType: () => type });

    // Moved closer to the enemy than its starting position (5 moves, flat 1-cost terrain).
    expect(unit.location.equals(Location.fromWml(1, 6))).toBe(false);
    const newDistance = Math.abs(unit.location.wmlX - enemy.location.wmlX) + Math.abs(unit.location.wmlY - enemy.location.wmlY);
    const oldDistance = Math.abs(1 - enemy.location.wmlX) + Math.abs(6 - enemy.location.wmlY);
    expect(newDistance).toBeLessThan(oldDistance);
  });
});

describe('playAiTurn: advancement (real, reported bug -- units never advanced anywhere in this project)', () => {
  it('an AI-controlled kill that grants enough XP advances the attacker immediately, logged as a real "advance" action', () => {
    const board = makeBoard(terrainData);
    const moveType = flatMoveType(terrainData, 100); // always hit -- deterministic.
    const weakType = makeUnitType('weak', 1, moveType, makeWeapon(1, 1));
    // experienceNeededBase=1 -- any real combat XP gain immediately qualifies for advancement.
    const advancedType = new UnitType('advanced', 'advanced', '', 'neutral', 2, 40, 5, 5, 0, 1, 10, -1, 500, [], '', false, false, false, moveType, [makeWeapon(10, 3)], []);
    const strongType = new UnitType('strong', 'strong', '', 'neutral', 1, 40, 5, 5, 0, 1, 10, -1, 1, ['advanced'], '', false, false, false, moveType, [makeWeapon(10, 3)], []);

    const attacker = Unit.create(strongType, 1, Location.fromWml(3, 3), { canRecruit: true });
    const target = Unit.create(weakType, 2, Location.fromWml(4, 3));
    board.addUnit(attacker);
    board.addUnit(target);

    const rng = new RngDeterministic(new MtRng(3));
    const resolveType = (id: string): UnitType => (id === 'advanced' ? advancedType : strongType);
    const actions = playAiTurn(board, 1, rng, { resolveType });

    expect(actions.filter((a) => a.kind === 'attack')).toHaveLength(1);
    const advanceAction = actions.find((a) => a.kind === 'advance');
    expect(advanceAction).toBeDefined();
    expect(advanceAction!.message).toBe('strong advances to advanced!');
    expect(attacker.type.id).toBe('advanced');
    expect(attacker.hitpoints).toBe(attacker.maxHitpoints); // advancing fully heals, matching real get_advanced_unit.
  });
});
