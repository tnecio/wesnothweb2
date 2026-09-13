import { describe, expect, it } from 'vitest';
import { parseWml } from '../../src/wml/index.js';
import { WmlConfig } from '../../src/wml/config.js';
import { Location } from '../../src/model/Location.js';
import { Unit } from '../../src/model/Unit.js';
import { AiManager } from '../../src/ai/manager.js';
import { loadTerrainData, flatMoveType, makeWeapon, makeUnitType, makeBoard, makeAiHost } from './helpers.js';

const terrainData = loadTerrainData();

describe('AiManager', () => {
  it('playTurn moves a leader towards its keep and returns a real action log', () => {
    const board = makeBoard(terrainData);
    const type = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1), 0);
    const leader = Unit.create(type, 1, Location.fromWml(2, 1), { canRecruit: true }); // on the castle, off the keep
    board.addUnit(leader);

    const host = makeAiHost(board);
    const manager = new AiManager(host, () => []);
    const actions = manager.playTurn(1);

    expect(leader.location.equals(Location.fromWml(1, 1))).toBe(true);
    expect(actions.some((a) => a.kind === 'move')).toBe(true);
  });

  it('idle_ai does nothing and returns an empty log', () => {
    const board = makeBoard(terrainData);
    const type = makeUnitType('grunt', 20, flatMoveType(terrainData, 50), makeWeapon(3, 1));
    const unit = Unit.create(type, 1, Location.fromWml(3, 3));
    board.addUnit(unit);
    const originalLocation = unit.location;

    const host = makeAiHost(board);
    const sideBlock = parseWml('[ai]\nai_algorithm=idle_ai\n[/ai]').child('ai')!;
    const manager = new AiManager(host, (side) => (side === 1 ? [sideBlock] : []));
    const actions = manager.playTurn(1);

    expect(unit.location.equals(originalLocation)).toBe(true);
    expect(actions).toHaveLength(0);
  });

  it('appendSideAi ([modify_side][ai]) rebuilds the composite with the new block applied', () => {
    const board = makeBoard(terrainData);
    const type = makeUnitType('grunt', 20, flatMoveType(terrainData, 50), makeWeapon(3, 1));
    board.addUnit(Unit.create(type, 1, Location.fromWml(3, 3)));
    const host = makeAiHost(board);
    const manager = new AiManager(host, () => []);

    // Before: a normal side plays normally (produces some log activity via villages/goto/etc., or at least doesn't
    // throw). After appending idle_ai, the side must do nothing at all.
    manager.appendSideAi(1, parseWml('[ai]\nai_algorithm=idle_ai\n[/ai]').child('ai')!);
    const actions = manager.playTurn(1);
    expect(actions).toHaveLength(0);
  });

  it('modifyAi deletes a candidate action from a running stage (stage[id].candidate_action[id])', () => {
    const board = makeBoard(terrainData);
    const soldierType = makeUnitType('soldier', 20, flatMoveType(terrainData, 50), makeWeapon(5, 2), 10);
    board.addUnit(Unit.create(soldierType, 1, Location.fromWml(3, 3)));
    board.addUnit(Unit.create(soldierType, 2, Location.fromWml(4, 3)));
    const leaderType = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1), 0);
    board.addUnit(Unit.create(leaderType, 1, Location.fromWml(1, 1), { canRecruit: true }));

    const host = makeAiHost(board);
    const manager = new AiManager(host, () => []);
    manager.modifyAi(1, 'delete', 'stage[main_loop].candidate_action[combat]');
    const actions = manager.playTurn(1);

    expect(actions.some((a) => a.kind === 'attack')).toBe(false); // combat CA was deleted, so no attack happens
  });

  it('modifyAi adds and deletes a [goal] by id', () => {
    const board = makeBoard(terrainData);
    const type = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1), 0);
    board.addUnit(Unit.create(type, 1, Location.fromWml(1, 1), { canRecruit: true }));
    const host = makeAiHost(board);
    const manager = new AiManager(host, () => []);

    const goalCfg = new WmlConfig();
    goalCfg.setAttribute('id', 'my_goal');
    goalCfg.setAttribute('name', 'target_location');
    goalCfg.setAttribute('value', 50);
    const criteria = goalCfg.addChild('criteria');
    criteria.setAttribute('x', 5);
    criteria.setAttribute('y', 5);

    expect(manager.modifyAi(1, 'add', 'goal[]', goalCfg)).toBe(true);
    expect(manager.modifyAi(1, 'delete', 'goal[my_goal]')).toBe(true);
  });
});
