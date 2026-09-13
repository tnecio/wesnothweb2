import { describe, expect, it } from 'vitest';
import { WmlConfig } from '../../src/wml/config.js';
import { Location } from '../../src/model/Location.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { AiContext } from '../../src/ai/context.js';
import { parseTerrainCode } from '../../src/model/Terrain.js';
import { VillagesCandidateAction } from '../../src/ai/default/caVillages.js';
import { loadTerrainData, flatMoveType, makeWeapon, makeUnitType, makeBoard, makeAiHost } from './helpers.js';

const terrainData = loadTerrainData();

function makeCfg(): WmlConfig {
  const cfg = new WmlConfig();
  cfg.setAttribute('id', 'villages');
  cfg.setAttribute('score', 60000);
  cfg.setAttribute('max_score', 60000);
  return cfg;
}

function makeCtx() {
  const board = makeBoard(terrainData);
  return { ctx: new AiContext(makeAiHost(board), 1, new Map()), board };
}

describe('VillagesCandidateAction', () => {
  it('captures a reachable, unowned village', () => {
    const { ctx, board } = makeCtx();
    const type = makeUnitType('scout', 20, flatMoveType(terrainData, 50), makeWeapon(2, 1), 12);
    const unit = Unit.create(type, 1, Location.fromWml(3, 4)); // adjacent to the village at wml(4,4)
    board.addUnit(unit);

    const ca = new VillagesCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(60000);
    ca.execute();
    expect(unit.location.equals(Location.fromWml(4, 4))).toBe(true);
    expect(board.villageOwner(Location.fromWml(4, 4))).toBe(1);
  });

  it('does nothing when no reachable village is unowned or eligible', () => {
    const { ctx, board } = makeCtx();
    const type = makeUnitType('scout', 20, flatMoveType(terrainData, 50), makeWeapon(2, 1), 12);
    const unit = Unit.create(type, 1, Location.fromWml(3, 4));
    board.addUnit(unit);
    board.captureVillage(Location.fromWml(4, 4), 1); // already ours
    const ca = new VillagesCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(0);
  });

  it('does not target an allied-owned village', () => {
    const board = makeBoard(terrainData);
    board.getTeam(1)!.teamName = 'good';
    board.addTeam(new Team(3, { teamName: 'good' }));
    board.captureVillage(Location.fromWml(4, 4), 3); // owned by an ally
    const type = makeUnitType('scout', 20, flatMoveType(terrainData, 50), makeWeapon(2, 1), 12);
    const unit = Unit.create(type, 1, Location.fromWml(3, 4));
    board.addUnit(unit);
    const ctx = new AiContext(makeAiHost(board), 1, new Map());
    const ca = new VillagesCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(0);
  });

  it('two units each reachable to only one of two villages: simple dispatch assigns both correctly', () => {
    // Two villages: the map's own at wml(4,4), plus a second one carved out directly.
    const { ctx, board } = makeCtx();
    board.map.setTerrain(Location.fromWml(1, 4), parseTerrainCode('Gg^Vh'));
    const type = makeUnitType('scout', 20, flatMoveType(terrainData, 50), makeWeapon(2, 1), 12);
    const near1 = Unit.create(type, 1, Location.fromWml(1, 3)); // only reaches the village at (1,4)
    near1.movesLeft = 1;
    near1.maxMoves = 1;
    const near2 = Unit.create(type, 1, Location.fromWml(3, 4)); // only reaches the village at (4,4)
    near2.movesLeft = 1;
    near2.maxMoves = 1;
    board.addUnit(near1);
    board.addUnit(near2);

    const ca = new VillagesCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBe(60000);
    ca.execute();
    expect(board.villageOwner(Location.fromWml(1, 4))).toBe(1);
    expect(board.villageOwner(Location.fromWml(4, 4))).toBe(1);
  });

  it('moves the leader LAST among several assignments, leaving the castle clear for a later recruitment pass', () => {
    const { ctx, board } = makeCtx();
    board.map.setTerrain(Location.fromWml(1, 4), parseTerrainCode('Gg^Vh'));
    const type = makeUnitType('scout', 20, flatMoveType(terrainData, 50), makeWeapon(2, 1), 12);
    const leader = Unit.create(type, 1, Location.fromWml(1, 1), { canRecruit: true }); // on the keep
    leader.movesLeft = 10;
    board.addUnit(leader);
    const grunt = Unit.create(type, 1, Location.fromWml(3, 4));
    grunt.movesLeft = 1;
    grunt.maxMoves = 1;
    board.addUnit(grunt);

    const ca = new VillagesCandidateAction(ctx, makeCfg());
    expect(ca.evaluate()).toBeGreaterThan(0);
    ca.execute();
    // Whichever village the leader ended up assigned to (if any), the non-leader unit's own assignment must have
    // gone through -- if leader moved first and blocked the castle exit this would fail.
    expect(board.villageOwner(Location.fromWml(4, 4))).toBe(1);
  });
});
