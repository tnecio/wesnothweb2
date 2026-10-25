/**
 * Phase 33: the save `apps/web/scripts/perf-playthrough.mjs` measures -- Heir to the Throne 1 after Konrad leaves
 * home, on the big battle map (the board the slowdown was reported on). Built headlessly: the scenario's own events
 * run, Konrad walks out of the house (`enter hex` at 17,11 ends the turn; the next turn's `[replace_map]` brings the
 * battle map), and the game is saved. `--night` then sets the schedule to upstream's SECOND_WATCH (the darkest
 * default time), so the time-of-day lighting runs too.
 *
 *   npx tsx packages/ui/scripts/build-perf-fixture.ts [--night]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Location, parseConfig, runActionSequence } from '@wesnothweb2/engine';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';
import { GameSession } from '../src/gameSession.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const night = process.argv.includes('--night');
const snapshot = readScenarioSnapshot(path.join(repoRoot, 'apps/web/public/scenarios/Heir_To_The_Throne/01_The_Elves_Besieged.json'));
const session = new GameSession(snapshot, { seed: 33 });
await session.runStartupEvents();

// The opening already swaps in the small home map; the battle map is the wide one (56 hexes).
const onBattleMap = () => session.board.map.w() > 40;
const konrad = () => session.board.allUnits().find((u) => u.id === 'Konrad')!;
const exit = Location.fromWml(17, 11);
for (let tries = 0; tries < 8 && !onBattleMap(); tries++) {
  const k = konrad();
  k.movesLeft = 99;
  session.selectUnit(k);
  await session.handleHexClick(exit.x, exit.y);
  if (!onBattleMap()) await session.endTurn();
}
if (!onBattleMap()) throw new Error(`the battle map never came (Konrad at ${konrad().location.wmlX},${konrad().location.wmlY}, map ${session.board.map.w()}x${session.board.map.h()})`);
if (night) {
  // `{SECOND_WATCH}` from data/core/macros/schedules.cfg, as one [replace_schedule].
  runActionSequence(
    parseConfig('[replace_schedule]\n[time]\nid=second_watch\nname=Second Watch\nimage=misc/time-schedules/default/schedule-secondwatch.png\nlawful_bonus=-25\nred=-75\ngreen=-45\nblue=-13\n[/time]\n[/replace_schedule]'),
    session['eventPump'].ctx,
  );
  if (session.currentTimeOfDay.id !== 'second_watch') throw new Error(`the schedule did not change (${session.currentTimeOfDay.id})`);
}
const out = path.join(repoRoot, `apps/web/scripts/fixtures/perf-httt1-battle${night ? '-night' : ''}.json.gz`);
const data = { ...session.toSaveData(), campaignId: 'heir_to_the_throne', scenarioName: night ? 'Perf: battle map, night' : 'Perf: battle map' };
fs.writeFileSync(out, zlib.gzipSync(JSON.stringify(data)));
console.log(`${path.relative(repoRoot, out)}: turn ${session.turnNumber}, ${session.currentTimeOfDay.id}, ${session.board.allUnits().length} units, map ${session.board.map.w()}x${session.board.map.h()}, ${fs.statSync(out).size} bytes`);
