import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWml, type DefineMap, preloadDefinesFromDir, parseWmlFile } from '../src/wml/index.js';
import { WmlConfig } from '../src/wml/config.js';
import { Location } from '../src/model/Location.js';
import { TerrainTypeData } from '../src/model/Terrain.js';
import { GameBoard } from '../src/model/GameBoard.js';
import { Unit } from '../src/model/Unit.js';
import { UnitType, AttackType } from '../src/model/UnitType.js';
import { MoveType } from '../src/model/MoveType.js';
import { findPath, NO_PATH_VALUE } from '../src/pathfind/pathfind.js';
import { executeMove } from '../src/actions/move.js';
import { executeAttack } from '../src/actions/combat.js';
import { RngDeterministic } from '../src/rng/RngDeterministic.js';
import { MtRng } from '../src/rng/MtRng.js';

/**
 * Phase 2's stated exit milestone (docs/IMPLEMENTATION_PLAN.md): "a hand-
 * written minimal scenario (no [lua]) plays start to finish headlessly via
 * scripted commands ... snapshotted as a golden-scenario regression test."
 *
 * "Via scripted commands" means direct calls into packages/engine/src/
 * actions/ (as a player or AI driving the game would), not routing through
 * the WML event pump's [attack]/[move_unit] action tags -- those exist for
 * *scenario-scripted* events (cutscenes, triggers), a different concern
 * from a player's own turn actions, and packages/engine/src/events/
 * deliberately left them as extension-point placeholders for exactly this
 * reason (see its own module doc comment).
 *
 * The milestone's other half -- checking combat against a real
 * `wl-combat-oracle` (a native C++ tool dumping attack_prediction.cpp's/
 * attack.cpp's real output, mirroring Phase 0's wl-image-oracle) -- is NOT
 * done here. Building that oracle is a substantial side effort (compiling
 * and linking against real engine sources, similar in scope to the image
 * oracle), and combat.ts/attackPrediction.ts/MoveType.ts were already
 * checked directly against the real C++ source for this project's two
 * confirmed bugs (see docs/PROGRESS.md and the commit that fixed them) --
 * real verification happened, just not via an automated diff tool. Flagging
 * the oracle as a genuine follow-up, not silently skipping it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');

function loadTerrainData(): TerrainTypeData {
  const defines: DefineMap = new Map();
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  const cfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), { dataRoot, defines });
  return TerrainTypeData.fromConfigs(cfg.children('terrain_type'));
}

/**
 * A move type that can actually cross the test scenario's all-grassland
 * ("Gg") map. Grassland's real [terrain_type] (data/core/terrain.cfg)
 * declares `aliasof=Gt`, whose own real id is "flat" -- movement-cost
 * resolution follows that alias chain rather than matching "Gg"/
 * "grassland" directly (confirmed by debugging: TerrainTypeData.
 * getTerrainInfo(...).mvtType resolves to the "flat" terrain type), so an
 * empty [movement_costs] table (this test's first attempt) makes every
 * hex UNREACHABLE and findPath silently returns no route -- the exact
 * same class of "table keyed by the wrong id" trap as combat.test.ts's
 * defense-table setup hit earlier.
 */
function landMoveType(terrainData: TerrainTypeData): MoveType {
  const cfg = new WmlConfig();
  const costs = cfg.addChild('movement_costs');
  costs.setAttribute('flat', 1);
  return MoveType.fromConfig(cfg, terrainData);
}

function makeUnitType(id: string, hitpoints: number, moveType: MoveType, damage: number, numAttacks: number, movement = 5): UnitType {
  const weaponCfg = new WmlConfig();
  weaponCfg.setAttribute('name', 'weapon');
  weaponCfg.setAttribute('type', 'blade');
  weaponCfg.setAttribute('range', 'melee');
  weaponCfg.setAttribute('damage', damage);
  weaponCfg.setAttribute('number', numAttacks);
  const weapon = AttackType.fromConfig(weaponCfg);
  return new UnitType(id, id, '', 'neutral', 1, hitpoints, movement, movement, 0, 1, 10, -1, 32, [], '', false, false, false, moveType, [weapon], []);
}

// A hand-written minimal scenario: no [lua], no macros, just a tiny map
// and two sides -- exactly what the milestone asks for. Written as real
// WML text (through the real tokenizer/preprocessor/parser), not
// constructed by hand as WmlConfig objects, so this test also exercises
// the WML pipeline end-to-end one more time on genuinely new content.
const MINIMAL_SCENARIO_WML = `
[scenario]
    id=golden_test_scenario
    name="Golden Test Scenario"
    map_data="Gg, Gg, Gg, Gg, Gg, Gg, Gg
Gg, Gg, Gg, Gg, Gg, Gg, Gg
Gg, Gg, Gg, Gg, Gg, Gg, Gg
Gg, Gg, Gg, Gg, Gg, Gg, Gg
Gg, Gg, Gg, Gg, Gg, Gg, Gg"

    [side]
        side=1
        controller=human
        team_name=good
        gold=100
    [/side]

    [side]
        side=2
        controller=ai
        team_name=evil
        gold=100
    [/side]
[/scenario]
`;

describe('Golden scenario: a hand-written minimal scenario played headlessly via scripted commands', () => {
  it('parses, loads, and plays deterministically: move -> attack -> kill, snapshotted', () => {
    const terrainData = loadTerrainData();
    const moveType = landMoveType(terrainData);

    const cfg = parseWml(MINIMAL_SCENARIO_WML);
    const scenario = cfg.child('scenario')!;
    expect(scenario.getString('id')).toBe('golden_test_scenario');

    const resolveType = (id: string) => attackerType.id === id ? attackerType : defenderType;
    const attackerType = makeUnitType('attacker-type', 32, moveType, 8, 3);
    const defenderType = makeUnitType('defender-type', 20, moveType, 4, 1);

    const board = GameBoard.fromConfig(scenario, terrainData, resolveType);
    expect(board.map.w()).toBe(5);
    expect(board.map.h()).toBe(3);
    expect(board.teams()).toHaveLength(2);

    // Place the two combatants by hand (the scenario has no [unit] tags --
    // "hand-written minimal" means minimal WML, the units for this script
    // are the "scripted commands" driving the turn).
    const attackerUnit = Unit.create(attackerType, 1, Location.fromWml(1, 1));
    const defenderUnit = Unit.create(defenderType, 2, Location.fromWml(3, 1));
    board.addUnit(attackerUnit);
    board.addUnit(defenderUnit);

    const rng = new RngDeterministic(new MtRng(20260907));

    // Turn 1, side 1: move the attacker adjacent to the defender.
    const dest = Location.fromWml(2, 1);
    const route = findPath(board, attackerUnit, dest, { ignoreUnit: true });
    expect(route.moveCost).toBeLessThan(NO_PATH_VALUE);
    const moveResult = executeMove(board, attackerUnit, route.steps);
    expect(moveResult.stoppedEarly).toBe(false);
    expect(attackerUnit.location.equals(dest)).toBe(true);

    // Turn 1, side 1: attack. Deterministic given the fixed seed above --
    // this whole test is the golden snapshot: if attackPrediction.ts,
    // combat.ts, MoveType.ts's resistance table, or the RNG port ever
    // silently regress, this result changes.
    const attackResult = executeAttack(board, rng, attackerUnit.location, 0, defenderUnit.location);

    const snapshot = {
      attackerHp: attackerUnit.hitpoints,
      defenderAlive: board.unitAt(defenderUnit.location) !== undefined,
      defenderDied: attackResult.defenderDied,
      blows: attackResult.blows.map((b) => ({ attackerTurn: b.attackerTurn, hit: b.hit, damage: b.damage })),
      attackerXp: attackerUnit.experience,
    };

    expect(snapshot).toMatchSnapshot();

    // Sanity bounds independent of the exact RNG sequence (must hold for
    // ANY seed, so these catch gross regressions even if the snapshot
    // above is deliberately updated later for a legitimate reason).
    expect(attackerUnit.hitpoints).toBeGreaterThanOrEqual(0);
    expect(attackerUnit.hitpoints).toBeLessThanOrEqual(attackerType.hitpoints);
    for (const blow of attackResult.blows) {
      expect(blow.damage).toBeGreaterThanOrEqual(0);
      if (!blow.hit) expect(blow.damage).toBe(0);
    }
  });

  it('is bit-for-bit reproducible: replaying the identical script with the identical seed gives the identical outcome', () => {
    function play(seed: number) {
      const terrainData = loadTerrainData();
      const moveType = landMoveType(terrainData);
      const cfg = parseWml(MINIMAL_SCENARIO_WML);
      const scenario = cfg.child('scenario')!;
      const attackerType = makeUnitType('attacker-type', 32, moveType, 8, 3);
      const defenderType = makeUnitType('defender-type', 20, moveType, 4, 1);
      const resolveType = (id: string) => (attackerType.id === id ? attackerType : defenderType);
      const board = GameBoard.fromConfig(scenario, terrainData, resolveType);
      const attackerUnit = Unit.create(attackerType, 1, Location.fromWml(1, 1));
      const defenderUnit = Unit.create(defenderType, 2, Location.fromWml(3, 1));
      board.addUnit(attackerUnit);
      board.addUnit(defenderUnit);

      const rng = new RngDeterministic(new MtRng(seed));
      const route = findPath(board, attackerUnit, Location.fromWml(2, 1), { ignoreUnit: true });
      executeMove(board, attackerUnit, route.steps);
      const result = executeAttack(board, rng, attackerUnit.location, 0, defenderUnit.location);
      return { attackerHp: attackerUnit.hitpoints, hits: result.blows.map((b) => b.hit) };
    }

    const a = play(777);
    const b = play(777);
    expect(a).toEqual(b);
  });
});
