import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile } from '../../src/wml/index.js';
import { WmlConfig } from '../../src/wml/config.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { MoveType } from '../../src/model/MoveType.js';
import { UnitType } from '../../src/model/UnitType.js';

/**
 * Real, reported bug: `synthetic-campaigns/abilities/scenarios/01_abilities.cfg`
 * placed its side 2 leader at x=8 on an `abilities.map` authored WITHOUT the
 * 1-hex border margin real Wesnoth `.map` files always carry (confirmed
 * against `wesnoth/data/campaigns/Dead_Water/maps/Home_1.map`: raw grid is
 * usable+2 in both dimensions -- see `GameMap.w()`/`h()`/`DEFAULT_BORDER`).
 * That silently shrank the map's *usable* area by 2 columns/2 rows, pushing
 * the leader (and anything else placed at the authored edge) into what the
 * engine now treats as unusable border space -- rendered, but outside
 * `GameMap.onBoard`.
 *
 * This guards every synthetic-campaigns/ scenario (not just the one
 * reported) against the same class of authoring mistake: every placed unit
 * -- inline `[side]` leaders and `[unit]` children alike -- must resolve
 * onto the map's actual usable area.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');
const syntheticRoot = path.join(repoRoot, 'synthetic-campaigns');

function findScenarioFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...findScenarioFiles(full));
    else if (name.endsWith('.cfg') && full.includes('/scenarios/')) out.push(full);
  }
  return out;
}

const terrainCfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), { dataRoot });
const terrainData = TerrainTypeData.fromConfigs(terrainCfg.children('terrain_type'));

const emptyMoveType = MoveType.fromConfig(new WmlConfig(), terrainData);
const stubType = new UnitType('stub', 'stub', '', 'neutral', 1, 1, 0, 0, 0, 1, 0, -1, 0, [], '', false, false, false, emptyMoveType, [], []);
const resolveType = () => stubType;

const scenarioFiles = findScenarioFiles(syntheticRoot);

describe('synthetic-campaigns scenarios: every unit lands on the usable map (real, reported bug)', () => {
  it('found at least one scenario file to check', () => {
    expect(scenarioFiles.length).toBeGreaterThan(0);
  });

  for (const scenarioFile of scenarioFiles) {
    it(`${path.relative(repoRoot, scenarioFile)}: leaders/units are all onBoard`, () => {
      const scenarioCfg = parseWmlFile(scenarioFile, { dataRoot: path.dirname(scenarioFile) });
      const scenario = scenarioCfg.child('scenario');
      if (!scenario) return; // not every .cfg under scenarios/ is itself a [scenario] (e.g. shared includes)

      const mapFile = scenario.getString('map_file');
      if (!mapFile) return;
      const mapText = fs.readFileSync(path.join(path.dirname(scenarioFile), '../maps', mapFile), 'utf8');
      scenario.setAttribute('map_data', mapText);

      const board = GameBoard.fromConfig(scenario, terrainData, resolveType);
      const offBoard = board.allUnits().filter((u) => !board.map.onBoard(u.location));
      expect(offBoard.map((u) => `${u.id} at ${u.location.wmlX},${u.location.wmlY}`)).toEqual([]);
    });
  }
});
