import { describe, expect, it } from 'vitest';
import { loadRealContent } from '../helpers/realContent.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { EventManager, EventPump } from '../../src/events/pump.js';
import { VariableStore } from '../../src/events/variables.js';
import { parseWml } from '../../src/wml/index.js';
import {
  DISTANCE_SILENT,
  distanceToVolumeIndex,
  soundSourceFromConfig,
  soundSourceToConfig,
  volumeIndexToGain,
} from '../../src/audio/soundSources.js';

const content = loadRealContent();

function run(body: string) {
  const board = new GameBoard(content.map(['1 Gg, Gg', 'Gg, 2 Gg']));
  board.addTeam(new Team(1, { gold: 100, teamName: 'good' }));
  board.addTeam(new Team(2, { gold: 75, teamName: 'bad' }));
  const manager = new EventManager();
  manager.addFromWml(parseWml(`[event]\nname=probe\n${body}\n[/event]`).child('event')!);
  const pump = new EventPump(manager, { board, variables: new VariableStore(), resolveType: (id) => content.unitType(id) });
  const logs: string[] = [];
  pump.ctx.log = (level, message) => logs.push(`${level}: ${message}`);
  const volumes: { music?: number; sound?: number }[] = [];
  pump.ctx.onVolume = (scale) => volumes.push(scale);
  pump.fire('probe');
  return { pump, logs, volumes };
}

describe('sourcespec', () => {
  it('reads upstream\'s defaults', () => {
    const spec = soundSourceFromConfig(parseWml('[s]\nid=fire\nsounds=fire.ogg\n[/s]').child('s')!);
    expect(spec).toMatchObject({ id: 'fire', sounds: 'fire.ogg', delayMs: 1000, chance: 100, loop: 0, fullRange: 3, fadeRange: 14, checkFogged: true, checkShrouded: true });
    expect(spec.locations).toEqual([]);
  });

  it('reads x/y as parallel 1-based lists, and writes them back', () => {
    const wml = '[s]\nid=fire\nsounds=a.ogg,b.ogg\ndelay=5000\nchance=20\nloop=-1\nfull_range=1\nfade_range=8\ncheck_fogged=no\ncheck_shrouded=no\nx=3,7\ny=4,9\n[/s]';
    const spec = soundSourceFromConfig(parseWml(wml).child('s')!);
    expect(spec.locations.map((l) => [l.x, l.y])).toEqual([[2, 3], [6, 8]]);
    expect(spec).toMatchObject({ delayMs: 5000, chance: 20, loop: -1, fullRange: 1, fadeRange: 8, checkFogged: false, checkShrouded: false });
    const written = soundSourceToConfig(spec);
    expect(written.getString('x')).toBe('3,7');
    expect(written.getString('y')).toBe('4,9');
    expect(soundSourceFromConfig(written)).toEqual(spec);
  });

  it('ignores locations whose x and y lists do not match in length', () => {
    const spec = soundSourceFromConfig(parseWml('[s]\nid=a\nsounds=a.ogg\nx=1,2\ny=1\n[/s]').child('s')!);
    expect(spec.locations).toEqual([]);
  });
});

describe('the distance curve (positional_source::calculate_volume, Mix_SetDistance)', () => {
  it('is full within the range, fades linearly over the fade range, silent beyond', () => {
    expect(distanceToVolumeIndex(0, 3, 14)).toBe(0);
    expect(distanceToVolumeIndex(3, 3, 14)).toBe(0);
    expect(distanceToVolumeIndex(10, 3, 14)).toBe(Math.trunc((7 / 14) * DISTANCE_SILENT));
    expect(distanceToVolumeIndex(17, 3, 14)).toBe(DISTANCE_SILENT);
    expect(distanceToVolumeIndex(40, 3, 14)).toBeGreaterThanOrEqual(DISTANCE_SILENT);
  });

  it('is silent past the full range when there is no fade range', () => {
    expect(distanceToVolumeIndex(4, 3, 0)).toBe(DISTANCE_SILENT);
    expect(distanceToVolumeIndex(3, 3, 0)).toBe(0);
  });

  it('maps a distance value to a linear gain', () => {
    expect(volumeIndexToGain(0)).toBe(1);
    expect(volumeIndexToGain(DISTANCE_SILENT)).toBe(0);
    expect(volumeIndexToGain(127.5)).toBeCloseTo(0.5, 5);
    expect(volumeIndexToGain(999)).toBe(0);
  });
});

describe('[sound_source] and [remove_sound_source]', () => {
  it('adds sources, replaces one with the same id, and removes a comma list', () => {
    const { pump } = run(
      '[sound_source]\nid=a\nsounds=one.ogg\n[/sound_source]\n[sound_source]\nid=b\nsounds=two.ogg\n[/sound_source]\n[sound_source]\nid=a\nsounds=three.ogg\nchance=10\n[/sound_source]',
    );
    expect(pump.ctx.soundSources.all().map((s) => `${s.id}:${s.sounds}:${s.chance}`)).toEqual(['a:three.ogg:10', 'b:two.ogg:100']);
    pump.ctx.registry.get('remove_sound_source')!(parseWml('[r]\nid=a, b\n[/r]').child('r')!, pump.ctx);
    expect(pump.ctx.soundSources.all()).toEqual([]);
  });

  it('writes the sources in id order, as upstream walks its map', () => {
    const { pump } = run('[sound_source]\nid=zebra\nsounds=z.ogg\n[/sound_source]\n[sound_source]\nid=apple\nsounds=a.ogg\n[/sound_source]');
    expect(pump.ctx.soundSources.write().map((c) => c.getString('id'))).toEqual(['apple', 'zebra']);
  });

  it('reports a missing id', () => {
    const { pump, logs } = run('[sound_source]\nsounds=a.ogg\n[/sound_source]');
    expect(pump.ctx.soundSources.all()).toEqual([]);
    expect(logs.some((l) => l.includes('missing required id'))).toBe(true);
  });
});

describe('[volume]', () => {
  it('hands the percentages on, defaulting an unreadable one to 100', () => {
    expect(run('[volume]\nmusic=40\nsound=25\n[/volume]').volumes).toEqual([{ music: 40, sound: 25 }]);
    expect(run('[volume]\nmusic=loud\n[/volume]').volumes).toEqual([{ music: 100 }]);
  });

  it('refuses a percentage outside 0..100', () => {
    const { volumes, logs } = run('[volume]\nmusic=150\nsound=50\n[/volume]');
    expect(volumes).toEqual([{ sound: 50 }]);
    expect(logs.some((l) => l.includes('0..100'))).toBe(true);
  });
});
