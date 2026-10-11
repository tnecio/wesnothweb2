/**
 * Phase 27a S1: `[modify_side]` as `modify_side.lua` -- the sides `utils.get_sides` names, every key -- and a
 * side's changes surviving a save.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, runActionSequence } from '@wesnothweb2/engine';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';
import { GameSession } from './gameSession.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const deadWater1 = path.join(repoRoot, 'apps/web/public/scenarios/Dead_Water/01_Invasion.json');

async function session(): Promise<GameSession> {
  const s = new GameSession(readScenarioSnapshot(deadWater1), { seed: 1 });
  await s.runStartupEvents();
  return s;
}

/** Runs WML action tags as an event body would. */
function run(s: GameSession, wml: string): void {
  runActionSequence(parseConfig(wml), s['eventPump'].ctx);
}

describe('[modify_side] (modify_side.lua)', () => {
  it('a side list changes exactly those sides -- never the player, as side=2,3 used to (HttT 42)', async () => {
    const s = await session();
    const player = s.board.getTeam(1)!;
    const before = { income: player.income, recruit: [...player.canRecruit] };
    run(s, '[modify_side]\nside=2,3,4\nincome=10\nrecruit=Goblin Spearman,Orcish Grunt\n[/modify_side]');
    expect(player.income).toBe(before.income);
    expect([...player.canRecruit]).toEqual(before.recruit);
    expect(s.board.getTeam(2)!.income).toBe(10);
    expect([...s.board.getTeam(2)!.canRecruit]).toEqual(['Goblin Spearman', 'Orcish Grunt']);
  });

  it('[filter_side] picks the sides; the tag\'s own team_name= is the new value, not a filter', async () => {
    const s = await session();
    const enemyTeam = s.board.getTeam(2)!.teamName;
    run(s, `[modify_side]\n[filter_side]\nteam_name=${enemyTeam}\n[/filter_side]\nteam_name=renamed\n[/modify_side]`);
    expect(s.board.getTeam(2)!.teamName).toBe('renamed');
    expect(s.board.getTeam(1)!.teamName).not.toBe('renamed');
  });

  it('without side= or [filter_side] it changes every side, as an empty side filter matches all', async () => {
    const s = await session();
    run(s, '[modify_side]\nvillage_gold=3\n[/modify_side]');
    for (const t of s.board.teams()) expect(t.incomePerVillage).toBe(3);
  });

  it('takes fog=, shroud=, hidden=, colour, flag, vision sharing and the end-turn question', async () => {
    const s = await session();
    run(s, '[modify_side]\nside=1\nfog=yes\nshroud=yes\nhidden=yes\ncolor=purple\nflag=flags/ship-flag.png\nflag_icon=flags/ship-flag-icon.png\nshare_vision=none\nsuppress_end_turn_confirmation=yes\nvillage_support=2\ndefeat_condition=always\n[/modify_side]');
    const t = s.board.getTeam(1)!;
    expect([t.fog.enabled, t.shroud.enabled, t.hidden]).toEqual([true, true, true]);
    expect([t.color, t.flag, t.flagIcon, t.shareVision]).toEqual(['purple', 'flags/ship-flag.png', 'flags/ship-flag-icon.png', 'none']);
    expect([t.suppressEndTurnConfirmation, t.supportPerVillage, t.defeatCondition]).toEqual([true, 2, 'always']);
    run(s, '[modify_side]\nside=1\nshare_maps=yes\nshare_view=no\n[/modify_side]');
    expect(t.shareVision).toBe('shroud');
  });

  it('[set_variable] and [variables] act on the side\'s own variables', async () => {
    const s = await session();
    run(s, '[modify_side]\nside=2\n[set_variable]\nname=morale\nvalue=5\n[/set_variable]\n[/modify_side]');
    expect(s.board.getTeam(2)!.variables?.getNumber('morale')).toBe(5);
    run(s, '[modify_side]\nside=2\n[variables]\nmood=grim\n[/variables]\n[/modify_side]');
    expect(s.board.getTeam(2)!.variables?.getString('mood')).toBe('grim');
    expect(s.board.getTeam(2)!.variables?.hasAttribute('morale')).toBe(false);
  });

  it('a side\'s changes survive a save and a load (team::write)', async () => {
    const s = await session();
    run(s, '[modify_side]\nside=2\nteam_name=pirates\nuser_team_name=Pirates\nincome=7\nfog=yes\nhidden=yes\nrecruit=Skeleton\ncontroller=human\n[/modify_side]');
    run(s, '[allow_recruit]\nside=1\ntype=Mermaid Initiate\n[/allow_recruit]');
    const loaded = GameSession.fromSaveData(readScenarioSnapshot(deadWater1), JSON.parse(JSON.stringify(s.toSaveData())));
    const t = loaded.board.getTeam(2)!;
    expect([t.teamName, t.userTeamName, t.income, t.fog.enabled, t.hidden, [...t.canRecruit], t.controller]).toEqual(['pirates', 'Pirates', 7, true, true, ['Skeleton'], 'human']);
    expect(loaded.board.getTeam(1)!.canRecruit.has('Mermaid Initiate')).toBe(true);
  });
});
