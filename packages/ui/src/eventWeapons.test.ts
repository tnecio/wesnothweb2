/**
 * Phase 27a S2: an attack event's weapons (`attack::fire_event_impl`): `[filter_attack]`/`[filter_second_attack]`
 * match them, `$weapon`/`$second_weapon` show them; an event's `[filter_side]` matches the side whose turn it is.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdjacentTiles, parseConfig, runActionSequence } from '@wesnothweb2/engine';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';
import { GameSession } from './gameSession.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const deadWater1 = path.join(repoRoot, 'apps/web/public/scenarios/Dead_Water/01_Invasion.json');

const counter = (name: string, filter: string) => `[event]
name=attack
first_time_only=no
${filter}
[set_variable]
name=${name}
add=1
[/set_variable]
[/event]`;

async function fight(events: string[]): Promise<GameSession> {
  const s = new GameSession(readScenarioSnapshot(deadWater1), { seed: 4 });
  for (const wml of events) s['eventPump'].manager.addFromWml(parseConfig(wml).child('event')!);
  await s.runStartupEvents();
  const kai = s.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
  const hex = getAdjacentTiles(kai.location).find((l) => s.board.map.onBoard(l) && !s.board.unitAt(l))!;
  const run = (wml: string) => runActionSequence(parseConfig(wml), s['eventPump'].ctx);
  run(`[unit]\nside=2\ntype=Skeleton Archer\nid=target\nx,y=${hex.wmlX},${hex.wmlY}\n[/unit]`);
  // Kai's only weapon is his melee scepter; the Skeleton Archer answers with its melee fist.
  run(`[do_command]\n[attack]\nweapon=0\n[source]\nx,y=${kai.location.wmlX},${kai.location.wmlY}\n[/source]\n[destination]\nx,y=${hex.wmlX},${hex.wmlY}\n[/destination]\n[/attack]\n[/do_command]`);
  return s;
}

describe('attack events carry their weapons', () => {
  it('[filter_attack] matches the attacker\'s weapon, and no other', async () => {
    const s = await fight([
      counter('scepter', '[filter_attack]\nname=scepter\n[/filter_attack]'),
      counter('trident', '[filter_attack]\nname=trident\n[/filter_attack]'),
      counter('melee', '[filter_attack]\nrange=melee\n[/filter_attack]'),
    ]);
    expect(s.getVariable('scepter')).toBe(1);
    expect(s.getVariable('melee')).toBe(1);
    expect(s.getVariable('trident')).toBeUndefined();
  });

  it('[filter_second_attack] matches the defender\'s', async () => {
    const s = await fight([
      counter('fist', '[filter_second_attack]\nname=fist\n[/filter_second_attack]'),
      counter('bow', '[filter_second_attack]\nname=bow\n[/filter_second_attack]'),
    ]);
    expect(s.getVariable('fist')).toBe(1);
    expect(s.getVariable('bow')).toBeUndefined();
  });

  it('$weapon and $second_weapon hold the two weapons while the handler runs, and are gone after', async () => {
    const s = await fight([
      `[event]\nname=attack\n[set_variable]\nname=seen\nvalue="$weapon.name|/$second_weapon.name|/$weapon.range|"\n[/set_variable]\n[/event]`,
    ]);
    expect(s.getVariable('seen')).toBe('scepter/fist/melee');
    expect(s.getVariable('weapon.name')).toBeUndefined();
  });

  it('attack end carries the same weapons', async () => {
    const s = await fight([`[event]\nname=attack end\n[filter_attack]\nname=scepter\n[/filter_attack]\n[set_variable]\nname=ended\nvalue=yes\n[/set_variable]\n[/event]`]);
    expect(s.getVariable('ended')).toBe(true);
  });
});

describe('[filter_side] on an event', () => {
  it('runs the handler only on the matching side\'s turn', async () => {
    const s = new GameSession(readScenarioSnapshot(deadWater1), { seed: 1 });
    s['eventPump'].manager.addFromWml(
      parseConfig('[event]\nname=side turn\nfirst_time_only=no\n[filter_side]\nside=2\n[/filter_side]\n[set_variable]\nname=side2_turns\nadd=1\n[/set_variable]\n[/event]').child('event')!,
    );
    await s.runStartupEvents();
    await s.endTurn();
    await s.endTurn();
    // Two side-2 turns have started, and three side-1 turns, which must not count.
    expect(s.getVariable('side2_turns')).toBe(2);
  });
});
