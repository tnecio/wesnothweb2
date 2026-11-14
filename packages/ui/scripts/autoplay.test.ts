/**
 * Plays whole campaigns headlessly, the AI on every side (the player's too), to see whether their scenarios can be
 * played through: each from the campaign's first scenario on, with the carryover a player gets (units, gold,
 * variables), at the easiest difficulty. Dialogue takes the default answer, a campaign's own dialogs their first
 * button. A scenario the AI does not win is recorded and then counted as won, so the rest of the campaign is played
 * with the carryover it expects.
 *
 * Skipped unless AUTOPLAY is set (not part of the test suite):
 *
 *   AUTOPLAY=The_South_Guard,Liberty AUTOPLAY_OUT=autoplay.jsonl npx vitest run scripts/autoplay.test.ts   (in packages/ui)
 *   AUTOPLAY=all ...                                     every mainline campaign
 *   AUTOPLAY=The_South_Guard AUTOPLAY_FROM=05a_The_Long_March ...   from that scenario on (no carryover into it)
 *   AUTOPLAY_ONLY=1 ...                                  just that one scenario
 *
 * Each scenario appends one JSON line to AUTOPLAY_OUT: the result (`victory`, `defeat`, `turn-limit`, `timeout`,
 * `crash`), turns played, seconds, and the errors and unsupported-WML warnings logged.
 */
import { describe, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';
import { GameSession } from '../src/gameSession.js';
import { runFlow, type Flow, type Responder } from '@wesnothweb2/engine';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scenariosDir = path.join(repoRoot, 'apps/web/public/scenarios');
const campaignsFile = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/public/campaigns.json'), 'utf8')) as
  | { campaigns: Array<{ id: string; firstScenario: string; assetDir: string }> }
  | Array<{ id: string; firstScenario: string; assetDir: string }>;
const campaignsJson = Array.isArray(campaignsFile) ? campaignsFile : campaignsFile.campaigns;
const scenarioLists = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/scenario-list.json'), 'utf8')) as Record<string, string[]>;
const wanted = process.env['AUTOPLAY'] ?? '';
const startAt = process.env['AUTOPLAY_FROM'] ?? '';
const onlyOne = process.env['AUTOPLAY_ONLY'] === '1';
const out = process.env['AUTOPLAY_OUT'] ?? path.join(repoRoot, 'autoplay.jsonl');
/** Wall-clock budget for one scenario, minutes. */
const SCENARIO_MINUTES = Number(process.env['AUTOPLAY_MINUTES'] ?? 25);

const campaigns = campaignsJson.filter((c) => !c.id.startsWith('synthetic') && (wanted === 'all' || wanted.split(',').includes(c.assetDir) || wanted.split(',').includes(c.id)));

interface ScenarioResult {
  campaign: string;
  scenario: string;
  result: 'victory' | 'defeat' | 'turn-limit' | 'timeout' | 'crash' | string;
  turns: number;
  seconds: number;
  problems: string[];
  error?: string;
}

function record(r: ScenarioResult): void {
  fs.appendFileSync(out, JSON.stringify(r) + '\n');
  console.log(`${r.campaign}/${r.scenario}: ${r.result} in ${r.turns} turns, ${r.seconds} s${r.problems.length ? `, ${r.problems.length} problem(s)` : ''}${r.error ? ` -- ${r.error}` : ''}`);
}

/** Ends `session` as won: the result, then the end-of-scenario events a won scenario fires. */
function forceVictory(session: GameSession): void {
  const s = session as unknown as { scenarioResult: string; scenarioEndEventsFired: boolean; scenarioEndFlow: () => Flow; collectResponder: Responder };
  s.scenarioResult = 'victory';
  s.scenarioEndEventsFired = false;
  try {
    runFlow(s.scenarioEndFlow(), s.collectResponder);
  } catch (e) {
    console.log(`forced victory's end events failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const yieldNow = () => new Promise((resolve) => setTimeout(resolve, 0));

async function playScenario(session: GameSession, campaign: string, scenario: string, problems: string[]): Promise<ScenarioResult> {
  const started = Date.now();
  const elapsed = () => Math.round((Date.now() - started) / 1000);
  try {
    session.interactionHost = {
      async handle(interaction) {
        if (interaction.kind === 'guiDialog') return { value: 1 };
        if (interaction.kind === 'message' && interaction.options.length > 0) {
          // A tutorial waits for moves the AI does not make: its "skip" option where there is one, else the first.
          const skip = interaction.options.findIndex((o) => /skip/i.test(JSON.stringify(o)));
          return { value: skip >= 0 ? skip + 1 : 1 };
        }
        return {};
      },
    };
    await session.runStartupEvents();
    // The player's side stays `human` (the end-of-level check counts human sides: with none, any end is a defeat),
    // and the AI plays it like the others.
    // Read each time: events change the limit ([modify_turns]); with none, at most 60 turns.
    const limit = () => session.turnLimit ?? 60;
    for (let guard = 0; guard < 5000 && !session.scenarioResult && session.turnNumber <= limit() + 1; guard++) {
      if (Date.now() - started > SCENARIO_MINUTES * 60_000) {
        return { campaign, scenario, result: 'timeout', turns: session.turnNumber, seconds: elapsed(), problems };
      }
      session.playAiSide(session.activeSide, []);
      if (session.scenarioResult) break;
      await session.endTurn(0);
      await yieldNow();
    }
    const result = session.scenarioResult ?? (session.turnNumber > limit() ? 'turn-limit' : 'stalled');
    return { campaign, scenario, result, turns: session.turnNumber, seconds: elapsed(), problems };
  } catch (e) {
    return { campaign, scenario, result: 'crash', turns: session.turnNumber, seconds: elapsed(), problems, error: e instanceof Error ? `${e.message} ${e.stack?.split('\n')[1]?.trim() ?? ''}` : String(e) };
  }
}

describe.skipIf(!wanted)('autoplay', () => {
  for (const campaign of campaigns) {
    it(campaign.id, async () => {
      const dir = path.join(scenariosDir, campaign.assetDir);
      const seen = new Set<string>();
      let scenarioId: string | null = startAt || campaign.firstScenario;
      let previous: GameSession | null = null;
      while (scenarioId && !seen.has(scenarioId)) {
        seen.add(scenarioId);
        const file = path.join(dir, `${scenarioId}.json`);
        if (!fs.existsSync(file)) {
          record({ campaign: campaign.id, scenario: scenarioId, result: 'crash', turns: 0, seconds: 0, problems: [], error: 'no snapshot for the next scenario' });
          break;
        }
        const problems: string[] = [];
        const options = {
          seed: 1,
          onLog: (level: string, message: string) => {
            if (level === 'error' || (level === 'warn' && /not supported|not implemented|extension point|unknown/i.test(message))) {
              if (problems.length < 20) problems.push(`${level}: ${message.slice(0, 300)}`);
            }
          },
        };
        let session: GameSession;
        try {
          session = previous ? GameSession.startNextScenario(previous, readScenarioSnapshot(file), options) : new GameSession(readScenarioSnapshot(file), options);
        } catch (e) {
          record({ campaign: campaign.id, scenario: scenarioId, result: 'crash', turns: 0, seconds: 0, problems, error: `starting: ${e instanceof Error ? e.message : String(e)}` });
          break;
        }
        const result = await playScenario(session, campaign.id, scenarioId, problems);
        record(result);
        // On to the next scenario as after a victory, whatever happened here -- through the game's own end of a won
        // scenario (`scenarioEndFlow`: local_victory, victory, scenario_end), whose events store what the next
        // scenario brings back (The Rise of Wesnoth 5 stores the Lady at its victory).
        if (session.scenarioResult !== 'victory') forceVictory(session);
        let next = session.nextScenarioId;
        if (next && (next === scenarioId || seen.has(next))) {
          // The next scenario is chosen in play ([endlevel] next_scenario=, as Choice in the Fog's alliance), which a
          // forced win does not do: on to the campaign's next scenario in its list instead.
          const order = scenarioLists[campaign.assetDir] ?? [];
          const after = order.slice(order.indexOf(scenarioId) + 1).find((id) => !seen.has(id)) ?? null;
          record({ campaign: campaign.id, scenario: scenarioId, result: 'branch', turns: 0, seconds: 0, problems: [], error: `next_scenario=${next} is chosen in play; going on to ${after ?? 'nothing'} (the list's next)` });
          next = after;
        }
        scenarioId = onlyOne ? null : next;
        previous = session;
      }
    }, 24 * 60 * 60_000);
  }
});
