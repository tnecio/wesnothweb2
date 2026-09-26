import { describe, expect, it } from 'vitest';
import { WmlConfig } from '../../src/wml/config.js';
import {
  commandFromWml,
  commandToWml,
  recordedCommandToWml,
  recordedCommandsFromWml,
  Recorder,
  type RecordedCommand,
  type SyncedCommand,
} from '../../src/actions/synced.js';

describe('synced commands: WML spelling', () => {
  const samples: SyncedCommand[] = [
    { kind: 'move', steps: [{ x: 3, y: 4 }, { x: 4, y: 4 }, { x: 5, y: 5 }] },
    { kind: 'move', steps: [{ x: 0, y: 0 }, { x: 1, y: 0 }], skipSighted: 'only_ally' },
    {
      kind: 'attack',
      source: { x: 3, y: 4 },
      destination: { x: 4, y: 4 },
      weapon: 1,
      defenderWeapon: -1,
      attackerType: 'Merman Fighter',
      defenderType: 'Naga Fighter',
      attackerLevel: 1,
      defenderLevel: 1,
      turn: 2,
      tod: 'morning',
    },
    { kind: 'recruit', type: 'Mermaid Initiate', loc: { x: 9, y: 2 }, from: { x: 10, y: 2 } },
    { kind: 'recall', id: 'Gwabbo', loc: { x: 9, y: 2 }, from: { x: 10, y: 2 } },
    { kind: 'disband', id: 'Merman Fighter-17' },
    { kind: 'init_side', side: 2 },
    { kind: 'end_turn', nextSide: 3 },
    { kind: 'fire_event', raise: 'menu item bribe', source: { x: 1, y: 1 } },
    { kind: 'start' },
  ];

  it.each(samples.map((s) => [s.kind, s]))('%s survives WML and back', (_kind, command) => {
    const wml = commandToWml(command)!;
    const back = commandFromWml(wml.tag, wml.cfg);
    expect(back).toEqual(command);
  });

  it('writes upstream coordinates (1-based) and step lists', () => {
    const wml = commandToWml(samples[0]!)!;
    expect(wml.tag).toBe('move');
    expect(wml.cfg.getString('x')).toBe('4,5,6');
    expect(wml.cfg.getString('y')).toBe('5,5,6');
  });

  it('writes the command then each dependent as its own dependent=yes [command]', () => {
    const rec: RecordedCommand = {
      command: samples[2]!,
      side: 1,
      dependents: [
        { kind: 'random_seed', seed: 'e5eacb0f' },
        { kind: 'choose', value: 1, side: 1 },
      ],
    };
    const blocks = recordedCommandToWml(rec);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.getNumber('from_side')).toBe(1);
    expect(blocks[1]!.getBoolean('dependent')).toBe(true);
    expect(blocks[1]!.getString('from_side')).toBe('server');
    expect(blocks[1]!.child('random_seed')!.getString('new_seed')).toBe('e5eacb0f');
    expect(blocks[2]!.child('choose')!.getNumber('value')).toBe(1);

    const replay = new WmlConfig();
    for (const b of blocks) replay.addChild('command', b);
    const { commands, issues } = recordedCommandsFromWml(replay);
    expect(issues).toEqual([]);
    expect(commands).toEqual([{ command: rec.command, side: 1, dependents: rec.dependents }]);
  });

  it('has no WML form for the port-local stop_unit', () => {
    expect(commandToWml({ kind: 'stop_unit', loc: { x: 1, y: 1 }, movement: true, attacks: false })).toBeNull();
  });

  it('reports commands it does not execute instead of dropping them silently', () => {
    const replay = new WmlConfig();
    replay.addChild('command').addChild('speak').setAttribute('message', 'hi');
    const dep = replay.addChild('command');
    dep.setAttribute('dependent', true);
    dep.addChild('input').setAttribute('value', 2);
    const { commands, issues } = recordedCommandsFromWml(replay);
    expect(commands).toEqual([]);
    expect(issues.map((i) => i.message)).toEqual(['unsupported command [speak]', 'dependent [input] with no command before it']);
  });
});

describe('Recorder', () => {
  it('appends, cuts the last command for undo, and copies on export', () => {
    const r = new Recorder();
    r.add({ kind: 'init_side', side: 1 }, 1);
    const move = r.add({ kind: 'move', steps: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }, 1);
    move.dependents.push({ kind: 'input', value: 2, side: 1 });
    const exported = r.toJSON();
    expect(r.cutLast()).toBe(move);
    expect(r.length).toBe(1);
    expect(exported).toHaveLength(2);
    expect(exported[1]!.dependents).toEqual([{ kind: 'input', value: 2, side: 1 }]);
  });
});

describe('Phase 18: [label] / [clear_labels] replay commands (replay::add_label, clear_labels)', () => {
  it('are written as non-undoable commands without from_side, and read back', () => {
    const label: RecordedCommand = { command: { kind: 'label', label: { attrs: { x: 3, y: 4, text: 'Ford', team_name: '', color: '255,0,0', side: 1 }, children: [] } }, side: 1, dependents: [] };
    const clear: RecordedCommand = { command: { kind: 'clear_labels', teamName: 'good', force: false }, side: 1, dependents: [] };
    const [labelCmd] = recordedCommandToWml(label);
    const [clearCmd] = recordedCommandToWml(clear);
    expect(labelCmd!.getBoolean('undo', true)).toBe(false);
    expect(labelCmd!.hasAttribute('from_side')).toBe(false);
    expect(labelCmd!.child('label')!.getString('text')).toBe('Ford');
    expect(clearCmd!.child('clear_labels')!.getString('team_name')).toBe('good');
    const replay = new WmlConfig();
    replay.addChild('command', labelCmd!);
    replay.addChild('command', clearCmd!);
    const { commands, issues } = recordedCommandsFromWml(replay);
    expect(issues).toEqual([]);
    expect(commands.map((c) => c.command)).toEqual([label.command, { kind: 'clear_labels', teamName: 'good', force: false }]);
  });
});
