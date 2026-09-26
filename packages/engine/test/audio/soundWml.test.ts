import { describe, expect, it } from 'vitest';
import { loadRealContent } from '../helpers/realContent.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { EventManager, EventPump } from '../../src/events/pump.js';
import { VariableStore } from '../../src/events/variables.js';
import { extraHitSounds, GAME_SOUNDS } from '../../src/audio/sounds.js';
import { parseWml } from '../../src/wml/index.js';

const content = loadRealContent();

function run(body: string) {
  const board = new GameBoard(content.map(['1 Gg, Gg', 'Gg, 2 Gg']));
  board.addTeam(new Team(1, { gold: 100, teamName: 'good' }));
  board.addTeam(new Team(2, { gold: 75, teamName: 'bad' }));
  const manager = new EventManager();
  manager.addFromWml(parseWml(`[event]\nname=probe\n${body}\n[/event]`).child('event')!);
  const pump = new EventPump(manager, { board, variables: new VariableStore(), resolveType: (id) => content.unitType(id) });
  const heard: string[] = [];
  pump.ctx.onSound = (r) => heard.push(`${r.group}:${r.files}:${r.repeats}`);
  pump.fire('probe');
  return { pump, heard, errors: [] as string[] };
}

describe('[sound]', () => {
  it('asks for the named sound, once by default', () => {
    const { pump, heard } = run('[sound]\nname=ram.wav\n[/sound]');
    expect(heard).toEqual(['sound:ram.wav:0']);
    expect(pump.ctx.sounds).toEqual([{ files: 'ram.wav', repeats: 0, group: 'sound' }]);
  });

  it('repeat= adds extra plays, and a comma list is left for the player to pick from', () => {
    const { heard } = run('[sound]\nname=hiss.wav,hiss-big.wav\nrepeat=2\n[/sound]');
    expect(heard).toEqual(['sound:hiss.wav,hiss-big.wav:2']);
  });

  it('interpolates variables', () => {
    const { heard } = run('[set_variable]\nname=s\nvalue=ram.wav\n[/set_variable]\n[sound]\nname=$s\n[/sound]');
    expect(heard).toEqual(['sound:ram.wav:0']);
  });

  it('without name= logs an error and plays nothing', () => {
    const { heard } = run('[sound]\nrepeat=1\n[/sound]');
    expect(heard).toEqual([]);
  });
});

describe('extraHitSounds', () => {
  it('lists the status sounds of a hit in the order poison, slow, petrify', () => {
    expect(extraHitSounds({ poisoned: true, slowed: true, petrified: true })).toEqual([GAME_SOUNDS.poisoned, GAME_SOUNDS.slowed, GAME_SOUNDS.petrified]);
    expect(extraHitSounds({ poisoned: false, slowed: true, petrified: false })).toEqual(['slowed.wav']);
    expect(extraHitSounds({ poisoned: false, slowed: false, petrified: false })).toEqual([]);
  });
});
