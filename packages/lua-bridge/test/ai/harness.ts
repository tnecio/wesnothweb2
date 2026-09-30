/**
 * A game for the Lua AI tests: real unit types and terrain (`realContent.ts`), an event pump, the Lua
 * runtime on the real `data/lua` and `data/ai`, and an `AiManager` with the Lua engine attached -- the
 * shape `GameSession` gives it, without a session.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRealContent } from '@wesnothweb2/engine/test/helpers/realContent.js';
import { GameBoard } from '@wesnothweb2/engine/src/model/GameBoard.js';
import { Team } from '@wesnothweb2/engine/src/model/Team.js';
import { Unit } from '@wesnothweb2/engine/src/model/Unit.js';
import { Location } from '@wesnothweb2/engine/src/model/Location.js';
import { EventManager, EventPump } from '@wesnothweb2/engine/src/events/pump.js';
import { VariableStore } from '@wesnothweb2/engine/src/events/variables.js';
import { autoRespond, runFlow } from '@wesnothweb2/engine/src/events/interaction.js';
import { RngDeterministic } from '@wesnothweb2/engine/src/rng/RngDeterministic.js';
import { MtRng } from '@wesnothweb2/engine/src/rng/MtRng.js';
import { AiManager } from '@wesnothweb2/engine/src/ai/manager.js';
import type { AiHost } from '@wesnothweb2/engine/src/ai/types.js';
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import { loadLuaDataDir } from '../../src/dataLua.js';
import { LuaRuntime } from '../../src/runtime.js';
import { LuaAiEngine } from '../../src/kernel/ai/luaAiEngine.js';

const dataFiles = loadLuaDataDir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../wesnoth/data'));

export interface UnitSpec {
  type: string;
  side: number;
  x: number;
  y: number;
  hp?: number;
  canrecruit?: boolean;
  experience?: number;
  poisoned?: boolean;
}

export function makeAiGame(rows: readonly string[], units: readonly UnitSpec[], options: { aiBlocks?: (side: number) => WmlConfig[]; gold?: number } = {}) {
  const content = loadRealContent();
  const board = new GameBoard(content.map(rows));
  board.addTeam(new Team(1, { gold: options.gold ?? 0, controller: 'ai', teamName: 'one' }));
  board.addTeam(new Team(2, { gold: options.gold ?? 0, controller: 'ai', teamName: 'two' }));
  board.lawfulBonusAt = () => 0;
  const rng = new RngDeterministic(new MtRng(11));
  for (const spec of units) {
    const unit = Unit.create(content.unitType(spec.type), spec.side, Location.fromWml(spec.x, spec.y), { canRecruit: spec.canrecruit });
    board.assignUnitId(unit);
    if (spec.hp !== undefined) unit.hitpoints = spec.hp;
    if (spec.experience !== undefined) unit.experience = spec.experience;
    if (spec.poisoned) unit.setStatus('poisoned', true);
    board.addUnit(unit);
  }
  const logs: string[] = [];
  const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => {
    if (level !== 'debug') logs.push(`${level}: ${message}`);
  };
  const pump = new EventPump(new EventManager(), {
    board,
    variables: new VariableStore(),
    resolveType: (id) => content.unitType(id),
    rng,
    log,
  });
  let currentSide = 1;
  const late: { manager?: AiManager } = {};
  const runtime = new LuaRuntime({ modules: {}, wml: {} }, () => pump.ctx, {
    dataFiles,
    currentSide: () => currentSide,
    sideAiConfigs: (side) => (late.manager ? [late.manager.toConfig(side)] : []),
  });
  const host: AiHost = {
    board,
    rng,
    resolveType: (id) => content.unitType(id),
    lawfulBonusAt: () => 0,
    maxLiminalBonus: 25,
    turnNumber: () => 1,
    timeOfDayId: () => 'afternoon',
    raise: (name, l1, l2, data) => pump.ctx.raise(name, l1, l2, data),
    fire: (name, l1, l2) => runFlow(pump.ctx.fireNow(name, l1, l2)),
    pump: () => runFlow(pump.pumpFlow(), autoRespond),
    log,
    scenarioEnded: () => false,
  };
  const engine = new LuaAiEngine(runtime, () => autoRespond);
  const manager = new AiManager(host, (side) => options.aiBlocks?.(side) ?? [], undefined, new Map([['lua', engine]]));
  late.manager = manager;
  engine.attach(manager);
  pump.ctx.ai = {
    modifyAi: (side, action, path, cfg) => void manager.modifyAi(side, action, path, cfg),
    appendSideAi: (side, cfg) => manager.appendSideAi(side, cfg),
    microAi: (side, cfg) => manager.applyMicroAi(side, cfg),
  };
  return {
    board,
    manager,
    runtime,
    variables: pump.ctx.variables,
    logs,
    unitAt: (x: number, y: number) => board.unitAt(Location.fromWml(x, y)),
    pump,
    playTurn(side: number) {
      currentSide = side;
      return manager.playTurn(side);
    },
  };
}
