import { describe, expect, it } from 'vitest';
import { GameBoard } from '../../src/model/GameBoard.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { Location } from '../../src/model/Location.js';
import { AttackType, UnitType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { EventManager, EventPump } from '../../src/events/pump.js';
import { VariableStore } from '../../src/events/variables.js';
import { parseWml } from '../../src/wml/index.js';
import { runActionSequence } from '../../src/events/actionWml.js';

const terrainData = TerrainTypeData.fromConfigs([]);

function unitType(id: string, name: string, profile: string, image = `units/${id}.png`): UnitType {
  const moveType = MoveType.fromConfig(parseWml(''), terrainData);
  const attack = AttackType.fromConfig(parseWml(''));
  return new UnitType(id, name, '', 'neutral', 1, 30, 5, 5, 0, 1, 1, -1, 500, [], '', true, false, false, moveType, [attack], [], 2, undefined, false, '', profile, image);
}

function setup() {
  const map = GameMap.fromMapString('Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg\nGg, Gg, Gg, Gg', terrainData);
  const board = new GameBoard(map);
  board.addTeam(new Team(1, { gold: 100 }));
  board.addTeam(new Team(2, { gold: 100 }));
  const priestess = unitType('Mermaid Priestess', 'Mermaid Priestess', 'portraits/merfolk/priestess.webp');
  const netcaster = unitType('Merman Netcaster', 'Merman Netcaster', 'portraits/merfolk/netcaster.webp');
  const bat = unitType('Vampire Bat', 'Vampire Bat', 'unit_image', 'units/undead/bat-se.png');
  board.addUnit(Unit.create(priestess, 1, Location.fromWml(1, 1), { id: 'Cylanna', name: 'Cylanna', profile: 'portraits/cylanna.webp' }));
  board.addUnit(Unit.create(netcaster, 1, Location.fromWml(3, 2), { id: 'Gwabbo', name: '' }));
  board.addUnit(Unit.create(bat, 2, Location.fromWml(4, 3), { id: 'bat1' }));
  const pump = new EventPump(new EventManager(), {
    board,
    variables: new VariableStore(),
    resolveType: () => priestess,
  });
  const run = (wml: string) => {
    runActionSequence(parseWml(wml), pump.ctx);
    return pump.ctx.messages.splice(0);
  };
  return { board, run, ctx: pump.ctx };
}

describe('[message] portrait, side and caption (message.lua get_image/get_caption)', () => {
  it("uses the speaker's own profile override, name as caption, and records where it stands", () => {
    const { run } = setup();
    const [m] = run('[message]\nspeaker=Cylanna\nmessage="Hello"\n[/message]');
    expect(m).toMatchObject({
      speaker: 'Cylanna',
      portrait: 'portraits/cylanna.webp',
      leftSide: true,
      mirror: false,
      secondPortrait: '',
      title: 'Cylanna',
      speakerLocation: { x: 0, y: 0 },
      scroll: true,
      highlight: true,
    });
  });

  it("falls back to the type's profile and the type name when the unit has no profile or name", () => {
    const { run } = setup();
    const [m] = run('[message]\nspeaker=Gwabbo\nmessage="Hi"\n[/message]');
    expect(m).toMatchObject({ portrait: 'portraits/merfolk/netcaster.webp', title: 'Merman Netcaster', speakerLocation: { x: 2, y: 1 } });
  });

  it('uses the unit image scaled to 144x144 when the profile is unit_image', () => {
    const { run } = setup();
    const [m] = run('[message]\nspeaker=bat1\nmessage="Screech"\n[/message]');
    expect(m!.portrait).toBe('units/undead/bat-se.png~SCALE_SHARP(144,144)');
  });

  it('puts the portrait on the right only for ~RIGHT() or image_pos=right, never by side', () => {
    const { run } = setup();
    const messages = run(`
      [message]
        speaker=bat1
        image=portraits/undead/bat.webp
        message="enemy side, default left"
      [/message]
      [message]
        speaker=Cylanna
        image=portraits/cylanna.webp~RIGHT()
        message="right via suffix"
      [/message]
      [message]
        speaker=Cylanna
        image=portraits/cylanna.webp~RIGHT()
        image_pos=left
        message="suffix overridden"
      [/message]
      [message]
        speaker=Cylanna
        image_pos=right
        mirror=yes
        message="right via image_pos"
      [/message]`);
    expect(messages.map((m) => [m.portrait, m.leftSide, m.mirror])).toEqual([
      ['portraits/undead/bat.webp', true, false],
      ['portraits/cylanna.webp', false, false],
      ['portraits/cylanna.webp', true, false],
      ['portraits/cylanna.webp', false, true],
    ]);
  });

  it('shows no portrait for image=none, and second_image suppresses the speaker portrait', () => {
    const { run } = setup();
    const [none, second] = run(`
      [message]
        speaker=Cylanna
        image=none
        message="no portrait"
      [/message]
      [message]
        speaker=Cylanna
        second_image=portraits/gwabbo.webp
        second_mirror=yes
        message="second only"
      [/message]`);
    expect(none!.portrait).toBe('');
    expect([second!.portrait, second!.secondPortrait, second!.secondMirror]).toEqual(['', 'portraits/gwabbo.webp', true]);
  });

  it('narrator: image and caption only from the message itself, no speaker location', () => {
    const { run } = setup();
    const [m] = run('[message]\nspeaker=narrator\nimage=wesnoth-icon.png\ncaption="Narrator"\nmessage="Long ago"\n[/message]');
    expect(m).toMatchObject({ speaker: 'narrator', portrait: 'wesnoth-icon.png', title: 'Narrator', speakerLocation: undefined });
  });

  it('skips a message whose speaker is not on the map, and one whose [show_if] fails', () => {
    const { run } = setup();
    const messages = run(`
      [message]
        speaker=Nobody
        message="unseen"
      [/message]
      [message]
        speaker=Cylanna
        message="hidden"
        [show_if]
          [variable]
            name=flag
            equals=yes
          [/variable]
        [/show_if]
      [/message]
      [message]
        speaker=Cylanna
        message="shown"
        scroll=no
        highlight=no
      [/message]`);
    expect(messages.map((m) => [m.message, m.scroll, m.highlight])).toEqual([['shown', false, false]]);
  });

  it('without speaker=, the message attributes filter the speaking unit', () => {
    const { run } = setup();
    const [m] = run('[message]\nside=2\nmessage="from side 2"\n[/message]');
    expect(m!.speaker).toBe('bat1');
  });
});
