/**
 * Phase 27a S8: WML that had no handler -- `[store_unit_type_ids]`, `[store_unit_defense(_on)]`,
 * `[store_relative_direction]`, `[have_side]`, `[set_variable] formula=` -- and `$( )` in a string.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, runActionSequence } from '@wesnothweb2/engine';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';
import { GameSession } from './gameSession.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const deadWater1 = path.join(repoRoot, 'apps/web/public/scenarios/Dead_Water/01_Invasion.json');

async function session(): Promise<{ s: GameSession; run: (wml: string) => void }> {
  const s = new GameSession(readScenarioSnapshot(deadWater1), { seed: 3 });
  await s.runStartupEvents();
  return { s, run: (wml) => void runActionSequence(parseConfig(wml), s['eventPump'].ctx) };
}

describe('the store tags', () => {
  it('[store_unit_type_ids] stores every type id, sorted', async () => {
    const { s, run } = await session();
    run('[store_unit_type_ids]\nvariable=ids\n[/store_unit_type_ids]');
    const ids = String(s.getVariable('ids')).split(',');
    expect(ids).toContain('Merman Fighter');
    expect(ids).toEqual([...ids].sort());
    run('[store_unit_type_ids]\n[/store_unit_type_ids]');
    expect(s.getVariable('unit_type_ids')).toBe(s.getVariable('ids'));
  });

  it('[store_unit_defense_on] stores the defense; the deprecated [store_unit_defense] the chance to be hit', async () => {
    const { s, run } = await session();
    // A merfolk: 60% defense in shallow water, 30% on flat.
    run('[store_unit_defense_on]\nid=Kai Krellis\nterrain=Ww\nvariable=water\n[/store_unit_defense_on]');
    run('[store_unit_defense_on]\nid=Kai Krellis\nterrain=Gg\nvariable=grass\n[/store_unit_defense_on]');
    run('[store_unit_defense]\nid=Kai Krellis\nterrain=Ww\n[/store_unit_defense]');
    expect([s.getVariable('water'), s.getVariable('grass'), s.getVariable('terrain_defense')]).toEqual([60, 30, 40]);
  });

  it('[store_relative_direction] stores the direction between two hexes, in both modes', async () => {
    const { s, run } = await session();
    const dir = (from: string, to: string, mode = 0) => {
      run(`[store_relative_direction]\nvariable=d\nmode=${mode}\n[source]\nx,y=${from}\n[/source]\n[destination]\nx,y=${to}\n[/destination]\n[/store_relative_direction]`);
      return s.getVariable('d');
    };
    expect(dir('5,5', '5,2')).toBe('n');
    expect(dir('5,5', '5,8')).toBe('s');
    expect(dir('5,5', '6,5')).toBe('se');
    expect(dir('5,5', '4,5')).toBe('sw');
    expect(dir('5,5', '6,4')).toBe('ne');
    expect(dir('5,5', '5,2', 1)).toBe('n');
    expect(dir('5,5', '8,5', 1)).toBe('se');
  });
});

describe('[have_side]', () => {
  it('passes when the side filter finds a side, or exactly count= of them', async () => {
    const { s, run } = await session();
    const check = (filter: string) => {
      run(`[if]\n[have_side]\n${filter}\n[/have_side]\n[then]\n[set_variable]\nname=r\nvalue=yes\n[/set_variable]\n[/then]\n[else]\n[set_variable]\nname=r\nvalue=no\n[/set_variable]\n[/else]\n[/if]`);
      return s.getVariable('r');
    };
    const sides = s.board.teams().length;
    expect(check('side=1')).toBe(true);
    expect(check('side=99')).toBe(false);
    expect(check(`count=${sides}`)).toBe(true);
    expect(check(`count=${sides + 1}`)).toBe(false);
  });
});

describe('formulas in WML', () => {
  it('[set_variable] formula= works on the value, numbers as decimals', async () => {
    const { s, run } = await session();
    run('[set_variable]\nname=n\nvalue=7\n[/set_variable]\n[set_variable]\nname=n\nformula="value * 3 + 1"\n[/set_variable]');
    expect(Number(s.getVariable('n'))).toBe(22);
    run('[set_variable]\nname=h\nvalue=7\n[/set_variable]\n[set_variable]\nname=h\nformula=value / 2\n[/set_variable]');
    expect(Number(s.getVariable('h'))).toBe(3.5);
    run("[set_variable]\nname=t\nformula=\"concatenate('abc', 'def')\"\n[/set_variable]");
    expect(s.getVariable('t')).toBe('abcdef');
  });

  it('$( ) evaluates a formula, after the variables inside it', async () => {
    const { s, run } = await session();
    run('[set_variable]\nname=count\nvalue=13\n[/set_variable]\n[set_variable]\nname=m\nvalue="$($count % 5) left"\n[/set_variable]');
    expect(s.getVariable('m')).toBe('3 left');
  });
});
