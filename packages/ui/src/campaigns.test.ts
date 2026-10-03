import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameSession, type GameSessionOptions } from './gameSession.js';
import { memoryPersistentVariables } from '@wesnothweb2/engine/src/events/supportWml.js';
import { WmlConfig } from '@wesnothweb2/engine/src/wml/config.js';
import { Location } from '@wesnothweb2/engine/src/model/Location.js';
import { runFlow } from '@wesnothweb2/engine/src/events/interaction.js';
import { readScenarioSnapshot } from '@wesnothweb2/engine/src/snapshot/snapshotFiles.node.js';

/**
 * Phase 28c milestone for every campaign added in the batches (The South Guard has its own file): each
 * scenario loads and its opening events run without an error or an unsupported tag, and one scenario per
 * campaign plays to its end with the AI on every side, as `theSouthGuard.test.ts` and `replay.test.ts` do.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const scenarioList = JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/web/scenario-list.json'), 'utf8')) as Record<string, string[]>;

interface CampaignCase {
  /** The scenario played to its end, AI against AI. */
  playThrough: string;
  /**
   * Scenarios that, started on their own, miss something an earlier one carried over (a stored unit, a
   * variable): the problems that alone causes, as upstream would report them.
   */
  expectedProblems?: Record<string, readonly string[]>;
}

/** Batches B1 and B2 (`IMPLEMENTATION_PLAN.md`, Phase 28c). */
const CAMPAIGNS: Record<string, CampaignCase> = {
  The_Hammer_of_Thursagan: { playThrough: '01_At_the_East_Gate' },
  Northern_Rebirth: {
    playThrough: '01_Breaking_the_Chains',
    // Krash or Ro'Arthian lead the northern group, carried over from earlier scenarios: on its own, neither is
    // there to store, and upstream's [move_unit_fake] raises the same error.
    expectedProblems: { '13a_Showdown': ['error: [move_unit_fake] missing required type=', 'error: [move_unit_fake] missing required type='] },
  },
  Winds_of_Fate: { playThrough: '01_The_Hunt' },
  Of_Pearls_and_Pirates: {
    playThrough: '01_Pirates',
    // The naga that fled in scenario 2 comes back: on its own, the variable holds only what 4 sets on it.
    expectedProblems: { '04_Lee_Shore': ["error: [unstore_unit]: variable 'stored_naga' doesn't contain unit data"] },
  },
  Dusk_of_Dawn: { playThrough: '01_First_Steps' },
  Descent_Into_Darkness: {
    playThrough: '01_Saving_Parthyn',
    // Darken Volk, stored in scenario 5, is put back on the recall list.
    expectedProblems: { '07a_A_Small_Favor': ["error: [unstore_unit]: variable 'darken_volk_store' doesn't contain unit data"] },
  },
  The_Rise_Of_Wesnoth: {
    playThrough: '01_A_Summer_of_Storms',
    // Lady Jessene joins in 2 and travels with Haldric: on its own, a scenario has no Jessene to store, so her
    // stored copy is empty, and the [move_unit_fake]/[unit] that read its type get none.
    expectedProblems: {
      '07_Return_to_Oldwood': [
        'error: [move_unit_fake] missing required type=',
        "error: [unstore_unit]: variable 'lady_store' doesn't contain unit data",
        'error: Error occurred inside [unit]: createTypeResolver: unknown typeId ""',
      ],
      '18_A_Spy_in_the_Woods': ["error: [unstore_unit]: variable 'stored_Jessene' doesn't contain unit data"],
      '21_The_Plan': ["error: [unstore_unit]: variable 'jessica_store' doesn't contain unit data", 'error: [move_unit_fake] missing required type='],
    },
  },
  Legend_of_Wesmere: {
    playThrough: '01_The_Uprooting',
    // Landar, a hero carried over since scenario 1, is stored and put back.
    expectedProblems: { '13_News_from_the_Front': ["error: [unstore_unit]: variable 'landar_store' doesn't exist"] },
  },
  Son_Of_The_Black_Eye: { playThrough: '01_End_of_Peace' },
  Sceptre_of_Fire: {
    playThrough: '1_A_Bargain_is_Struck',
    // Alanin and Krawg, stored in earlier scenarios, come back.
    expectedProblems: {
      '2t_In_the_Dwarven_City': ["error: [unstore_unit]: variable 'changealanin' doesn't contain unit data"],
      '7_Outriding_the_Outriders': ["error: [unstore_unit]: variable 'alanin' doesn't exist"],
      Epilogue: [
        "error: [unstore_unit]: variable 'alanin' doesn't exist",
        'error: [move_unit_fake] missing required type=',
        "error: [unstore_unit]: variable 'krawg' doesn't contain unit data",
      ],
    },
  },
};

function start(campaign: string, id: string, options: GameSessionOptions = {}): { session: GameSession; problems: string[] } {
  const problems: string[] = [];
  const session = new GameSession(readScenarioSnapshot(path.join(repoRoot, 'apps/web/public/scenarios', campaign, `${id}.json`)), {
    ...options,
    onLog: (level, message) => {
      if (level === 'error' || (level === 'warn' && /not supported|not implemented|extension point/.test(message))) problems.push(`${level}: ${message}`);
    },
  });
  return { session, problems };
}

for (const [campaign, spec] of Object.entries(CAMPAIGNS)) {
  describe(campaign, () => {
    for (const id of scenarioList[campaign] ?? []) {
      it(`${id}: opens without errors`, async () => {
        const { session, problems } = start(campaign, id);
        await session.runStartupEvents();
        expect(problems).toEqual(spec.expectedProblems?.[id] ?? []);
      }, 120_000);
    }

    it(`${spec.playThrough} plays to its end, AI against AI`, async () => {
      const { session, problems } = start(campaign, spec.playThrough);
      await session.runStartupEvents();
      for (const team of session.board.teams()) if (team.controller === 'human') team.controller = 'ai';
      const limit = (session.turnLimit ?? 0) > 0 ? session.turnLimit! : 40;
      // One side's turn at a time: the active side plays, then endTurn(0) passes the turn on (it plays no AI side
      // itself), with a yield in between -- vitest's worker gives up on a synchronous stretch of over a minute.
      for (let guard = 0; guard < 2000 && !session.scenarioResult && session.turnNumber <= limit + 1; guard++) {
        session.playAiSide(session.activeSide, []);
        if (session.scenarioResult) break;
        await session.endTurn(0);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(session.scenarioResult).not.toBeNull();
      expect(problems).toEqual([]);
    }, 900_000);
  });
}

describe('the B2 campaigns\' own Lua tags', () => {
  it("Sceptre of Fire's [rune_choice]: a dwarf on a rune chest is offered the rune with its cost in the label", async () => {
    const { session, problems } = start('Sceptre_of_Fire', '1_A_Bargain_is_Struck');
    const offers: string[][] = [];
    session.interactionHost = {
      async handle(interaction) {
        if (interaction.kind === 'message' && interaction.options.length > 0) {
          offers.push(interaction.options.map((o) => o.label));
          return { value: 0 };
        }
        return {};
      },
    };
    await session.runStartupEvents();
    const rugnur = session.board.allUnits().find((u) => u.id === 'Rugnur')!;
    // The swiftness chest (SOF_RUNIC_CHEST_SWIFTNESS 13 9), next to Rugnur's keep.
    await session.handleHexClick(rugnur.location.x, rugnur.location.y);
    await session.handleHexClick(12, 8);
    expect(offers).toHaveLength(1);
    expect(offers[0]![0]).toBe('No');
    expect(offers[0]![1]).toMatch(/^Swiftness <span style='italic'> \(8g\)<\/span>$/);
    expect(problems).toEqual([]);
  });

  it("Legend of Wesmere's [replace_map_section] and [shift_labels]: when Kalenz arrives in 3, the map grows around the units", async () => {
    const { session, problems } = start('Legend_of_Wesmere', '03_Kalian_under_Attack');
    await session.runStartupEvents();
    const before = { width: session.board.map.totalWidth(), height: session.board.map.totalHeight() };
    const where = new Map(session.board.allUnits().map((u) => [u.underlyingId, [u.location.wmlX, u.location.wmlY]]));
    session['eventPump'].fire('kalenz_arrives');
    expect(problems).toEqual([]);
    expect(session.board.map.totalWidth()).toBeGreaterThan(before.width);
    expect(session.board.map.totalHeight()).toBeGreaterThan(before.height);
    // LOAD_SUBMAP's offset is 2,2: every unit kept, two hexes right and down.
    for (const u of session.board.allUnits()) {
      const was = where.get(u.underlyingId);
      if (was) expect([u.location.wmlX, u.location.wmlY]).toEqual([was[0]! + 2, was[1]! + 2]);
    }
  });

  it("Legend of Wesmere's [persistent_carryover_store]: the persistent sides' units and gold go to a global variable", async () => {
    const persistent = memoryPersistentVariables();
    const { session, problems } = start('Legend_of_Wesmere', '07_Elves_Last_Stand', { persistent });
    await session.runStartupEvents();
    const tag = new WmlConfig();
    tag.addChild('persistent_carryover_store').setAttribute('scenario_id', 'LoW_Chapter_Two');
    runFlow(session['eventPump'].runAsHandlerFlow(tag, Location.NULL, Location.NULL));
    expect(problems).toEqual([]);
    const sides = session.board.teams().filter((t) => t.persistent);
    expect(sides.length).toBeGreaterThan(0);
    // Kalenz's side (save_id=Kalenz): its gold, and its units without their place, moves or hitpoints.
    expect(sides.map((t) => t.saveId)).toEqual(['Kalenz', 'Galtrid']);
    const stored = persistent.get('LoW_Chapter_Two', 'Kalenz')?.child('Kalenz');
    expect(stored?.getNumber('gold')).toBe(session.board.getTeam(1)!.gold);
    const units = stored!.children('unit');
    expect(units.map((u) => u.getString('id'))).toContain('Kalenz');
    for (const key of ['x', 'y', 'hitpoints', 'moves', 'side']) expect(units[0]!.hasAttribute(key)).toBe(false);
  });
});
