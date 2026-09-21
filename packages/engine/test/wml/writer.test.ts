import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../../src/wml/parser.js';
import { writeWml } from '../../src/wml/writer.js';
import { WmlConfig } from '../../src/wml/config.js';
import {
  parseWmlFile,
  preloadDefines,
  preloadDefinesFromDir,
  type DefineMap,
} from '../../src/wml/index.js';

/**
 * The invariant that matters for `writeWml` is `parse(write(parse(text)))`
 * deep-equalling `parse(text)` -- NOT that the text comes back byte for
 * byte. Upstream's own attribute typing (`config_attribute_value`, mirrored
 * by `inferAttributeValue`) coerces `yes`/`no` and numeric-looking values
 * regardless of how they were quoted, so `x="12"` and `x=12` are the same
 * value to Wesnoth and there is nothing for a writer to preserve between
 * them. The tree is the contract.
 */
function roundTrip(cfg: WmlConfig): WmlConfig {
  return parseConfig(writeWml(cfg));
}

describe('writeWml', () => {
  it('writes tab-indented tags, bare numbers/bools and quoted strings, as upstream does', () => {
    const cfg = parseConfig(`
[side]
    side=1
    gold=120
    fog=no
    persistent=yes
    team_name="good guys"
    [unit]
        type="Merman Child King"
        x=20
        y=9
    [/unit]
[/side]
`);
    expect(writeWml(cfg)).toBe(
      '[side]\n' +
        '\tside=1\n' +
        '\tgold=120\n' +
        '\tfog=no\n' +
        '\tpersistent=yes\n' +
        '\tteam_name="good guys"\n' +
        '\t[unit]\n' +
        '\t\ttype="Merman Child King"\n' +
        '\t\tx=20\n' +
        '\t\ty=9\n' +
        '\t[/unit]\n' +
        '[/side]\n',
    );
  });

  it('escapes an embedded quote by doubling it (utils::wml_escape_string), and reads it back as one quote', () => {
    const cfg = new WmlConfig();
    // The real shape this exists for: a save's `objectives=` is pango markup
    // full of `foreground="#00ff00"` attributes.
    cfg.setAttribute('objectives', '<span foreground="#00ff00">Defeat enemy leader</span>');

    expect(writeWml(cfg)).toBe('objectives="<span foreground=""#00ff00"">Defeat enemy leader</span>"\n');
    expect(roundTrip(cfg).getString('objectives')).toBe('<span foreground="#00ff00">Defeat enemy leader</span>');
  });

  it('keeps newlines inside a quoted value verbatim -- this is how real map_data= is written', () => {
    const cfg = new WmlConfig();
    cfg.setAttribute('map_data', 'Wot, Wot, Ds\nHd, Hd, Md\n');

    expect(writeWml(cfg)).toBe('map_data="Wot, Wot, Ds\nHd, Hd, Md\n"\n');
    expect(roundTrip(cfg).getString('map_data')).toBe('Wot, Wot, Ds\nHd, Hd, Md\n');
  });

  it('preserves repeated sibling tags and their order', () => {
    const cfg = parseConfig('[side]\nside=1\n[/side]\n[side]\nside=2\n[/side]\n[event]\nname=start\n[/event]\n');
    const back = roundTrip(cfg);

    expect(back.allChildren().map((c) => c.tag)).toEqual(['side', 'side', 'event']);
    expect(back.children('side').map((s) => s.getNumber('side'))).toEqual([1, 2]);
  });

  it('round-trips an empty string, a negative number and a zero without changing their meaning', () => {
    const cfg = new WmlConfig();
    cfg.setAttribute('flag', '');
    cfg.setAttribute('recall_cost', -1);
    cfg.setAttribute('gold', 0);

    const back = roundTrip(cfg);
    expect(back.getString('flag')).toBe('');
    expect(back.getNumber('recall_cost')).toBe(-1);
    expect(back.getNumber('gold')).toBe(0);
  });

  it('writes nothing for an empty config', () => {
    expect(writeWml(new WmlConfig())).toBe('');
  });
});

describe('writeWml against real content (Dead Water scenario 1, full pipeline)', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const dataRoot = path.join(repoRoot, 'wesnoth/data');

  function realScenarioConfig(): WmlConfig {
    const campaignDir = path.join(dataRoot, 'campaigns/Dead_Water');
    const defines: DefineMap = new Map();
    for (const name of ['CAMPAIGN_DEAD_WATER', 'NORMAL']) {
      defines.set(name, { name, params: [], optionalParams: new Map(), body: '', dir: dataRoot, location: '<test-harness>' });
    }
    preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
    preloadDefines(path.join(campaignDir, '_main.cfg'), defines, { dataRoot });
    return parseWmlFile(path.join(campaignDir, 'scenarios/01_Invasion.cfg'), { dataRoot, defines });
  }

  it('round-trips a whole real scenario: every attribute and child survives write -> parse', () => {
    const original = realScenarioConfig();
    const back = roundTrip(original);

    // Non-trivial input: this is a real campaign scenario, not a snippet.
    const scenario = original.child('scenario')!;
    expect(scenario.children('event').length).toBeGreaterThan(10);

    expect(back.toJSON()).toEqual(original.toJSON());
  });
});
