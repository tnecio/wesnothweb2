/**
 * Phase 18b milestone 3 helper: plays Dead Water 1 headless (both sides by
 * the AI, or side 1 idle) and writes the result as a real Wesnoth save --
 * `[replay_start]` plus the full `[replay]` -- for the real binary to replay:
 *
 *   npx tsx packages/ui/scripts/export-replay.ts --turns 2 --seed 3 --out ~/.config/wesnoth-1.16/saves/DW-replay-probe.gz [--version 1.16.9] [--idle]
 *   xvfb-run /usr/games/wesnoth --load DW-replay-probe.gz --with-replay
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { writeWml, type GameBoardSnapshot } from '@wesnothweb2/engine';
import { GameSession } from '../src/gameSession.js';
import { toWesnothSave } from '../src/save/wesnothSave.js';

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const snapshot = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/public/scenarios/01_Invasion.json'), 'utf8')) as GameBoardSnapshot;

const turns = Number(arg('turns', '2'));
const session = new GameSession(snapshot, { seed: Number(arg('seed', '3')) });
if (!args.includes('--idle')) session.board.getTeam(1)!.controller = 'ai';
await session.runStartupEvents();
if (!args.includes('--idle')) session.playAiSide(1, []);
await session.endTurn(turns * 2);

const save = session.toSaveData();
// --prefix N: keep only the first N recorded commands (to find where a real
// replay first diverges), and write this port's own state after them.
// --until <kind>: the same, cut just after the first command of that kind.
const prefix = args.includes('--prefix')
  ? Number(arg('prefix', '0'))
  : args.includes('--until')
    ? save.replay!.commands.findIndex((r) => r.command.kind === arg('until', 'attack')) + 1
    : null;
let stateAfter = session;
if (prefix !== null) {
  save.replay!.commands = save.replay!.commands.slice(0, prefix);
  const replay = GameSession.forReplay(snapshot, save)!;
  if (!args.includes('--idle')) replay.board.getTeam(1)!.controller = 'ai';
  for (const rec of save.replay!.commands) replay.replayCommand(rec);
  stateAfter = replay;
}
const cfg = toWesnothSave(save, snapshot, { wesnothId: 'Dead_Water', name: 'Dead Water', abbrev: 'DW', define: 'CAMPAIGN_DEAD_WATER' }, { version: arg('version', '1.16.9') });
const out = arg('out', path.join(process.env.HOME ?? '.', '.config/wesnoth-1.16/saves/DW-replay-probe.gz'));
fs.writeFileSync(out, gzipSync(writeWml(cfg) + '\n', { level: 9 }));
const kinds = new Map<string, number>();
for (const r of save.replay!.commands) kinds.set(r.command.kind, (kinds.get(r.command.kind) ?? 0) + 1);
console.log(`wrote ${out}: turn ${save.turnNumber}, ${save.replay!.commands.length} commands ${JSON.stringify(Object.fromEntries(kinds))}`);
fs.writeFileSync(out.replace(/\.gz$/, '.state.txt'), stateAfter.describeState());
