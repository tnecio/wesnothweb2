import { describe, expect, it } from 'vitest';
import { WmlConfig } from '../../src/wml/config.js';
import { Location, distanceBetween } from '../../src/model/Location.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { parseTerrainCode } from '../../src/model/Terrain.js';
import { AiContext } from '../../src/ai/context.js';
import { findTargets } from '../../src/ai/default/findTargets.js';
import { TargetUnitGoal, type Goal } from '../../src/ai/composite/goal.js';
import { loadTerrainData, flatMoveType, makeWeapon, makeUnitType, makeBoard, makeAiHost } from './helpers.js';

const terrainData = loadTerrainData();

function makeCtx(goals: readonly Goal[] = []) {
  const board = makeBoard(terrainData);
  const ctx = new AiContext(makeAiHost(board), 1, new Map(), goals);
  return { ctx, board };
}

describe('findTargets', () => {
  it('finds the unowned village on the synthetic board', () => {
    const { ctx, board } = makeCtx();
    const type = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1));
    board.addUnit(Unit.create(type, 1, Location.fromWml(1, 1), { canRecruit: true }));

    const targets = findTargets(ctx, ctx.getEnemyDstSrc());
    expect(targets.some((t) => t.loc.equals(Location.fromWml(4, 4)) && t.type === 'village')).toBe(true);
  });

  it('finds a visible enemy leader as a leader-type target', () => {
    const { ctx, board } = makeCtx();
    const type = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1));
    board.addUnit(Unit.create(type, 1, Location.fromWml(1, 1), { canRecruit: true }));
    board.addUnit(Unit.create(type, 2, Location.fromWml(5, 5), { canRecruit: true }));

    const targets = findTargets(ctx, ctx.getEnemyDstSrc());
    expect(targets.some((t) => t.loc.equals(Location.fromWml(5, 5)) && t.type === 'leader')).toBe(true);
  });

  it('finds an explicit [goal] target-unit match', () => {
    const board = makeBoard(terrainData);
    const type = makeUnitType('soldier', 20, flatMoveType(terrainData, 50), makeWeapon(3, 1));
    const marked = Unit.create(type, 2, Location.fromWml(5, 5), { id: 'marked' });
    board.addUnit(marked);
    board.addUnit(Unit.create(type, 1, Location.fromWml(1, 1), { canRecruit: true }));

    const criteria = new WmlConfig();
    criteria.setAttribute('id', 'marked');
    const goalCfg = new WmlConfig();
    goalCfg.setAttribute('value', 500);
    goalCfg.addChild('criteria', criteria);
    const goal = new TargetUnitGoal(goalCfg);

    const ctx = new AiContext(makeAiHost(board), 1, new Map(), [goal]);
    const targets = findTargets(ctx, ctx.getEnemyDstSrc());
    expect(targets.some((t) => t.loc.equals(Location.fromWml(5, 5)) && t.type === 'xplicit')).toBe(true);
  });

  it('nearby targets boost each other (clustering): two adjacent villages rate higher than the un-boosted formula alone', () => {
    const board = makeBoard(terrainData);
    const leaderLoc = Location.fromWml(1, 1);
    board.map.setTerrain(Location.fromWml(4, 3), parseTerrainCode('Gg^Vh')); // a second village, adjacent to the map's own at (4,4)
    const type = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1));
    board.addUnit(Unit.create(type, 1, leaderLoc, { canRecruit: true }));
    const ctx = new AiContext(makeAiHost(board), 1, new Map());

    const targets = findTargets(ctx, ctx.getEnemyDstSrc());
    const v1 = targets.find((t) => t.loc.equals(Location.fromWml(4, 4)) && t.type === 'village');
    expect(v1).toBeDefined();

    // Mirrors the un-boosted formula (attack_analysis.cpp's own village-value formula, ported in findTargets.ts) to
    // get the RAW (pre-clustering) value for this specific village, then asserts the real (boosted) value exceeds
    // it -- the two adjacent villages must be pulling each other's rating up.
    const villageValue = ctx.getVillageValue();
    const cornerDistance = distanceBetween(new Location(0, 0), new Location(board.map.w(), board.map.h()));
    const leaderDistance = distanceBetween(Location.fromWml(4, 4), leaderLoc);
    const rawValue = villageValue * (1.0 - leaderDistance / cornerDistance);
    expect(v1!.value).toBeGreaterThan(rawValue);
  });

  it('does not target an allied village unless support_villages is on', () => {
    const board = makeBoard(terrainData);
    board.getTeam(1)!.teamName = 'good';
    board.addTeam(new Team(3, { teamName: 'good' }));
    board.captureVillage(Location.fromWml(4, 4), 3);
    const type = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1));
    board.addUnit(Unit.create(type, 1, Location.fromWml(1, 1), { canRecruit: true }));
    const ctx = new AiContext(makeAiHost(board), 1, new Map());

    const targets = findTargets(ctx, ctx.getEnemyDstSrc());
    expect(targets.some((t) => t.loc.equals(Location.fromWml(4, 4)))).toBe(false);
  });
});
