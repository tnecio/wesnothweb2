import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefines, preloadDefinesFromDir, type DefineMap } from '../../src/wml/index.js';
import { WmlConfig } from '../../src/wml/config.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { UnitType, AttackType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { EventManager, EventPump } from '../../src/events/pump.js';
import { VariableStore } from '../../src/events/variables.js';

/**
 * Real-content, end-to-end test: registers Dead_Water scenario 1's actual
 * `[event]` blocks (`data/campaigns/Dead_Water/scenarios/01_Invasion.cfg`,
 * `[scenario][event] name=prestart` and `name=start`) with a real
 * `EventManager`, fires them through a real `EventPump`, and asserts on
 * resulting engine state -- not just that parsing succeeds.
 *
 * Setup mirrors `test/wml/deadWaterIntegration.test.ts` (macro-flag
 * preloading) and `test/model/gameBoardIntegration.test.ts` (map/terrain/
 * resolveType stub), both established by prior phases of this project.
 *
 * Unlike `gameBoardIntegration.test.ts` -- which loads every `[unit]` found
 * anywhere in the scenario tree at once, including ones nested inside
 * `[event]` blocks, and documents that as a known Phase 1 limitation "needs
 * Phase 2's WML event pump, not a Phase 1 data-model fix" -- this test
 * builds a board with NO pre-loaded units (only the two side leaders) and
 * lets the *event pump* place every other unit by actually firing
 * `prestart`/`start`, the way a real game does. That's the concrete
 * capability this module adds over Phase 1.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');
const campaignDir = path.join(dataRoot, 'campaigns/Dead_Water');

function loadDefines(): DefineMap {
  const defines: DefineMap = new Map();
  const flag = (name: string) =>
    defines.set(name, { name, params: [], optionalParams: new Map(), body: '', dir: dataRoot, location: '<test>' });
  flag('CAMPAIGN_DEAD_WATER');
  flag('NORMAL');
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  preloadDefines(path.join(campaignDir, '_main.cfg'), defines, { dataRoot });
  return defines;
}

function loadTerrainData(defines: DefineMap): TerrainTypeData {
  const terrainCfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), { dataRoot, defines: new Map(defines) });
  return TerrainTypeData.fromConfigs(terrainCfg.children('terrain_type'));
}

/**
 * A REAL "swimmer" movetype (not an empty/stub one) -- Dead_Water's own map
 * is mostly water/coast, and this test's [move_unit] assertions (see
 * "firing 'start'" below) need `Unit.movementCost` to actually resolve
 * real, mostly-passable costs across it: `findVacantTile`'s `passCheck`
 * (real, reported bug's fix -- `actionMoveUnit`/`pathfind.ts`) treats an
 * `UNREACHABLE` cost on every terrain (what an empty `[movement_costs]`
 * resolves to -- see `MoveType.ts`'s `MOVEMENT_PARAMS.defaultValue`) as
 * "this unit can never reach anywhere," which silently defeated the
 * "nearest vacant hex" search this stub used to make impossible to test
 * meaningfully.
 */
function loadRealSwimmerMoveType(dataRoot: string, defines: DefineMap, terrainData: TerrainTypeData): MoveType {
  const cfg = parseWmlFile(path.join(dataRoot, 'core/units.cfg'), { dataRoot, defines: new Map(defines) });
  function walk({ tag, config }: { tag: string; config: WmlConfig }): WmlConfig[] {
    if (tag === 'movetype' && config.getString('name') === 'swimmer') return [config];
    return config.allChildren().flatMap(walk);
  }
  const found = cfg.allChildren().flatMap(walk)[0];
  if (!found) throw new Error('movetype swimmer not found');
  return MoveType.fromConfig(found, terrainData);
}

function makeStubResolveType(dataRoot: string, defines: DefineMap, terrainData: TerrainTypeData): (id: string) => UnitType {
  const moveType = loadRealSwimmerMoveType(dataRoot, defines, terrainData);
  const attack = AttackType.fromConfig(new WmlConfig());
  const cache = new Map<string, UnitType>();
  return (id: string) => {
    let type = cache.get(id);
    if (!type) {
      type = new UnitType(id, id, '', 'neutral', 1, 30, 5, 5, 0, 1, 0, -1, 500, [], '', true, false, false, moveType, [attack], []);
      cache.set(id, type);
    }
    return type;
  };
}

describe('EventPump running Dead_Water scenario 1 real [event] blocks', () => {
  const defines = loadDefines();
  const terrainData = loadTerrainData(defines);
  const resolveType = makeStubResolveType(dataRoot, defines, terrainData);

  const scenarioCfg = parseWmlFile(path.join(campaignDir, 'scenarios/01_Invasion.cfg'), {
    dataRoot,
    defines: new Map(defines),
  });
  const scenario = scenarioCfg.child('scenario')!;

  function freshBoard(): GameBoard {
    const mapText = fs.readFileSync(path.join(campaignDir, 'maps', scenario.getString('map_file')), 'utf8');
    // Only [side] children -- deliberately NOT the whole scenario, so GameBoard.fromConfig's
    // generic [unit]-anywhere-in-the-tree walk (see its module doc comment) has nothing to find.
    // Every unit besides the two side leaders should come from the event pump actually firing
    // prestart/start below, which is the real thing this test is checking.
    const boardOnlyCfg = new WmlConfig();
    boardOnlyCfg.setAttribute('map_data', mapText);
    for (const side of scenario.children('side')) boardOnlyCfg.addChild('side', side);
    return GameBoard.fromConfig(boardOnlyCfg, terrainData, resolveType);
  }

  it('board starts with only the two side leaders (no event-nested units loaded upfront)', () => {
    const board = freshBoard();
    expect(board.allUnits().map((u) => u.id).sort()).toEqual(['Kai Krellis', 'Mal-Kevek']);
  });

  it('firing "prestart" runs real [set_variable]/[set_variables]/[unit] actions from the scenario', () => {
    const board = freshBoard();
    const manager = new EventManager();
    manager.loadScenarioEvents(scenario);
    const variables = new VariableStore();
    const pump = new EventPump(manager, { board, variables, resolveType });

    pump.fire('prestart');

    // [set_variable] name=number_of_captured_villages value=0, straight from the scenario.
    expect(pump.ctx.variables.getNumber('number_of_captured_villages')).toBe(0);

    // {SET_VILLAGE_ZOMBIE_PATTERN 1 2 1 2 2 (Walking Corpse)} under #ifdef NORMAL expands to
    // [set_variables] name=zombie_number_pattern mode=replace with five [value] children, plus
    // [set_variable] name=zombie_type value=(Walking Corpse) -- both real macro expansions.
    expect(pump.ctx.variables.arrayLength('zombie_number_pattern')).toBe(5);
    expect(pump.ctx.variables.getNumber('zombie_number_pattern[0].number')).toBe(1);
    expect(pump.ctx.variables.getNumber('zombie_number_pattern[1].number')).toBe(2);
    expect(pump.ctx.variables.getNumber('zombie_number_pattern[4].number')).toBe(2);
    expect(pump.ctx.variables.getString('zombie_type')).toBe('Walking Corpse');

    // Six {PUT_CITIZEN X Y TRAIT1 TRAIT2} macro calls, each expanding to a [unit] of this type/side,
    // plus the named hero Cylanna (also a [unit] in the same event) -- seven real [unit] actions,
    // none of which were present on the board before prestart fired (see the previous test).
    const citizens = board.allUnits().filter((u) => u.type.id === 'Merman Citizen' && u.side === 1);
    expect(citizens).toHaveLength(6);
    for (const c of citizens) expect(c.location.valid()).toBe(true);

    const cylanna = board.allUnits().find((u) => u.id === 'Cylanna');
    expect(cylanna).toBeDefined();
    expect(cylanna!.type.id).toBe('Mermaid Priestess');
    expect(cylanna!.side).toBe(1);
    expect(cylanna!.location.wmlX).toBe(21);
    expect(cylanna!.location.wmlY).toBe(9);

    // Leaders are untouched by prestart.
    expect(board.allUnits().map((u) => u.id)).toContain('Kai Krellis');
    expect(board.allUnits().map((u) => u.id)).toContain('Mal-Kevek');
    expect(board.allUnits()).toHaveLength(2 /* leaders */ + 6 /* citizens */ + 1 /* Cylanna */);

    // Real, reported bug (bugs3.md "objectives dialog"): the scenario's
    // own real [objectives] (side=1, {HOW_TO_LOSE} + a real
    // [gold_carryover]) used to be a no-op -- now parsed and recorded per
    // side.
    const objectives = pump.ctx.objectivesBySide.get(1);
    expect(objectives).toBeDefined();
    expect(objectives!.objectives).toContainEqual({ description: 'Defeat enemy leader', condition: 'win', showTurnCounter: false });
    expect(objectives!.objectives).toContainEqual({ description: 'Death of Kai Krellis', condition: 'lose', showTurnCounter: false });
    expect(objectives!.objectives).toContainEqual({ description: 'Death of Cylanna', condition: 'lose', showTurnCounter: false });
    expect(objectives!.objectives).toContainEqual({ description: 'Turns run out', condition: 'lose', showTurnCounter: true });
    expect(objectives!.goldCarryover).toEqual([{ bonus: true, carryoverPercentage: 40 }]);
    // Side 2 never got its own [objectives] in this event.
    expect(pump.ctx.objectivesBySide.has(2)).toBe(false);
  });

  it('firing "start" records real [message] dialogue and spawns Gwabbo/the fiend via [unit]', () => {
    const board = freshBoard();
    const manager = new EventManager();
    manager.loadScenarioEvents(scenario);
    const variables = new VariableStore();
    const warnings: string[] = [];
    const pump = new EventPump(manager, {
      board,
      variables,
      resolveType,
      log: (level, msg) => {
        if (level === 'warn' || level === 'error') warnings.push(`${level}: ${msg}`);
      },
    });

    // "prestart" first, as the game does: it places Cylanna and the citizens. Since Phase 16 a
    // [message] whose speaker is not on the map is skipped (message.lua's get_speaker), so
    // firing "start" alone would drop Cylanna's lines.
    pump.fire('prestart');
    pump.ctx.messages.splice(0);
    expect(() => pump.fire('start')).not.toThrow();

    // The scenario's very first two [message] tags, verbatim.
    expect(pump.ctx.messages.length).toBeGreaterThanOrEqual(2);
    expect(pump.ctx.messages[0]).toMatchObject({
      speaker: 'Kai Krellis',
      message: 'Is something wrong, priestess?',
    });
    expect(pump.ctx.messages[1]).toMatchObject({
      speaker: 'Cylanna',
      message: 'Maybe. I smell death and decay.',
    });

    // [unit] type=Skeleton id=fiend side=2 x=34 y=23, and later Gwabbo (Merman Netcaster, side=1) --
    // both real [unit] action tags inside the "start" event body.
    const fiend = board.allUnits().find((u) => u.id === 'fiend');
    expect(fiend).toBeDefined();
    expect(fiend!.type.id).toBe('Skeleton');
    expect(fiend!.side).toBe(2);

    const gwabbo = board.allUnits().find((u) => u.id === 'Gwabbo');
    expect(gwabbo).toBeDefined();
    expect(gwabbo!.type.id).toBe('Merman Netcaster');
    expect(gwabbo!.side).toBe(1);
    // The scenario places Gwabbo with hitpoints=4 explicitly.
    expect(gwabbo!.hitpoints).toBe(4);
    // Real [modifications][trait]{TRAIT_LOYAL} -- see Unit.loyal's own doc
    // comment (the real, reported bug this covers: the loyal-icon overlay
    // had no engine-side signal to draw from at all).
    expect(gwabbo!.loyal).toBe(true);
    expect(fiend!.loyal).toBe(false);

    // Real, reported bug: `{MOVE_UNIT id=Gwabbo 20 10}` (a [move_unit]
    // action) used to be a no-op extension point -- Gwabbo would stay
    // wherever his [unit] tag placed him (34, 20) instead of retreating
    // toward the keep. Now a real relocation: no movement-point cost (this
    // is a scripted cutscene move, not a player move -- see actionWml.ts's
    // actionMoveUnit doc comment), so movesLeft is untouched.
    expect(gwabbo!.location.wmlX).toBe(20);
    expect(gwabbo!.location.wmlY).toBe(10);

    // The fiend's own earlier [move_unit] (34,23 -> 35,20) in the same
    // event body, same real fix.
    expect(fiend!.location.wmlX).toBe(35);
    expect(fiend!.location.wmlY).toBe(20);

    // Real, reported bug (bugs2.md "Lua events/narration ... not synced
    // with the narrative messages"): Gwabbo's own first line ("Back, you
    // fiend!...") is messages[2] -- fired right after his [unit] spawn but
    // BEFORE {MOVE_UNIT id=Gwabbo 20 10}, both in the same event body (see
    // the real scenario source). His checkpoint at THAT message should
    // show him at his real spawn position (34, 20), not the post-move
    // (20, 10) the live board now has -- and he shouldn't exist at all in
    // the two earlier messages' checkpoints, since he hadn't spawned yet.
    expect(pump.ctx.messages[2]).toMatchObject({ speaker: 'Gwabbo', message: expect.stringContaining('Back, you fiend') });
    const gwabboAtOwnMessage = pump.ctx.messages[2]!.unitsBefore.find((c) => c.unit === gwabbo);
    expect(gwabboAtOwnMessage).toBeDefined();
    expect(gwabboAtOwnMessage!.x).toBe(33); // wml (34,20) -> engine 0-based (33,19)... see below
    expect(gwabboAtOwnMessage!.y).toBe(19);
    expect(pump.ctx.messages[0]!.unitsBefore.some((c) => c.unit === gwabbo)).toBe(false);
    expect(pump.ctx.messages[1]!.unitsBefore.some((c) => c.unit === gwabbo)).toBe(false);

    // [attack]/[recruit]/[lua] remain extension-point placeholders (see
    // actionWml.ts) -- none of them appear in this specific event body, so
    // no "extension point" warning should fire at all now that [move_unit]
    // (the only such tag this event used) is a real implementation.
    expect(warnings.some((w) => w.includes('extension point'))).toBe(false);
  });
});
