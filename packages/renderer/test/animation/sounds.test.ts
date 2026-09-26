import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWmlFile, preloadDefinesFromDir, type DefineMap } from '@wesnothweb2/engine/src/wml/index.js';
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import { parseUnitAnimations } from '../../src/animation/unitAnimation.js';
import { animationSoundCues, animationSoundFiles } from '../../src/animation/playback.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');

function loadUnitTypeCfg(relPath: string): WmlConfig {
  const defines: DefineMap = new Map();
  preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });
  const cfg = parseWmlFile(path.join(dataRoot, relPath), { dataRoot, defines });
  return cfg.child('unit_type')!;
}

function unitType(): WmlConfig {
  const cfg = new WmlConfig();
  const anim = cfg.addChild('healed_anim');
  anim.addChild('frame').setAttribute('image', 'a.png:100');
  return cfg;
}

describe('frame sounds (unit_frame::redraw)', () => {
  it("a real unit's attack animations carry their hit and miss sounds as [attack_sound_frame] particles", () => {
    const anims = parseUnitAnimations(loadUnitTypeCfg('core/units/orcs/Grunt.cfg'));
    const attacks = anims.filter((a) => a.events.includes('attack'));
    const withSound = attacks.filter((a) => animationSoundCues(a).length > 0);
    expect(withSound.length).toBeGreaterThan(0);
    const files = animationSoundFiles(attacks);
    expect(files.length).toBeGreaterThan(0);
    // Sounds start before the hit lands (negative clock) or on it, never after the animation.
    for (const anim of withSound) for (const cue of animationSoundCues(anim)) expect(cue.atMs).toBeLessThanOrEqual(0);
  });

  it("a real unit's death animation plays die_sound at the hit, from the unit type's own attribute", () => {
    const cfg = loadUnitTypeCfg('core/units/orcs/Grunt.cfg');
    const deaths = parseUnitAnimations(cfg).filter((a) => a.events.includes('death'));
    expect(deaths.length).toBeGreaterThan(0);
    const dieSound = cfg.getString('die_sound');
    expect(dieSound).not.toBe('');
    for (const death of deaths) expect(animationSoundCues(death)).toContainEqual({ atMs: 0, files: dieSound });
  });

  it('a healed animation plays heal.wav unless the unit type names its own healed_sound', () => {
    const plain = parseUnitAnimations(unitType());
    expect(animationSoundCues(plain.find((a) => a.events.includes('healed'))!)).toEqual([{ atMs: 0, files: 'heal.wav' }]);
    const custom = unitType();
    custom.setAttribute('healed_sound', 'mermen-hit.ogg');
    expect(animationSoundCues(parseUnitAnimations(custom).find((a) => a.events.includes('healed'))!)).toEqual([{ atMs: 0, files: 'mermen-hit.ogg' }]);
  });

  it('a poison animation plays the poison sound', () => {
    const cfg = new WmlConfig();
    cfg.addChild('poison_anim').addChild('frame').setAttribute('image', 'a.png:100');
    const poisoned = parseUnitAnimations(cfg).find((a) => a.events.includes('poisoned'))!;
    expect(animationSoundCues(poisoned)).toEqual([{ atMs: 0, files: 'poison.ogg' }]);
  });

  it("a frame's own sound= starts when that frame does; the animation-wide sound= covers frames without one", () => {
    const cfg = new WmlConfig();
    const anim = cfg.addChild('animation');
    anim.setAttribute('apply_to', 'standing');
    anim.setAttribute('sound', 'wide.ogg');
    const one = anim.addChild('frame');
    one.setAttribute('image', 'a.png:100');
    const two = anim.addChild('frame');
    two.setAttribute('image', 'b.png:50');
    two.setAttribute('sound', 'own.ogg');
    const three = anim.addChild('frame');
    three.setAttribute('image', 'c.png:50');
    const def = parseUnitAnimations(cfg).find((a) => a.events.includes('standing'))!;
    expect(animationSoundCues(def)).toEqual([
      { atMs: 0, files: 'wide.ogg' },
      { atMs: 100, files: 'own.ogg' },
      { atMs: 150, files: 'wide.ogg' },
    ]);
  });

  it('expands comma lists and bracket ranges for preloading', () => {
    const cfg = new WmlConfig();
    const anim = cfg.addChild('animation');
    anim.setAttribute('apply_to', 'standing');
    const frame = anim.addChild('frame');
    frame.setAttribute('image', 'a.png:100');
    frame.setAttribute('sound', 'hiss.wav,chat-[1~3].ogg');
    const def = parseUnitAnimations(cfg).find((a) => a.events.includes('standing'))!;
    expect(animationSoundFiles([def])).toEqual(['hiss.wav', 'chat-1.ogg', 'chat-2.ogg', 'chat-3.ogg']);
  });
});
