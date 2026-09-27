/**
 * Phase 18c: compares a save written by the real Wesnoth binary (e.g. after
 * `--with-replay` of a game exported by `export-replay.ts`) against the
 * `.state.txt` this port wrote for the same game, line by line
 * (`describeState`, statuses ignored):
 *
 *   npx tsx packages/ui/scripts/compare-real-save.ts <real-save.gz> <port.state.txt>
 *
 * Known, expected differences: facings the real game draws from its
 * unsynced RNG or sets in the recruit animation, and moves an AI
 * `stop_unit` took (upstream never records it, so a real replay keeps them).
 */
import * as fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseConfig, type GameBoardSnapshot } from '@wesnothweb2/engine';
import { GameSession } from '../src/gameSession.js';
import { fromWesnothSave } from '../src/save/wesnothSave.js';
const [savePath, statePath] = process.argv.slice(2);
const snapshot = JSON.parse(fs.readFileSync('apps/web/public/scenarios/Dead_Water/01_Invasion.json', 'utf8')) as GameBoardSnapshot;
const { save } = fromWesnothSave(parseConfig(gunzipSync(fs.readFileSync(savePath!)).toString('utf8')));
const s = GameSession.fromSaveData(snapshot, save);
const real = s.describeState().split('\n');
const ours = fs.readFileSync(statePath!, 'utf8').split('\n');
const drop = (l: string) => l.replace(/ st=\[.*\]/, '');
const a = new Set(ours.map(drop)), b = new Set(real.map(drop));
for (const l of ours) if (!b.has(drop(l))) console.log('ours only:', l);
for (const l of real) if (!a.has(drop(l))) console.log('real only:', l);
console.log(`${ours.length} vs ${real.length} lines`);
