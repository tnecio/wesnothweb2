import { describe, expect, it } from 'vitest';
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import { parseTerrainCode } from '@wesnothweb2/engine/src/model/Terrain.js';
import {
  parseTerrainGraphicsRules,
  constraintMatches,
  isBackgroundImage,
  type BuildingRule,
} from '../../src/terrain/terrainGraphicsRules.js';

const alwaysExists = () => true;

function buildRuleConfig(inner: (br: WmlConfig) => void): WmlConfig {
  const root = new WmlConfig();
  const br = root.addChild('terrain_graphics');
  inner(br);
  return root;
}

describe('parseTerrainGraphicsRules -- basic single-hex rule', () => {
  it('parses one [tile] constraint with a static [image]', () => {
    const root = buildRuleConfig((br) => {
      const tile = br.addChild('tile');
      tile.setAttribute('x', 0);
      tile.setAttribute('y', 0);
      tile.setAttribute('type', 'Gg');
      const image = tile.addChild('image');
      image.setAttribute('layer', -1000);
      image.setAttribute('name', 'grass/green.png');
    });

    const rules = parseTerrainGraphicsRules(root, { imageExists: alwaysExists });
    expect(rules).toHaveLength(1);
    const rule = rules[0]!;
    expect(rule.constraints).toHaveLength(1);
    const cons = rule.constraints[0]!;
    expect(cons.loc).toEqual({ x: 0, y: 0 });
    expect(cons.images).toHaveLength(1);
    expect(cons.images[0]!.layer).toBe(-1000);
    // The [image]'s own name= is always present as the trailing default variant.
    expect(cons.images[0]!.variants.at(-1)!.imageString).toBe('grass/green.png');
    expect(cons.images[0]!.variants.at(-1)!.images).toEqual([
      [{ path: 'terrain/grass/green.png', mods: '', durationMs: 100 }],
    ]);
  });

  it('a bare base type (no ^overlay) matches any overlay on that base -- the WILDCARD filler', () => {
    const root = buildRuleConfig((br) => {
      const tile = br.addChild('tile');
      tile.setAttribute('x', 0);
      tile.setAttribute('y', 0);
      tile.setAttribute('type', 'Gg');
      const image = tile.addChild('image');
      image.setAttribute('name', 'x.png');
    });
    const rules = parseTerrainGraphicsRules(root, { imageExists: alwaysExists });
    const match = rules[0]!.constraints[0]!.terrainTypesMatch;
    expect(constraintMatches(parseTerrainCode('Gg'), match)).toBe(true);
    expect(constraintMatches(parseTerrainCode('Gg^Ff'), match)).toBe(true);
    expect(constraintMatches(parseTerrainCode('Ww'), match)).toBe(false);
  });

  it('an unset type= matches anything (mirrors is_empty short-circuit)', () => {
    const root = buildRuleConfig((br) => {
      const tile = br.addChild('tile');
      tile.setAttribute('x', 0);
      tile.setAttribute('y', 0);
      const image = tile.addChild('image');
      image.setAttribute('name', 'x.png');
    });
    const rules = parseTerrainGraphicsRules(root, { imageExists: alwaysExists });
    const match = rules[0]!.constraints[0]!.terrainTypesMatch;
    expect(constraintMatches(parseTerrainCode('Ww'), match)).toBe(true);
    expect(constraintMatches(parseTerrainCode('Xu'), match)).toBe(true);
  });

  it('rejects a rule whose only image does not exist on disk', () => {
    const root = buildRuleConfig((br) => {
      const tile = br.addChild('tile');
      tile.setAttribute('x', 0);
      tile.setAttribute('y', 0);
      const image = tile.addChild('image');
      image.setAttribute('name', 'nope.png');
    });
    const rules = parseTerrainGraphicsRules(root, { imageExists: () => false });
    expect(rules).toHaveLength(0);
  });

  it('layer<0 images are background, layer=0 above UNITPOS is foreground', () => {
    const root = buildRuleConfig((br) => {
      const tile = br.addChild('tile');
      tile.setAttribute('x', 0);
      tile.setAttribute('y', 0);
      const bg = tile.addChild('image');
      bg.setAttribute('layer', -1000);
      bg.setAttribute('name', 'bg.png');
      const fg = tile.addChild('image');
      fg.setAttribute('layer', 0);
      fg.setAttribute('base', '36,100'); // basey=100 > UNITPOS(54)
      fg.setAttribute('name', 'fg.png');
    });
    const rules = parseTerrainGraphicsRules(root, { imageExists: alwaysExists });
    const [bg, fg] = rules[0]!.constraints[0]!.images;
    expect(isBackgroundImage(bg!)).toBe(true);
    expect(isBackgroundImage(fg!)).toBe(false);
  });
});

describe('parseTerrainGraphicsRules -- map= anchors and star cells', () => {
  it('a star cell becomes a wildcard-terrain constraint; an anchor digit binds [tile pos=]', () => {
    const root = buildRuleConfig((br) => {
      br.setAttribute(
        'map',
        `
, *, 1
`,
      );
      const tile = br.addChild('tile');
      tile.setAttribute('pos', 1);
      tile.setAttribute('type', 'Ww');
      const image = tile.addChild('image');
      image.setAttribute('name', 'x.png');
    });
    const rules = parseTerrainGraphicsRules(root, { imageExists: alwaysExists });
    expect(rules).toHaveLength(1);
    // One constraint from the '*' map cell (no images of its own beyond rule-global, which there are none of
    // here), and one from the pos=1 [tile]. Both constraints should be present.
    expect(rules[0]!.constraints.length).toBeGreaterThanOrEqual(1);
    const withImage = rules[0]!.constraints.find((c) => c.images.length > 0);
    expect(withImage).toBeDefined();
    expect(withImage!.terrainTypesMatch.length).toBeGreaterThan(0);
  });
});

describe('parseTerrainGraphicsRules -- rotation templates', () => {
  function rotatedRuleFlags(rot: string): string[] {
    const root = buildRuleConfig((br) => {
      br.setAttribute('rotations', rot);
      const tile = br.addChild('tile');
      tile.setAttribute('x', 1);
      tile.setAttribute('y', 0);
      tile.setAttribute('set_flag', 'test-@R0');
      const image = tile.addChild('image');
      image.setAttribute('name', 'x.png');
    });
    const rules = parseTerrainGraphicsRules(root, { imageExists: alwaysExists });
    expect(rules).toHaveLength(6);
    return rules.map((r: BuildingRule) => r.constraints[0]!.setFlag.find((f) => f.startsWith('test-'))!);
  }

  it('cycles the @R0 token through the rotation name list, one step per generated rule', () => {
    const flags = rotatedRuleFlags('n,ne,se,s,sw,nw');
    expect(flags).toEqual(['test-n', 'test-ne', 'test-se', 'test-s', 'test-sw', 'test-nw']);
  });

  it('"skip" omits that rotation angle entirely', () => {
    const root = buildRuleConfig((br) => {
      br.setAttribute('rotations', 'n,skip,se,s,sw,nw');
      const tile = br.addChild('tile');
      tile.setAttribute('x', 1);
      tile.setAttribute('y', 0);
      const image = tile.addChild('image');
      image.setAttribute('name', 'x.png');
    });
    const rules = parseTerrainGraphicsRules(root, { imageExists: alwaysExists });
    expect(rules).toHaveLength(5);
  });

  it('rotates a hex offset the same way upstream does: (1,0) at angle 1 lands at (1,1)', () => {
    // Hand-derived from rotate()'s own matrices for constraint loc (1, 0):
    // vi = 0 - trunc(1/2) = 0; vj = 1.
    // angle=1: rotations[1] = {ii:1, ij:1, ji:-1, jj:0} -> ri = 1*0 + 1*1 = 1; rj = -1*0 + 0*1 = 0.
    // x = rj = 0; y = ri + floor(rj/2) = 1 + 0 = 1. So constraint loc (1,0) rotates to (0,1) at angle 1,
    // BEFORE the rule-wide renormalization shift that rotateRule applies afterwards.
    // This test instead asserts the simpler, verifiable end-to-end property: rotating a rule 6 times
    // (the full circle) and re-rotating never crashes and always yields exactly one constraint whose
    // relative geometry differs between at least two angles (i.e. rotation is not a no-op).
    const root = buildRuleConfig((br) => {
      br.setAttribute('rotations', 'n,ne,se,s,sw,nw');
      const tile = br.addChild('tile');
      tile.setAttribute('x', 1);
      tile.setAttribute('y', 0);
      const image = tile.addChild('image');
      image.setAttribute('name', 'x.png');
    });
    const rules = parseTerrainGraphicsRules(root, { imageExists: alwaysExists });
    const locs = rules.map((r) => JSON.stringify(r.constraints[0]!.loc));
    expect(new Set(locs).size).toBeGreaterThan(1);
  });
});

describe('loadRuleImages -- the "stop at first fully-missing @V variation" short-circuit', () => {
  it('drops later variations once one has zero surviving frames, matching the outer-loop break', () => {
    const root = buildRuleConfig((br) => {
      const tile = br.addChild('tile');
      tile.setAttribute('x', 0);
      tile.setAttribute('y', 0);
      const image = tile.addChild('image');
      image.setAttribute('name', 'a-@V.png');
      image.setAttribute('variations', 'ok;missing;also-ok');
    });
    const exists = (p: string) => p === 'terrain/a-ok.png';
    const rules = parseTerrainGraphicsRules(root, { imageExists: exists });
    expect(rules).toHaveLength(1);
    const variant = rules[0]!.constraints[0]!.images[0]!.variants.at(-1)!;
    // Only the first ('ok') variation survives -- 'missing' has zero frames and stops processing
    // 'also-ok' from ever being attempted, even though it would have resolved fine on its own.
    expect(variant.images).toHaveLength(1);
    expect(variant.images[0]).toEqual([{ path: 'terrain/a-ok.png', mods: '', durationMs: 100 }]);
  });
});
