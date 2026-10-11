/**
 * Phase 27a S4: `pre advance`, `advance` and `post advance` (`advance_unit_at`, `advance_unit`).
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, runActionSequence } from '@wesnothweb2/engine';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';
import { GameSession } from './gameSession.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const deadWater1 = path.join(repoRoot, 'apps/web/public/scenarios/Dead_Water/01_Invasion.json');

/** A side-2 (AI) Spearman with the experience for one level (60: enough with any traits, far short of a second), advanced through [unstore_unit] advance=yes. */
async function advanceSpearman(events: string[]): Promise<GameSession> {
  const s = new GameSession(readScenarioSnapshot(deadWater1), { seed: 2 });
  for (const wml of events) s['eventPump'].manager.addFromWml(parseConfig(wml).child('event')!);
  await s.runStartupEvents();
  const run = (wml: string) => runActionSequence(parseConfig(wml), s['eventPump'].ctx);
  run('[unit]\nside=2\ntype=Spearman\nid=spear\nx,y=20,20\nexperience=60\n[/unit]');
  run('[store_unit]\n[filter]\nid=spear\n[/filter]\nvariable=s\n[/store_unit]\n[unstore_unit]\nvariable=s\nadvance=yes\n[/unstore_unit]');
  return s;
}

const record = (event: string) =>
  `[event]\nname=${event}\nfirst_time_only=no\n[set_variable]\nname=order\nvalue="$order|${event.replace(/ /g, '_')}($unit.type|),"\n[/set_variable]\n[/event]`;

describe('advancement events', () => {
  it('pre advance, then advance with the old type, then post advance with the new one', async () => {
    const s = await advanceSpearman([record('pre advance'), record('advance'), record('post advance')]);
    const spear = s.board.allUnits().find((u) => u.id === 'spear')!;
    expect(spear.type.id).not.toBe('Spearman');
    expect(s.getVariable('order')).toBe(`pre_advance(Spearman),advance(Spearman),post_advance(${spear.type.id}),`);
  });

  it('an advance event that takes the experience away stops the advancement', async () => {
    const s = await advanceSpearman([
      '[event]\nname=advance\n[modify_unit]\n[filter]\nid=spear\n[/filter]\nexperience=0\n[/modify_unit]\n[/event]',
      record('post advance'),
    ]);
    const spear = s.board.allUnits().find((u) => u.id === 'spear')!;
    expect(spear.type.id).toBe('Spearman');
    expect(s.getVariable('order')).toBeUndefined();
  });

  it('a pre advance event that removes the unit stops it before any choice', async () => {
    const s = await advanceSpearman(['[event]\nname=pre advance\n[kill]\nid=spear\n[/kill]\n[/event]', record('advance')]);
    expect(s.board.allUnits().some((u) => u.id === 'spear')).toBe(false);
    expect(s.getVariable('order')).toBeUndefined();
  });
});
