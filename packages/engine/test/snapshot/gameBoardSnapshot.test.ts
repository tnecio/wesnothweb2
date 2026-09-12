import { describe, expect, it } from 'vitest';
import {
  gameBoardFromSnapshot,
  buildFlatMoveType,
  unitKeyFor,
  type GameBoardSnapshot,
} from '../../src/snapshot/gameBoardSnapshot.js';
import { WmlConfig } from '../../src/wml/config.js';
import { Location } from '../../src/model/Location.js';
import { UNREACHABLE } from '../../src/model/MoveType.js';
import { TerrainTypeData, parseTerrainCode } from '../../src/model/Terrain.js';
import { reachableHexes } from '../../src/pathfind/pathfind.js';
import { executeMove } from '../../src/actions/move.js';
import { executeAttack } from '../../src/actions/combat.js';
import { RngDeterministic, MtRng } from '../../src/rng/index.js';

/** A tiny hand-built snapshot: a 3x1 strip of grass, one unit per side, adjacent. */
function tinySnapshot(): GameBoardSnapshot {
  // 5x3 raw map text incl. a 1-hex border on every side (matches GameMap.DEFAULT_BORDER),
  // so the *playable* area is a 3x1 strip: (0,0), (1,0), (2,0) in engine 0-based coords.
  const mapData = ['Gg, Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg, Gg'].join('\n');

  return {
    scenario: { id: 'unit_test', name: 'Unit Test Scenario' },
    map: { width: 3, height: 1, border: 1, data: mapData },
    terrain: [
      { x: 0, y: 0, code: 'Gg' },
      { x: 1, y: 0, code: 'Gg' },
      { x: 2, y: 0, code: 'Gg' },
    ],
    teams: [
      { side: 1, controller: 'human', gold: 100, teamName: '1', color: '1' },
      { side: 2, controller: 'ai', teamName: '2', gold: 100, color: '2' },
    ],
    units: [
      {
        id: 'attacker',
        name: 'Attacker',
        typeId: 'Stub Fighter',
        image: null,
        side: 1,
        x: 0,
        y: 0,
        canRecruit: false,
        hitpoints: 30,
        maxHitpoints: 30,
      },
      {
        id: 'defender',
        name: 'Defender',
        typeId: 'Stub Fighter',
        image: null,
        side: 2,
        x: 1,
        y: 0,
        canRecruit: false,
        hitpoints: 30,
        maxHitpoints: 30,
      },
    ],
    unitTypes: {
      'Stub Fighter': {
        id: 'Stub Fighter',
        name: 'Stub Fighter',
        raceId: '',
        alignment: 'neutral',
        level: 1,
        hitpoints: 30,
        movement: 5,
        vision: 5,
        jamming: 0,
        maxAttacksPerTurn: 1,
        cost: 0,
        recallCost: -1,
        experienceNeededBase: 500,
        advancesTo: [],
        undeadVariation: '',
        zoc: true,
        hideHelp: false,
        doNotList: false,
        attacks: [
          {
            id: 'attack',
            name: 'Attack',
            type: 'blade',
            range: 'melee',
            minRange: 1,
            maxRange: 1,
            damage: 6,
            numAttacks: 3,
            attackWeight: 1,
            defenseWeight: 1,
            accuracy: 0,
            parry: 0,
          },
        ],
      },
    },
    scenarioConfigJson: new WmlConfig().toJSON(),
  };
}

describe('buildFlatMoveType', () => {
  it('resolves a flat cost for every terrain code, both with real and empty TerrainTypeData', () => {
    const empty = TerrainTypeData.fromConfigs([]);
    const codes = [parseTerrainCode('Gg'), parseTerrainCode('Ww'), parseTerrainCode('Hd^Fds')];
    const moveType = buildFlatMoveType(codes, empty, { movementCost: 1 });
    for (const code of codes) {
      expect(moveType.movementCost(code)).toBe(1);
    }
    // A terrain code never registered in the table still falls back to UNREACHABLE --
    // this is a flat-cost-for-known-terrain simplification, not "every terrain is free".
    expect(moveType.movementCost(parseTerrainCode('Xu'))).toBe(UNREACHABLE);
  });

  it('gives a non-degenerate (not UNREACHABLE) flat defense value too', () => {
    const empty = TerrainTypeData.fromConfigs([]);
    const code = parseTerrainCode('Gg');
    const moveType = buildFlatMoveType([code], empty);
    const defense = moveType.defenseModifier(code);
    expect(defense).toBeGreaterThan(0);
    expect(defense).toBeLessThan(UNREACHABLE);
  });
});

describe('gameBoardFromSnapshot', () => {
  it('rebuilds a live GameBoard whose units can path/move (movement is NOT stuck at UNREACHABLE)', () => {
    const { board, unitsByKey } = gameBoardFromSnapshot(tinySnapshot());

    const attacker = unitsByKey.get(unitKeyFor({ id: 'attacker', x: 0, y: 0 }));
    expect(attacker).toBeDefined();
    expect(attacker!.location.equals(new Location(0, 0))).toBe(true);
    expect(attacker!.movesLeft).toBe(5);

    // Regression check for the documented "empty movement_costs -> UNREACHABLE" bug:
    // an empty hex 2 steps away (through the map's own registered terrain) must be
    // reachable, not stuck because movementCost() returns UNREACHABLE for everything.
    const { destinations } = reachableHexes(board, attacker!, { seeAll: true });
    expect(destinations.contains(new Location(0, 0))).toBe(true);

    const result = executeMove(board, attacker!, [new Location(0, 0)], { seeAll: true });
    expect(result.stoppedEarly).toBe(false);
  });

  it('real, reported bug: a scenario-authored [unit] experience= override was silently dropped -- now applied the same way hitpoints already was', () => {
    const snapshot = tinySnapshot();
    snapshot.units[0]!.experience = 34;
    snapshot.units[0]!.maxExperience = 35;
    const { unitsByKey } = gameBoardFromSnapshot(snapshot);

    const attacker = unitsByKey.get(unitKeyFor({ id: 'attacker', x: 0, y: 0 }))!;
    expect(attacker.experience).toBe(34);
    expect(attacker.maxExperience).toBe(35);
  });

  it('omitting experience/maxExperience (older/static snapshots) falls back to the real type default, same as before this fix', () => {
    const { unitsByKey } = gameBoardFromSnapshot(tinySnapshot());
    const attacker = unitsByKey.get(unitKeyFor({ id: 'attacker', x: 0, y: 0 }))!;
    expect(attacker.experience).toBe(0);
    expect(attacker.maxExperience).toBeGreaterThan(0);
  });

  it('rebuilds real per-type combat stats so executeAttack deals real (non-zero) damage', () => {
    const { board, unitsByKey } = gameBoardFromSnapshot(tinySnapshot());
    const attacker = unitsByKey.get(unitKeyFor({ id: 'attacker', x: 0, y: 0 }))!;
    const defender = unitsByKey.get(unitKeyFor({ id: 'defender', x: 1, y: 0 }))!;

    expect(attacker.attacks[0]!.damage).toBeGreaterThan(0);
    expect(attacker.attacks[0]!.numAttacks).toBeGreaterThan(0);

    const rng = new RngDeterministic(new MtRng(12345));
    const result = executeAttack(board, rng, attacker.location, 0, defender.location);

    // At least one real (possibly 0-damage-if-missed, but structurally real) blow happened.
    expect(result.blows.length).toBeGreaterThan(0);
    // With a deterministic seed and >0 chance to hit, some damage should have been dealt
    // across the whole exchange (both sides get several blows at 3 attacks each).
    const totalDamage = result.blows.reduce((sum, b) => sum + b.damage, 0);
    expect(totalDamage).toBeGreaterThan(0);
  });

  it('gives every unit its own live Unit instance located per the snapshot', () => {
    const { board } = gameBoardFromSnapshot(tinySnapshot());
    expect(board.allUnits()).toHaveLength(2);
    expect(board.unitAt(new Location(0, 0))?.side).toBe(1);
    expect(board.unitAt(new Location(1, 0))?.side).toBe(2);
  });

  it('threads a team\'s real income=/village_gold= through, not silently defaulting to 0/1 regardless of the snapshot', () => {
    // Regression test: SnapshotTeam.income/incomePerVillage didn't exist at
    // all until a synthetic debug campaign's non-zero income= exposed that
    // gold-carryover's finishing bonus was silently computed as income=0
    // for every scenario (invisible against Dead Water, whose real side 1
    // also happens to declare income=0) -- see docs/PROGRESS.md and
    // carryover.ts's own doc comment.
    const snapshot = tinySnapshot();
    snapshot.teams[0]!.income = 3;
    snapshot.teams[0]!.incomePerVillage = 2;
    const { board } = gameBoardFromSnapshot(snapshot);
    expect(board.getTeam(1)!.income).toBe(3);
    expect(board.getTeam(1)!.incomePerVillage).toBe(2);

    // And the real WML defaults (0/1) still apply when a snapshot doesn't carry these at all.
    const { board: boardWithoutIncome } = gameBoardFromSnapshot(tinySnapshot());
    expect(boardWithoutIncome.getTeam(1)!.income).toBe(0);
    expect(boardWithoutIncome.getTeam(1)!.incomePerVillage).toBe(1);
  });
});
