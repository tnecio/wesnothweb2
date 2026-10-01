import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '@wesnothweb2/engine';
import { GameSession } from './gameSession.js';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';

/**
 * Phase 28c C1: the mainline tags several unported campaigns share, where the session takes part
 * (`[end_turn]`'s forced end of turn), on real Dead Water scenario 1.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const snapshotPath = path.join(repoRoot, 'apps/web/public/scenarios/Dead_Water/01_Invasion.json');

async function start(events: string[] = []): Promise<GameSession> {
  const session = new GameSession(readScenarioSnapshot(snapshotPath));
  for (const wml of events) session['eventPump'].manager.addFromWml(parseConfig(wml).child('event')!);
  await session.runStartupEvents();
  return session;
}

describe('[end_turn]', () => {
  it('in a moveto event: the turn is to end, the move cannot be undone, and the flag clears with the next side', async () => {
    const session = await start([`[event]
      name=moveto
      [end_turn]
      [/end_turn]
    [/event]`]);
    const kai = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    session.selectUnit(kai);
    const dest = session.reachable.find((h) => h.x !== kai.location.x || h.y !== kai.location.y)!;
    await session.handleHexClick(dest.x, dest.y);
    expect(session.endTurnForced).toBe(true);
    expect(session.canUndo).toBe(false);
    expect(session.toSaveData().endTurnForced).toBe(true);
    await session.endTurn();
    expect(session.endTurnForced).toBe(false);
    expect(session.activeSide).toBe(1);
    expect(session.turnNumber).toBe(2);
  });

  it("in the side's own turn events: that turn is skipped", async () => {
    const session = await start([`[event]
      name=side 1 turn 2
      [end_turn]
      [/end_turn]
    [/event]`]);
    await session.endTurn();
    expect(session.activeSide).toBe(1);
    expect(session.turnNumber).toBe(3);
    expect(session.endTurnForced).toBe(false);
  });

  it('survives a save and load', async () => {
    const session = await start(['[event]\nname=moveto\n[end_turn]\n[/end_turn]\n[/event]']);
    const kai = session.board.allUnits().find((u) => u.id === 'Kai Krellis')!;
    session.selectUnit(kai);
    const dest = session.reachable.find((h) => h.x !== kai.location.x || h.y !== kai.location.y)!;
    await session.handleHexClick(dest.x, dest.y);
    const loaded = GameSession.fromSaveData(readScenarioSnapshot(snapshotPath), session.toSaveData());
    expect(loaded.endTurnForced).toBe(true);
  });
});
