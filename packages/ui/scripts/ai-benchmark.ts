/**
 * Headless AI-vs-AI benchmark harness (Phase 29 S6). `GameSession` is
 * DOM-free, so this runs entirely under `npx tsx`, no browser needed.
 *
 * Usage:
 *   npx tsx packages/ui/scripts/ai-benchmark.ts --scenario synth_combat_02 --games 10 --seed 1 --max-turns 40
 *
 * `--scenario` is a snapshot id under `apps/web/public/scenarios/<campaignDir>/<id>.json` (found by
 * searching every campaign directory; `--campaign <dir>` disambiguates if the id exists in more than one --
 * a bare scenario id is only unique within its own campaign, e.g. Dead Water and Under the Burning Suns
 * both ship a `13_Epilogue`; build one first with `npx tsx apps/web/scripts/build-scenario-snapshot.mjs
 * <path-to.cfg>` -- see `synthetic-campaigns/combat/scenarios/
 * 02_combat_ai.cfg` for a ready-made both-sides-AI scenario). `--games N`
 * plays N independent games, seeded `--seed, --seed+1, ..., --seed+N-1`.
 * `--max-turns` bounds each game's own *scenario* turn count (not
 * `GameSession.endTurn`'s side-turn guard directly -- this script computes
 * that from the scenario's side count); a game that hits the cap without
 * either leader dying is reported as `winner: "timeout"`, not an error.
 *
 * The default AI's Lua candidate actions (`retreat_injured`/`spread_poison`/
 * `high_xp_attack`/`place_healers`/`move_to_any_enemy`, Phase 29 S7) run
 * from `wesnoth/data` as in the game; `--no-lua` leaves them out (the
 * TS-ported candidate actions only), for comparison. `luaErrors` counts the
 * errors the Lua kernel logged.
 *
 * Output: one JSON line per game, then a plain-text summary (win rate per
 * side, mean/median turns, mean ms/turn) -- meant to be diffed across runs
 * (e.g. before/after S7 lands the Lua CAs) to catch both behavioural
 * regressions (win-rate swings) and performance regressions (ms/turn).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameBoardSnapshot, AiAnimationEvent } from '@wesnothweb2/engine';
import { GameSession } from '../src/gameSession.js';
import { luaDataFiles, setLuaDataFiles } from '../src/luaData.js';
import { loadLuaDataDir } from '@wesnothweb2/lua-bridge/src/dataLua.js';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface Args {
  scenario: string;
  /** Disambiguates `scenario` when its id exists under more than one campaign directory. */
  campaign?: string;
  games: number;
  seed: number;
  maxTurns: number;
  lua: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { scenario: 'synth_combat_02', games: 10, seed: 1, maxTurns: 40, lua: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--scenario':
        args.scenario = next();
        break;
      case '--campaign':
        args.campaign = next();
        break;
      case '--games':
        args.games = Number(next());
        break;
      case '--seed':
        args.seed = Number(next());
        break;
      case '--max-turns':
        args.maxTurns = Number(next());
        break;
      case '--no-lua':
        args.lua = false;
        break;
      case '--lua':
        args.lua = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

/**
 * `scenarioId`'s snapshot, found under `campaignDir` if given, else by searching every campaign directory
 * (erroring if more than one has it -- a bare scenario id is only unique within its own campaign, e.g. Dead
 * Water and Under the Burning Suns both ship a `13_Epilogue`).
 */
export function loadSnapshot(scenarioId: string, campaignDir?: string): GameBoardSnapshot {
  const scenariosDir = path.join(repoRoot, 'apps/web/public/scenarios');
  const candidates = campaignDir
    ? [campaignDir]
    : fs.readdirSync(scenariosDir).filter((d) => fs.existsSync(path.join(scenariosDir, d, `${scenarioId}.json`)));
  if (candidates.length === 0) {
    throw new Error(
      `No snapshot for "${scenarioId}" under ${scenariosDir}. Build one first: npx tsx apps/web/scripts/build-scenario-snapshot.mjs <path-to-scenario.cfg>`,
    );
  }
  if (candidates.length > 1) {
    throw new Error(`"${scenarioId}" exists under more than one campaign (${candidates.join(', ')}); pass --campaign to pick one.`);
  }
  return readScenarioSnapshot(path.join(scenariosDir, candidates[0]!, `${scenarioId}.json`));
}

function isAiControlled(session: GameSession, side: number): boolean {
  const team = session.board.getTeam(side);
  return !!team && (team.controller === 'ai' || team.controller === 'network_ai');
}

export interface GameResult {
  readonly seed: number;
  readonly winner: number | 'draw' | 'timeout';
  readonly turns: number;
  readonly ms: number;
  readonly msPerTurn: number;
  readonly actions: number;
  readonly luaErrors: number;
}

export async function playGame(snapshot: GameBoardSnapshot, seed: number, maxTurns: number, options: { lua?: boolean } = {}): Promise<GameResult> {
  let luaErrors = 0;
  const session = new GameSession(snapshot, {
    seed,
    playerSide: 1,
    luaData: options.lua === false ? null : undefined,
    onLog: (level) => {
      if (level === 'error') luaErrors++;
    },
  });
  const numSides = session.board.teams().length;
  const start = Date.now();
  let actions = 0;

  // endTurn() only ever plays the side it advances TO, never the one it starts on -- so a from-scratch AI-vs-AI
  // session needs side 1's own first turn played explicitly (see GameSession.playAiSide's own doc comment).
  if (isAiControlled(session, session.activeSide)) {
    const anims: AiAnimationEvent[] = [];
    session.playAiSide(session.activeSide, anims);
    actions += anims.length;
  }

  // One round of side turns per call, yielding to the event loop in between: a whole game in one synchronous
  // endTurn() blocks a vitest worker for up to a minute, long enough for its RPC to the main process to time out.
  // endTurn(n) stops once it has advanced to the (n+1)th side, before playing it, so that side is played here --
  // as side 1's first turn is above -- and the game is the same as with one call.
  const budget = Math.max(1, maxTurns * numSides);
  for (let played = 0; played < budget && !session.scenarioResult; played += numSides + 1) {
    await session.endTurn(numSides);
    actions += session.lastAiAnimations?.length ?? 0;
    if (!session.scenarioResult && played + numSides + 1 < budget && isAiControlled(session, session.activeSide)) {
      const anims: AiAnimationEvent[] = [];
      session.playAiSide(session.activeSide, anims);
      actions += anims.length;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  const ms = Date.now() - start;
  const turns = session.turnNumber;
  let winner: number | 'draw' | 'timeout';
  if (session.scenarioResult === 'victory') winner = session.playerSide;
  else if (session.scenarioResult === 'defeat') winner = session.playerSide === 1 ? 2 : 1;
  else winner = 'timeout';

  return { seed, winner, turns, ms, msPerTurn: ms / Math.max(1, turns), actions, luaErrors };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.lua && !luaDataFiles()) setLuaDataFiles(loadLuaDataDir(path.join(repoRoot, 'wesnoth/data')));
  const snapshot = loadSnapshot(args.scenario, args.campaign);

  const results: GameResult[] = [];
  for (let i = 0; i < args.games; i++) {
    const seed = args.seed + i;
    const result = await playGame(snapshot, seed, args.maxTurns, { lua: args.lua });
    results.push(result);
    console.log(JSON.stringify(result));
  }

  const winCounts = new Map<string, number>();
  for (const r of results) {
    const key = String(r.winner);
    winCounts.set(key, (winCounts.get(key) ?? 0) + 1);
  }
  const turns = results.map((r) => r.turns);
  const msPerTurn = results.map((r) => r.msPerTurn);

  console.log('\n--- summary ---');
  console.log(`games: ${results.length}`);
  for (const [key, count] of [...winCounts.entries()].sort()) {
    console.log(`  winner=${key}: ${count} (${((100 * count) / results.length).toFixed(1)}%)`);
  }
  console.log(`turns: mean=${(turns.reduce((a, b) => a + b, 0) / turns.length).toFixed(1)} median=${median(turns).toFixed(1)}`);
  console.log(`ms/turn: mean=${(msPerTurn.reduce((a, b) => a + b, 0) / msPerTurn.length).toFixed(2)} median=${median(msPerTurn).toFixed(2)}`);
}

// Run only when executed directly (`npx tsx ai-benchmark.ts`), not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
