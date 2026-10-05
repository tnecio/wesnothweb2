/** Phase 24: the Unit List's rows and Rename, and `unrenamable` surviving saves and `[modify_unit]`. */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UnitStatus } from '@wesnothweb2/engine';
import { GameSession } from './gameSession.js';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const snapshotPath = path.join(repoRoot, 'apps/web/public/scenarios/Dead_Water/01_Invasion.json');

describe('Unit List (units_dialog::build_unit_list_dialog)', () => {
  it("lists the viewing side's units on the map, with their status icon", async () => {
    const session = new GameSession(readScenarioSnapshot(snapshotPath));
    await session.runStartupEvents();
    const own = session.board.allUnits().filter((u) => u.side === session.viewingSide);
    const entries = session.unitListEntries;
    expect(entries.map((e) => `${e.info.x},${e.info.y}`)).toEqual(own.map((u) => `${u.location.x},${u.location.y}`));
    expect(entries.every((e) => e.info.side === session.viewingSide)).toBe(true);
    expect(entries.every((e) => e.statusImage === null)).toBe(true);

    own[0]!.setStatus(UnitStatus.Poisoned, true);
    own[0]!.setStatus(UnitStatus.Slowed, true);
    expect(session.unitListEntries[0]!.statusImage).toBe('misc/poisoned.png');
    own[0]!.setStatus(UnitStatus.Petrified, true);
    expect(session.unitListEntries[0]!.statusImage).toBe('misc/petrified.png');
  });

  it('renames a unit on the map, unless it is unrenamable', () => {
    const session = new GameSession(readScenarioSnapshot(snapshotPath));
    const unit = session.board.allUnits().find((u) => u.side === session.viewingSide)!;
    session.renameUnitAt(unit.location.x, unit.location.y, '  Kai  ');
    expect(unit.name).toBe('Kai');
    unit.unrenamable = true;
    session.renameUnitAt(unit.location.x, unit.location.y, 'Other');
    expect(unit.name).toBe('Kai');
    expect(session.unitListEntries.find((e) => e.info.x === unit.location.x && e.info.y === unit.location.y)?.unrenamable).toBe(true);
  });

  it('unrenamable= survives a save and a reload, and the WML round trip', () => {
    const session = new GameSession(readScenarioSnapshot(snapshotPath));
    const unit = session.board.allUnits()[0]!;
    unit.unrenamable = true;
    expect(unit.toConfig().getBoolean('unrenamable', false)).toBe(true);
    const reloaded = GameSession.fromSaveData(session.snapshot, session.toSaveData());
    expect(reloaded.board.unitAt(unit.location)?.unrenamable).toBe(true);
  });
});
