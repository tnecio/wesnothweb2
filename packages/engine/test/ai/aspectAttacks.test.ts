import { describe, expect, it } from 'vitest';
import { WmlConfig } from '../../src/wml/config.js';
import { Location } from '../../src/model/Location.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { AiContext } from '../../src/ai/context.js';
import { analyzeTargets } from '../../src/ai/default/aspectAttacks.js';
import { loadTerrainData, flatMoveType, makeWeapon, makeUnitType, makeBoard, makeAiHost } from './helpers.js';

const terrainData = loadTerrainData();

function makeCtx() {
  const board = makeBoard(terrainData);
  return { ctx: new AiContext(makeAiHost(board), 1, new Map()), board };
}

describe('analyzeTargets (aspect_attacks)', () => {
  it('finds a one-attacker combo against a single adjacent visible enemy', () => {
    const { ctx, board } = makeCtx();
    const type = makeUnitType('soldier', 20, flatMoveType(terrainData, 50), makeWeapon(5, 2), 10);
    board.addUnit(Unit.create(type, 1, Location.fromWml(3, 3)));
    board.addUnit(Unit.create(type, 2, Location.fromWml(4, 3)));

    const analyses = analyzeTargets(ctx);
    expect(analyses.some((a) => a.target.equals(Location.fromWml(4, 3)) && a.movements.length === 1)).toBe(true);
  });

  it('finds no combos when there is no enemy at all', () => {
    const { ctx, board } = makeCtx();
    const type = makeUnitType('soldier', 20, flatMoveType(terrainData, 50), makeWeapon(5, 2), 10);
    board.addUnit(Unit.create(type, 1, Location.fromWml(3, 3)));
    expect(analyzeTargets(ctx)).toHaveLength(0);
  });

  it('[filter_own] excludes a non-matching own unit from ever attacking', () => {
    const { ctx, board } = makeCtx();
    const type = makeUnitType('soldier', 20, flatMoveType(terrainData, 50), makeWeapon(5, 2), 10);
    const excluded = Unit.create(type, 1, Location.fromWml(3, 3), { id: 'exclude-me' });
    board.addUnit(excluded);
    board.addUnit(Unit.create(type, 2, Location.fromWml(4, 3)));

    const filterOwn = new WmlConfig();
    filterOwn.setAttribute('id', 'someone-else');
    const analyses = analyzeTargets(ctx, { filterOwn });
    expect(analyses.every((a) => !a.movements.some((m) => m.from.equals(Location.fromWml(3, 3))))).toBe(true);
  });

  it('[filter_enemy] excludes a non-matching enemy from ever being targeted', () => {
    const { ctx, board } = makeCtx();
    const type = makeUnitType('soldier', 20, flatMoveType(terrainData, 50), makeWeapon(5, 2), 10);
    board.addUnit(Unit.create(type, 1, Location.fromWml(3, 3)));
    board.addUnit(Unit.create(type, 2, Location.fromWml(4, 3), { id: 'protected' }));

    const filterEnemy = new WmlConfig();
    filterEnemy.setAttribute('id', 'someone-else');
    const analyses = analyzeTargets(ctx, { filterEnemy });
    expect(analyses).toHaveLength(0);
  });

  it('an allied unit is never treated as an attack target', () => {
    const board = makeBoard(terrainData);
    board.getTeam(1)!.teamName = 'good';
    board.addTeam(new Team(3, { teamName: 'good' }));
    const ctx = new AiContext(makeAiHost(board), 1, new Map());
    const type = makeUnitType('soldier', 20, flatMoveType(terrainData, 50), makeWeapon(5, 2), 10);
    board.addUnit(Unit.create(type, 1, Location.fromWml(3, 3)));
    board.addUnit(Unit.create(type, 3, Location.fromWml(4, 3))); // allied, not an enemy

    expect(analyzeTargets(ctx)).toHaveLength(0);
  });
});
