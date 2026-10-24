/**
 * Phase 27a S7: a `[side]`'s `[filter_recall]` belongs to its leader -- `saved_game::expand_scenario` moves every
 * `[side]` child but `team::tags` into the `[leader]` it builds -- and so limits what that leader may recall.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile } from '../../src/wml/index.js';
import { WmlConfig } from '../../src/wml/config.js';
import { parseConfig } from '../../src/index.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { MoveType } from '../../src/model/MoveType.js';
import { UnitType } from '../../src/model/UnitType.js';
import { Unit } from '../../src/model/Unit.js';
import { Location } from '../../src/model/Location.js';
import { leaderCanRecall } from '../../src/actions/recruit.js';

const dataRoot = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..'), 'wesnoth/data');
const terrainData = TerrainTypeData.fromConfigs(parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), { dataRoot }).children('terrain_type'));
const moveType = MoveType.fromConfig(new WmlConfig(), terrainData);
const typeOf = (id: string) => new UnitType(id, id, '', 'neutral', 1, 1, 0, 0, 0, 1, 0, -1, 0, [], '', false, false, false, moveType, [], []);

describe("a [side]'s [filter_recall]", () => {
  it('is its leader\'s, and limits what it may recall', () => {
    const scenario = parseConfig(
      `map_data="Gg, Gg, Gg\nGg, 1 Kh, Gg\nGg, Gg, Gg"\n[side]\nside=1\ntype=Lord\nid=lord\n[filter_recall]\ntype=Knight\n[/filter_recall]\n[/side]`,
    );
    const board = GameBoard.fromConfig(scenario, terrainData, typeOf);
    for (const type of ['Knight', 'Bowman']) board.addToRecallList(1, Unit.create(typeOf(type), 1, Location.NULL));
    const lord = board.allUnits().find((u) => u.id === 'lord')!;
    expect(lord.filterRecall?.getString('type')).toBe('Knight');
    const allowed = board.recallList(1).filter((u) => leaderCanRecall(lord, u, board)).map((u) => u.type.id);
    expect(allowed).toEqual(['Knight']);
  });
});
