import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWml } from '@wesnothweb2/engine/src/wml/index.js';
import { loadLuaDataDir } from '../../src/dataLua.js';
import { generateLuaMap } from '../../src/kernel/mapgen.js';

/** C1: `map_generation=lua` -- upstream's own `cave_map_generator.lua`, run in the map generator kernel. */
const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../wesnoth/data');
const files = loadLuaDataDir(dataDir);

/** Sceptre of Fire 4's `[generator]`, as written (it uses no macros). */
function sof4Generator() {
  const text = fs.readFileSync(path.join(dataDir, 'campaigns/Sceptre_of_Fire/scenarios/4_Gathering_Materials.cfg'), 'utf8');
  const block = text.slice(text.indexOf('[generator]'), text.indexOf('[/generator]') + '[/generator]'.length);
  return parseWml(block).child('generator')!;
}

describe('the map generator kernel', () => {
  it("generates Sceptre of Fire 4's cave: 45x45 hexes, border included, the player's keep, the same for the same seed", () => {
    const generator = sof4Generator();
    const logs: string[] = [];
    const map = generateLuaMap(files, generator.getString('create_map'), generator, 1234, (level, message) => logs.push(`${level}: ${message}`));
    const rows = map.trim().split('\n');
    expect(rows).toHaveLength(45);
    expect(rows.every((r) => r.split(',').length === 45)).toBe(true);
    expect(map).toMatch(/\b1 Kud\b/);
    expect(map).toContain('Uu^Vud');
    expect(logs.filter((l) => l.startsWith('error'))).toEqual([]);
    expect(generateLuaMap(files, generator.getString('create_map'), generator, 1234, () => {})).toBe(map);
    expect(generateLuaMap(files, generator.getString('create_map'), generator, 99, () => {})).not.toBe(map);
  });
});
