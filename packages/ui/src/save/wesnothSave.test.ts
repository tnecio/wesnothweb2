import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WmlConfig, parseConfig, writeWml, type GameBoardSnapshot } from '@wesnothweb2/engine';
import { GameSession } from '../gameSession.js';
import { fromWesnothSave, toWesnothSave, type WesnothCampaignInfo } from './wesnothSave.js';

/**
 * Both directions against a **real** save file written by the real game --
 * see `fixtures/README.md` for what it is and why it is committed as-is.
 *
 * The round-trip test is the one that matters for the user's requirement
 * ("keeping all fields the original Wesnoth expects in a save file"): it
 * re-exports an imported save and fails naming any tag or attribute the
 * original had that ours does not. Without the `wesnothExtras`
 * pass-through, that test is what catches the loss.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const fixturePath = path.join(here, 'fixtures/dead-water-1-autosave-1.16.9.gz');
const snapshotPath = path.join(repoRoot, 'apps/web/public/scenarios/01_Invasion.json');

function loadRealSave(): WmlConfig {
  return parseConfig(zlib.gunzipSync(fs.readFileSync(fixturePath)).toString('utf8'));
}

function loadSnapshot(): GameBoardSnapshot {
  return JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as GameBoardSnapshot;
}

const DEAD_WATER: WesnothCampaignInfo = {
  wesnothId: 'Dead_Water',
  name: 'Dead Water',
  abbrev: 'DW',
  define: 'CAMPAIGN_DEAD_WATER',
  difficulty: 'NORMAL',
};

describe('fromWesnothSave (importing a real 1.16.9 Wesnoth save)', () => {
  const original = loadRealSave();
  const imported = fromWesnothSave(original);

  it('reads the scenario, campaign and turn the file actually says', () => {
    expect(imported.version).toBe('1.16.9');
    expect(imported.label).toBe('DW-Invasion!');
    expect(imported.save.scenarioId).toBe('01_Invasion');
    expect(imported.save.campaignId).toBe('dead_water');
    // The file's own [snapshot] turn_at=1, playing_team=0 (0-based) -> side 1.
    expect(imported.save.turnNumber).toBe(original.child('snapshot')!.getNumber('turn_at'));
    expect(imported.save.activeSide).toBe(1);
  });

  it('reads both sides with their real gold and village ownership', () => {
    const sides = original.child('snapshot')!.children('side');
    expect(imported.save.teams).toHaveLength(sides.length);
    expect(imported.save.teams[0]!.gold).toBe(sides[0]!.getNumber('gold'));
    // Side 1 holds six villages in this save; they must survive as owned.
    expect(imported.save.teams[0]!.villages!.length).toBe(sides[0]!.children('village').length);
    expect(imported.save.teams[0]!.villages!.length).toBeGreaterThan(0);
  });

  it('reads every unit, including XP and the leader flag, and converts 1-based WML coordinates', () => {
    const sideCfgs = original.child('snapshot')!.children('side');
    const wmlUnits = sideCfgs.flatMap((s) => s.children('unit'));
    const onBoard = wmlUnits.filter((u) => u.hasAttribute('x'));
    expect(imported.save.units).toHaveLength(onBoard.length);
    expect(imported.save.units.length).toBeGreaterThan(5);

    const kai = imported.save.units.find((u) => u.id === 'Kai Krellis')!;
    const kaiWml = wmlUnits.find((u) => u.getString('id') === 'Kai Krellis')!;
    expect(kai.typeId).toBe('Merman Child King');
    expect(kai.canRecruit).toBe(true);
    // WML x=20,y=9 is 1-based; Location is 0-based.
    expect(kai.x).toBe(kaiWml.getNumber('x') - 1);
    expect(kai.y).toBe(kaiWml.getNumber('y') - 1);
    expect(kai.hitpoints).toBe(kaiWml.getNumber('hitpoints'));
    expect(kai.experience).toBe(kaiWml.getNumber('experience'));
    expect(kai.facing).toBe(kaiWml.getString('facing'));
    expect(kai.underlyingId).toBe(kaiWml.getNumber('underlying_id'));
  });

  it('reads per-unit traits out of [modifications]', () => {
    const withTraits = imported.save.units.filter((u) => (u.modifications?.length ?? 0) > 0);
    expect(withTraits.length).toBeGreaterThan(0);
    expect(withTraits[0]!.modifications!.some((m) => m.kind === 'trait')).toBe(true);
  });

  it('rejects a start-of-scenario save, which has no [snapshot] to resume from', () => {
    const startOnly = new WmlConfig();
    startOnly.setAttribute('campaign', 'Dead_Water');
    startOnly.addChild('carryover_sides_start');
    expect(() => fromWesnothSave(startOnly)).toThrow(/no \[snapshot\]/);
  });
});

describe('toWesnothSave round trip (the fidelity contract)', () => {
  it('re-exporting an imported real save keeps every tag and attribute the original had', () => {
    const original = loadRealSave();
    const imported = fromWesnothSave(original);
    const exported = toWesnothSave(imported.save, loadSnapshot(), DEAD_WATER);

    // Compare through text, the way the file itself round-trips.
    const reparsed = parseConfig(writeWml(exported));
    const missing = missingFrom(original, reparsed, '');
    expect(missing).toEqual([]);
  });

  it('the re-export is a real save file: it parses, and its live state is ours, not the original\'s', () => {
    const original = loadRealSave();
    const imported = fromWesnothSave(original);
    // Advance the state so the export cannot simply be echoing the input.
    const save = { ...imported.save, turnNumber: 7, activeSide: 2 };
    save.teams = save.teams.map((t) => (t.side === 1 ? { ...t, gold: 999 } : t));

    const reparsed = parseConfig(writeWml(toWesnothSave(save, loadSnapshot(), DEAD_WATER)));
    const snap = reparsed.child('snapshot')!;

    expect(snap.getNumber('turn_at')).toBe(7);
    expect(snap.getNumber('playing_team')).toBe(1); // 0-based
    expect(snap.children('side')[0]!.getNumber('gold')).toBe(999);
    // Still a complete save: the parts a loader insists on are all present.
    expect(reparsed.hasChild('replay_start')).toBe(true);
    expect(reparsed.hasChild('replay')).toBe(true);
    expect(snap.hasAttribute('map_data')).toBe(true);
    expect(snap.children('side').length).toBeGreaterThan(0);
  });

  it('exports a save made HERE (no imported extras) as a complete Wesnoth save', async () => {
    const session = new GameSession(loadSnapshot());
    await session.runStartupEvents();
    await session.endTurn();

    const exported = toWesnothSave(session.toSaveData(), loadSnapshot(), DEAD_WATER);
    const reparsed = parseConfig(writeWml(exported));

    expect(reparsed.getString('campaign')).toBe('Dead_Water');
    expect(reparsed.getString('campaign_type')).toBe('scenario');
    expect(reparsed.getString('label')).toBe('DW-Invasion!');
    // Found the hard way, by loading an export in the real 1.16.9 binary:
    // without campaign_define the game opens the save and then dies with
    // "unknown unit type: Merman Child King", because it never
    // preprocessed Dead Water's own units.
    expect(reparsed.getString('campaign_define')).toBe('CAMPAIGN_DEAD_WATER');
    expect(reparsed.hasChild('multiplayer')).toBe(true);
    expect(reparsed.hasChild('statistics')).toBe(true);
    expect(reparsed.hasChild('carryover_sides')).toBe(true);
    expect(reparsed.hasChild('replay_start')).toBe(true);

    const snap = reparsed.child('snapshot')!;
    expect(snap.getString('id')).toBe('01_Invasion');
    expect(snap.getNumber('turn_at')).toBe(session.turnNumber);
    expect(snap.hasAttribute('map_data')).toBe(true);
    // Both found by loading an export in the real 1.16.9 binary and
    // watching it replay the campaign intro instead of resuming:
    // a real [snapshot] carries no [story] (the scenario config it is
    // built from does), and `replay_pos` must say the replay's commands
    // have already been played.
    expect(snap.hasChild('story')).toBe(false);
    expect(snap.getNumber('replay_pos')).toBe(reparsed.child('replay')!.children('command').length);
    // So a unit created after the load cannot collide with an existing id.
    // The field is the highest id handed out, not the next one -- see the
    // converter's own comment.
    const highestId = Math.max(...session.board.allUnits().map((u) => u.underlyingId));
    expect(snap.getNumber('next_underlying_unit_id')).toBe(highestId);
    // Every live unit made it across, with its leader flag and position.
    const units = snap.children('side').flatMap((s) => s.children('unit'));
    expect(units.length).toBe(session.board.allUnits().length);
    const leader = units.find((u) => u.getBoolean('canrecruit', false))!;
    expect(leader.getNumber('x')).toBeGreaterThan(0);

    // A minimal but structurally real replay, per this port's documented
    // deviation (a full log is Phase 25).
    const commands = reparsed.child('replay')!.children('command');
    expect(commands.some((c) => c.hasChild('start'))).toBe(true);
    expect(commands.some((c) => c.hasChild('init_side'))).toBe(true);
  });

  it('Phase 18a: [tunnel]s survive a save, a reload and the trip through the Wesnoth format', async () => {
    const session = new GameSession(loadSnapshot());
    await session.runStartupEvents();
    session.board.tunnels.addFromWml(
      parseConfig('[tunnel]\nid=gate\n[source]\nx,y=1,1\n[/source]\n[target]\nx,y=5,5\n[/target]\n[filter]\nside=1\n[/filter]\n[/tunnel]').child('tunnel')!,
    );
    const before = session.toSaveData();
    expect(before.tunnels).toHaveLength(2); // both directions

    const reloaded = GameSession.fromSaveData(loadSnapshot(), before);
    expect(reloaded.board.tunnels.all().map((t) => [t.id, t.reversed])).toEqual([['gate', false], ['gate-__REVERSED__', true]]);

    const wml = parseConfig(writeWml(toWesnothSave(before, loadSnapshot(), DEAD_WATER)));
    const tunnels = wml.child('snapshot')!.children('tunnel');
    expect(tunnels.map((t) => [t.getString('id'), t.getBoolean('reversed'), t.getBoolean('saved')])).toEqual([
      ['gate', false, true],
      ['gate-__REVERSED__', true, true],
    ]);
    expect(fromWesnothSave(wml).save.tunnels).toHaveLength(2);
  });

  it('round-trips one of our own saves back into the same SaveGameData', async () => {
    const session = new GameSession(loadSnapshot());
    await session.runStartupEvents();
    await session.endTurn();
    const before = session.toSaveData();

    const wml = parseConfig(writeWml(toWesnothSave(before, loadSnapshot(), DEAD_WATER)));
    const after = fromWesnothSave(wml).save;

    expect(after.turnNumber).toBe(before.turnNumber);
    expect(after.activeSide).toBe(before.activeSide);
    expect(after.scenarioId).toBe(before.scenarioId);
    expect(after.units.length).toBe(before.units.length);
    expect(after.teams.map((t) => t.gold)).toEqual(before.teams.map((t) => t.gold));
    expect(after.rng).toEqual(before.rng);

    // Units survive field for field (position, hp, xp, leader flag, facing).
    const key = (u: { id: string | null; x?: number; y?: number }) => `${u.id ?? ''}@${u.x},${u.y}`;
    const beforeById = new Map(before.units.map((u) => [key(u), u]));
    for (const u of after.units) {
      const original = beforeById.get(key(u))!;
      expect(original).toBeDefined();
      expect(u.typeId).toBe(original.typeId);
      expect(u.hitpoints).toBe(original.hitpoints);
      expect(u.experience).toBe(original.experience);
      expect(u.canRecruit).toBe(original.canRecruit);
      expect(u.facing).toBe(original.facing);
    }
  });
});

/**
 * Every attribute and child tag present in `expected` but missing (or
 * different) in `actual`, as readable paths. Extra content in `actual` is
 * fine -- a re-export may legitimately add or refresh things -- so this is
 * deliberately one-directional.
 *
 * Attribute values are compared as strings because WML's own typing
 * (`config_attribute_value`) coerces `yes`/`no` and numeric-looking values
 * regardless of quoting: `1` and `"1"` are the same value to Wesnoth.
 */
function missingFrom(expected: WmlConfig, actual: WmlConfig, at: string): string[] {
  const problems: string[] = [];
  for (const key of expected.attributeNames()) {
    if (!actual.hasAttribute(key)) {
      problems.push(`${at}/${key} (missing)`);
    } else if (String(actual.get(key)) !== String(expected.get(key))) {
      problems.push(`${at}/${key} (expected ${String(expected.get(key))}, got ${String(actual.get(key))})`);
    }
  }
  const tags = new Set(expected.allChildren().map((c) => c.tag));
  for (const tag of tags) {
    const wanted = expected.children(tag);
    const got = actual.children(tag);
    if (got.length < wanted.length) {
      problems.push(`${at}/[${tag}] (expected ${wanted.length}, got ${got.length})`);
      continue;
    }
    for (let i = 0; i < wanted.length; i++) {
      problems.push(...missingFrom(wanted[i]!, got[i]!, `${at}/[${tag}]${wanted.length > 1 ? `#${i}` : ''}`));
    }
  }
  return problems;
}
