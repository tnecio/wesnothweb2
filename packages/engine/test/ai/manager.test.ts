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

  it('switchSideAi ([modify_side][ai] ai_algorithm=) rebuilds the AI from the new block alone', () => {
    const board = makeBoard(terrainData);
    const type = makeUnitType('grunt', 20, flatMoveType(terrainData, 50), makeWeapon(3, 1));
    board.addUnit(Unit.create(type, 1, Location.fromWml(3, 3)));
    const host = makeAiHost(board);
    const manager = new AiManager(host, () => []);

    // Before: a normal side plays normally (produces some log activity via villages/goto/etc., or at least doesn't
    // throw). After appending idle_ai, the side must do nothing at all.
    manager.switchSideAi(1, [parseWml('[ai]\nai_algorithm=idle_ai\n[/ai]').child('ai')!]);
    const actions = manager.playTurn(1);
    expect(actions).toHaveLength(0);
  });

  it('appendSideAi ([modify_side][ai]) appends to the live AI: earlier changes stay, the new facet applies', () => {
    const board = makeBoard(terrainData);
    const type = makeUnitType('grunt', 20, flatMoveType(terrainData, 50), makeWeapon(3, 1));
    board.addUnit(Unit.create(type, 1, Location.fromWml(3, 3)));
    const manager = new AiManager(makeAiHost(board), () => []);
    manager.modifyAi(1, 'delete', 'stage[main_loop].candidate_action[combat]');
    manager.appendSideAi(1, parseWml('[ai]\naggression=0.9\n[/ai]').child('ai')!);
    const cfg = manager.toConfig(1);
    const cas = cfg.children('stage').flatMap((st) => st.children('candidate_action')).map((ca) => ca.getString('id'));
    expect(cas).not.toContain('combat');
    const aggression = cfg.children('aspect').find((a) => a.getString('id') === 'aggression')!;
    expect(aggression.children('facet').some((f) => f.getString('value') === '0.9' || f.getNumber('value') === 0.9)).toBe(true);
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

describe('AiManager.playTurnSteps (Phase 29a)', () => {
  it('adds up, step by step, to what playTurn does, with the board at each step as the step left it', () => {
    const setUp = () => {
      const board = makeBoard(terrainData);
      const leaderType = makeUnitType('leader', 30, flatMoveType(terrainData, 50), makeWeapon(3, 1), 0);
      const gruntType = makeUnitType('grunt', 20, flatMoveType(terrainData, 50), makeWeapon(3, 1));
      board.addUnit(Unit.create(leaderType, 1, Location.fromWml(2, 1), { canRecruit: true }));
      board.addUnit(Unit.create(gruntType, 1, Location.fromWml(4, 4)));
      // In reach of the grunt: the leader goes to its keep, then the grunt attacks -- two steps.
      board.addUnit(Unit.create(gruntType, 2, Location.fromWml(5, 4)));
      return { board, manager: new AiManager(makeAiHost(board), () => []) };
    };

    const whole = setUp();
    const all = whole.manager.playTurn(1);

    const stepped = setUp();
    const steps: string[][] = [];
    for (const step of stepped.manager.playTurnSteps(1)) {
      expect(step.length).toBeGreaterThan(0);
      // The last move of the step has already happened on the board.
      const move = [...step].reverse().find((a) => a.animation?.kind === 'move');
      if (move?.animation?.kind === 'move') {
        const to = move.animation.path[move.animation.path.length - 1]!;
        expect(stepped.board.allUnits().some((u) => u.location.equals(to))).toBe(true);
      }
      steps.push(step.map((a) => a.message ?? a.kind));
    }

    expect(steps.length).toBeGreaterThan(1);
    expect(steps.flat()).toEqual(all.map((a) => a.message ?? a.kind));
    const at = (b: typeof whole.board) => b.allUnits().map((u) => `${u.side}@${u.location.x},${u.location.y}`).sort();
    expect(at(stepped.board)).toEqual(at(whole.board));
  });
});
