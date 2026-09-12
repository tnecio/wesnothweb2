import { describe, expect, it } from 'vitest';
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import { parseTerrainCode, NONE_TERRAIN, type TerrainCode } from '@wesnothweb2/engine/src/model/Terrain.js';
import { parseTerrainGraphicsRules } from '../../src/terrain/terrainGraphicsRules.js';
import { buildTerrainTiles, getTerrainFramesAt, type TerrainMapQuery } from '../../src/terrain/terrainBuilder.js';

/**
 * Pins the rotation-template geometry end to end: a `rotations=n,ne,se,s,sw,nw`
 * template whose one image sits on the hex NORTH of the anchor must, after
 * expansion, put `t-<dir>.png` on exactly the anchor's <dir> neighbour for
 * all six directions -- for BOTH column parities, since `legacy_sum`'s
 * y-adjustment depends on the anchor column being odd or even.
 */

const OFF = parseTerrainCode('_off^_usr');

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

/**
 * `templateX` is the anchor's column IN TEMPLATE SPACE. Real `map=` templates
 * put the anchor at an odd template column (e.g. NEW:TRANSITION's `, 2 / 1 , 1`
 * puts pos=1 at (1,1)), and `rotate()`'s `vi = y - x/2` plus the legacy
 * renormalisation behave differently for odd vs even template columns -- so
 * both must be covered, independently of the MAP column parity below.
 */
function northNeighbourTemplate(templateX = 0, viaMapString = false): WmlConfig {
  const root = new WmlConfig();
  const br = root.addChild('terrain_graphics');
  br.setAttribute('rotations', 'n,ne,se,s,sw,nw');
  if (viaMapString) {
    // anchor pos=1 at template (1,1), its north neighbour pos=2 at (1,0) --
    // the same ASCII layout NEW:TRANSITION uses.
    br.setAttribute('map', '\n, 2\n. , .\n, 1');
    const anchor = br.addChild('tile');
    anchor.setAttribute('pos', 1);
    anchor.setAttribute('type', 'Gg');
    const north = br.addChild('tile');
    north.setAttribute('pos', 2);
    north.setAttribute('type', 'Ww');
    north.addChild('image').setAttribute('name', 't-@R0.png');
    return root;
  }
  const anchor = br.addChild('tile');
  anchor.setAttribute('x', templateX);
  anchor.setAttribute('y', 1);
  anchor.setAttribute('type', 'Gg');
  const north = br.addChild('tile');
  north.setAttribute('x', templateX);
  north.setAttribute('y', 0);
  north.setAttribute('type', 'Ww');
  north.addChild('image').setAttribute('name', 't-@R0.png');
  return root;
}

/** 0-based engine convention: ODD x is the shifted-down column (see Location.ts). */
function neighbours(x: number, y: number): Record<string, [number, number]> {
  const odd = x % 2 === 1;
  return odd
    ? { n: [x, y - 1], ne: [x + 1, y], se: [x + 1, y + 1], s: [x, y + 1], sw: [x - 1, y + 1], nw: [x - 1, y] }
    : { n: [x, y - 1], ne: [x + 1, y - 1], se: [x + 1, y], s: [x, y + 1], sw: [x - 1, y], nw: [x - 1, y - 1] };
}

function imagesAt(rows: string[], x: number, y: number, templateX = 0, viaMap = false): string[] {
  const rules = parseTerrainGraphicsRules(northNeighbourTemplate(templateX, viaMap), { imageExists: () => true });
  const tiles = buildTerrainTiles(rules, gridMap(rows), { offMapCode: OFF });
  const { background, foreground } = getTerrainFramesAt(tiles, x, y, '');
  return [...background, ...foreground].map((l) => l.frames[0]!.path);
}

describe('rotation templates place the rotated image on the right neighbour', () => {
  const ODD_MAP: [string[], number, number] = [['Ww,Ww,Ww', 'Ww,Gg,Ww', 'Ww,Ww,Ww'], 1, 1];
  const EVEN_MAP: [string[], number, number] = [['Ww,Ww,Ww,Ww', 'Ww,Ww,Gg,Ww', 'Ww,Ww,Ww,Ww'], 2, 1];
  it.each([
    ['template x=0, odd map column', ...ODD_MAP, 0, false],
    ['template x=0, even map column', ...EVEN_MAP, 0, false],
    ['template x=1, odd map column', ...ODD_MAP, 1, false],
    ['template x=1, even map column', ...EVEN_MAP, 1, false],
    ['map= string (anchor at template (1,1)), odd map column', ...ODD_MAP, 0, true],
    ['map= string (anchor at template (1,1)), even map column', ...EVEN_MAP, 0, true],
  ])('%s', (_label, rows, ax, ay, templateX, viaMap) => {
    const rules = parseTerrainGraphicsRules(northNeighbourTemplate(templateX, viaMap), { imageExists: () => true });
    const tiles = buildTerrainTiles(rules, gridMap(rows), { offMapCode: OFF });
    const got: Record<string, string[]> = {};
    for (const [dir, [nx, ny]] of Object.entries(neighbours(ax, ay))) {
      const { background, foreground } = getTerrainFramesAt(tiles, nx, ny, '');
      got[dir] = [...background, ...foreground].map((l) => l.frames[0]!.path);
    }
    expect(got).toEqual({
      n: ['terrain/t-n.png'],
      ne: ['terrain/t-ne.png'],
      se: ['terrain/t-se.png'],
      s: ['terrain/t-s.png'],
      sw: ['terrain/t-sw.png'],
      nw: ['terrain/t-nw.png'],
    });
    // and nothing lands on the anchor itself or any non-neighbour
    expect(imagesAt(rows, ax, ay, templateX, viaMap)).toEqual([]);
  });
});
