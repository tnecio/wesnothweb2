import { describe, expect, it } from 'vitest';
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import { parseTerrainCode, NONE_TERRAIN, type TerrainCode } from '@wesnothweb2/engine/src/model/Terrain.js';
import { parseTerrainGraphicsRules } from '../../src/terrain/terrainGraphicsRules.js';
import { buildTerrainTiles, getTerrainFramesAt, type TerrainMapQuery } from '../../src/terrain/terrainBuilder.js';

const alwaysExists = () => true;
const OFF_MAP = parseTerrainCode('_off^_usr');

/** A rectangular grid of terrain codes, `TerrainMapQuery`-shaped, with every hex "on board". */
function gridMap(rows: string[]): TerrainMapQuery {
  const codes: TerrainCode[][] = rows.map((row) => row.split(',').map((s) => parseTerrainCode(s.trim())));
  const height = codes.length;
  const width = codes[0]?.length ?? 0;
  return {
    width,
    height,
    terrainAt: (x, y) => codes[y]?.[x] ?? NONE_TERRAIN,
    onBoard: (x, y) => x >= 0 && y >= 0 && x < width && y < height,
  };
}

function buildRuleConfig(inner: (br: WmlConfig) => void): WmlConfig {
  const root = new WmlConfig();
  const br = root.addChild('terrain_graphics');
  inner(br);
  return root;
}

describe('buildTerrainTiles + getTerrainFramesAt', () => {
  it('a single-hex rule matching the hex terrain places its image, background layer', () => {
    const root = buildRuleConfig((br) => {
      const tile = br.addChild('tile');
      tile.setAttribute('x', 0);
      tile.setAttribute('y', 0);
      tile.setAttribute('type', 'Gg');
      const image = tile.addChild('image');
      image.setAttribute('layer', -1000);
      image.setAttribute('name', 'grass.png');
    });
    const rules = parseTerrainGraphicsRules(root, { imageExists: alwaysExists });
    const map = gridMap(['Gg, Ww']);
    const tiles = buildTerrainTiles(rules, map, { offMapCode: OFF_MAP });

    const at00 = getTerrainFramesAt(tiles, 0, 0, '');
    expect(at00.background).toHaveLength(1);
    expect(at00.background[0]!.frames).toEqual([{ path: 'terrain/grass.png', mods: '', durationMs: 100, offsetX: 0, offsetY: 0 }]);
    expect(at00.foreground).toHaveLength(0);

    const at10 = getTerrainFramesAt(tiles, 1, 0, '');
    expect(at10.background).toHaveLength(0); // Ww doesn't match the Gg-only rule
  });

  it('a bare base type= matches any overlay on that base at runtime too', () => {
    const root = buildRuleConfig((br) => {
      const tile = br.addChild('tile');
      tile.setAttribute('x', 0);
      tile.setAttribute('y', 0);
      tile.setAttribute('type', 'Gg');
      const image = tile.addChild('image');
      image.setAttribute('name', 'grass.png');
    });
    const rules = parseTerrainGraphicsRules(root, { imageExists: alwaysExists });
    const map = gridMap(['Gg^Ff']);
    const tiles = buildTerrainTiles(rules, map, { offMapCode: OFF_MAP });
    expect(getTerrainFramesAt(tiles, 0, 0, '').background).toHaveLength(1);
  });

  it('set_flag/has_flag ordering: a later rule (by precedence) can depend on an earlier rule setting a flag', () => {
    const root = new WmlConfig();
    const first = root.addChild('terrain_graphics');
    first.setAttribute('precedence', 0);
    const t1 = first.addChild('tile');
    t1.setAttribute('x', 0);
    t1.setAttribute('y', 0);
    t1.setAttribute('type', 'Gg');
    t1.setAttribute('set_flag', 'base');
    const img1 = t1.addChild('image');
    img1.setAttribute('name', 'base.png');

    const second = root.addChild('terrain_graphics');
    second.setAttribute('precedence', 1);
    const t2 = second.addChild('tile');
    t2.setAttribute('x', 0);
    t2.setAttribute('y', 0);
    t2.setAttribute('type', 'Gg');
    t2.setAttribute('has_flag', 'base');
    const img2 = t2.addChild('image');
    img2.setAttribute('layer', 1);
    img2.setAttribute('name', 'overlay.png');

    const rules = parseTerrainGraphicsRules(root, { imageExists: alwaysExists });
    const map = gridMap(['Gg']);
    const tiles = buildTerrainTiles(rules, map, { offMapCode: OFF_MAP });
    const at = getTerrainFramesAt(tiles, 0, 0, '');
    expect(at.background).toHaveLength(1); // base.png
    expect(at.foreground).toHaveLength(1); // overlay.png, gated on the 'base' flag the first rule set
  });

  it('has_flag alone (no matching set_flag rule applied) never matches', () => {
    const root = buildRuleConfig((br) => {
      const tile = br.addChild('tile');
      tile.setAttribute('x', 0);
      tile.setAttribute('y', 0);
      tile.setAttribute('type', 'Gg');
      tile.setAttribute('has_flag', 'never-set');
      const image = tile.addChild('image');
      image.setAttribute('name', 'x.png');
    });
    const rules = parseTerrainGraphicsRules(root, { imageExists: alwaysExists });
    const map = gridMap(['Gg']);
    const tiles = buildTerrainTiles(rules, map, { offMapCode: OFF_MAP });
    expect(getTerrainFramesAt(tiles, 0, 0, '').background).toHaveLength(0);
  });

  it('a two-hex rule requires both its own-hex and neighbour-hex terrain to match', () => {
    const root = buildRuleConfig((br) => {
      const t0 = br.addChild('tile');
      t0.setAttribute('x', 0);
      t0.setAttribute('y', 0);
      t0.setAttribute('type', 'Gg');
      const t1 = br.addChild('tile');
      t1.setAttribute('x', 1);
      t1.setAttribute('y', 0);
      t1.setAttribute('type', 'Ww');
      const image = t0.addChild('image');
      image.setAttribute('name', 'coast.png');
    });
    const rules = parseTerrainGraphicsRules(root, { imageExists: alwaysExists });

    const coastMap = gridMap(['Gg, Ww']);
    const coastTiles = buildTerrainTiles(rules, coastMap, { offMapCode: OFF_MAP });
    expect(getTerrainFramesAt(coastTiles, 0, 0, '').background).toHaveLength(1);

    const noCoastMap = gridMap(['Gg, Gg']);
    const noCoastTiles = buildTerrainTiles(rules, noCoastMap, { offMapCode: OFF_MAP });
    expect(getTerrainFramesAt(noCoastTiles, 0, 0, '').background).toHaveLength(0);
  });

  it('tods filter variants; a variant with no tods= always matches (the default fallback)', () => {
    const root = buildRuleConfig((br) => {
      const tile = br.addChild('tile');
      tile.setAttribute('x', 0);
      tile.setAttribute('y', 0);
      tile.setAttribute('type', 'Gg');
      const image = tile.addChild('image');
      const variant = image.addChild('variant');
      variant.setAttribute('name', 'night.png');
      variant.setAttribute('tod', 'night');
      image.setAttribute('name', 'day.png');
    });
    const rules = parseTerrainGraphicsRules(root, { imageExists: alwaysExists });
    const map = gridMap(['Gg']);
    const tiles = buildTerrainTiles(rules, map, { offMapCode: OFF_MAP });

    const night = getTerrainFramesAt(tiles, 0, 0, 'night');
    expect(night.background[0]!.frames[0]!.path).toBe('terrain/night.png');

    const day = getTerrainFramesAt(tiles, 0, 0, 'morning');
    expect(day.background[0]!.frames[0]!.path).toBe('terrain/day.png');
  });

  it('the off-map padding ring beyond the board matches an _off^_usr-typed rule', () => {
    const root = buildRuleConfig((br) => {
      const tile = br.addChild('tile');
      tile.setAttribute('x', 0);
      tile.setAttribute('y', 0);
      tile.setAttribute('type', '_off^_usr');
      const image = tile.addChild('image');
      image.setAttribute('layer', -1000);
      image.setAttribute('name', 'off.png');
    });
    const rules = parseTerrainGraphicsRules(root, { imageExists: alwaysExists });
    const map = gridMap(['Gg']);
    const tiles = buildTerrainTiles(rules, map, { offMapCode: OFF_MAP });
    expect(getTerrainFramesAt(tiles, -1, 0, '').background).toHaveLength(1);
    expect(getTerrainFramesAt(tiles, 0, 0, '').background).toHaveLength(0);
  });
});
