/**
 * Scenario-to-scenario carryover: real gold-carryover math and real
 * recall-list continuation, both driven by the generic WML
 * `[scenario] next_scenario=` mechanism rather than anything hardcoded to a
 * specific campaign/scenario.
 *
 * ## Gold carryover
 *
 * `computeGoldCarryover` is an exact TS port of the formula in
 * `wesnoth/data/lua/carryover_gold.lua` (`calculate_finishing_bonus`/
 * `set_side_carryover_gold`) plus `wesnoth/src/carryover.cpp`'s
 * `transfer_all_gold_to`:
 *
 * ```
 * finishingBonusPerTurn = totalVillages * incomePerVillage + (teamIncome + BASE_INCOME)
 * turnsLeft             = max(0, scenarioTurnsLimit - turnNumberAtVictory)
 * finishingBonus        = ceil(bonus * finishingBonusPerTurn * turnsLeft)
 * carryoverGoldValue    = ceil((teamGold + finishingBonus) * carryoverPercentage / 100)
 * nextScenarioGold      = carryoverAdd
 *   ? nextScenarioDeclaredGold + carryoverGoldValue
 *   : max(carryoverGoldValue, nextScenarioDeclaredGold)
 * ```
 *
 * `totalVillages` is EVERY village hex on the map, unfiltered by ownership
 * (upstream: `wesnoth.map.find{gives_income=true}`, unfiltered) --
 * `GameMap.villages` already matches this exactly. `BASE_INCOME` (2) mirrors
 * `game_config::base_income`, matching `team::base_income()` =
 * `raw_income() + game_config::base_income`.
 *
 * `bonus=`/`carryover_add=`/`carryover_percentage=` are NOT looked up from a
 * live-fired `[endlevel]` event (see `findVictoryEndlevelGoldConfig`'s own
 * doc comment for why, and for the documented simplification this implies).
 *
 * ## Recall-list carryover
 *
 * Real Wesnoth automatically carries every surviving unit on a persistent
 * side into the next scenario's recall list, UNLESS that unit is explicitly
 * re-declared inline in the next scenario's own `[side]` (e.g. Dead Water's
 * `{SIDE_1}` macro always re-declares Kai Krellis fresh by
 * `id=Kai Krellis`). `computeCarryoverRecruits` implements a **deliberate,
 * documented simplification** of this: it carries over every surviving
 * player-side unit whose `id` does NOT match a unit id inline-declared in
 * the next scenario's own `[side]` block (the leader's own `id=` plus any
 * nested `[unit] id=`). It does NOT replicate upstream's separate
 * "persistent hero unit XP/level carries over via a config overlay, not a
 * real recall" mechanism for a unit like Kai Krellis -- his level/XP is
 * simply not carried at all under this simplification (he's excluded by id,
 * matching how he's fresh in the next scenario's `[side]` anyway).
 *
 * A scenario's own `[prestart]`-time `{RECALL_LOYAL_UNITS}` macro (a series
 * of `[recall] id=X [/recall]` calls) now DOES auto-place named recall-list
 * units onto the board for real, the same as upstream -- see
 * `events/actionWml.ts`'s `[recall]` handler. Earlier in this project that
 * auto-placement wasn't implemented and carried-over survivors were simply
 * left in the recall list for the player to manually recall instead; this
 * function's own scope now also folds in units already sitting in
 * `playerSide`'s recall list (not just ones still on the map) specifically
 * because of that: a hero the player didn't get around to recalling during
 * the just-finished scenario must still carry forward into the *next* one
 * (real Wesnoth's recall list is unconditionally persistent), not be
 * silently dropped for having sat on the list one scenario too long.
 */

import { WmlConfig, type WmlConfigJson } from '../wml/config.js';
import { standardizeEventName } from '../events/pump.js';
import type { GameBoard } from '../model/GameBoard.js';
import type { Unit } from '../model/Unit.js';

/** `game_config::base_income` (`wesnoth/src/game_config.cpp`: `int base_income = 2`). */
export const BASE_INCOME = 2;

/** `game_config::gold_carryover_percentage` (`wesnoth/src/game_config.cpp`: `const int gold_carryover_percentage = 80`) -- the real default an `[endlevel]` falls back to when it doesn't set `carryover_percentage=`. */
export const DEFAULT_CARRYOVER_PERCENTAGE = 80;

/** The `bonus=`/`carryover_add=`/`carryover_percentage=` an `[endlevel]` set -- see this module's doc comment. */
export interface EndlevelGoldConfig {
  bonus: boolean;
  carryoverAdd: boolean;
  carryoverPercentage: number;
}

const DEFAULT_ENDLEVEL_GOLD_CONFIG: EndlevelGoldConfig = {
  bonus: false,
  carryoverAdd: false,
  carryoverPercentage: DEFAULT_CARRYOVER_PERCENTAGE,
};

/**
 * Statically locates the `[endlevel]` that would fire when this scenario is
 * won, WITHOUT a real WML event pump -- see `victory.ts`'s own doc comment
 * for why real `enemies_defeated`/`die` event firing isn't wired up yet
 * (it needs a live `EventPump` reference `combat.ts`'s headless resolver
 * doesn't carry). Instead, this walks `scenarioConfigJson`'s own top-level
 * `[event]` children (NOT nested ones -- real scenario events are always
 * declared as direct children of `[scenario]`) for the first one whose
 * standardized `name=` (spaces -> underscores, matching
 * `event_handlers::standardize_name`/`standardizeEventName`) is
 * `enemies_defeated`, and reads its `[endlevel]` child's attributes
 * directly. This is a deliberate simplification: a scenario that ends via
 * some other real mechanism (a `[time_limit]`, a custom `[event] name=die`
 * with its own `[endlevel]`, etc.) is not searched for -- callers get the
 * real upstream defaults (`bonus=no` -> 0, `carryover_add=no`,
 * `carryover_percentage=80`) instead, which is safe (no crash, a
 * conservative "no bonus, cap at declared starting gold" outcome) rather
 * than correct for every possible scenario structure. Verified correct for
 * Dead Water scenario 1's real `[event] name="enemies defeated"]
 * [endlevel] result=victory bonus=yes carryover_add=yes
 * carryover_percentage=40 [/endlevel] [/event]` (the last two attributes
 * come from the `{NEW_GOLD_CARRYOVER 40}` macro it uses).
 */
export function findVictoryEndlevelGoldConfig(scenarioConfigJson: WmlConfigJson): EndlevelGoldConfig {
  const scenarioCfg = WmlConfig.fromJSON(scenarioConfigJson);
  for (const eventCfg of scenarioCfg.children('event')) {
    if (standardizeEventName(eventCfg.getString('name', '')) !== 'enemies_defeated') continue;
    const endlevel = eventCfg.child('endlevel');
    if (!endlevel) continue;
    return {
      bonus: endlevel.getBoolean('bonus', false),
      carryoverAdd: endlevel.getBoolean('carryover_add', false),
      carryoverPercentage: endlevel.getNumber('carryover_percentage', DEFAULT_CARRYOVER_PERCENTAGE),
    };
  }
  return DEFAULT_ENDLEVEL_GOLD_CONFIG;
}

export interface GoldCarryoverInput {
  /** The winning side's real gold at the moment of victory. */
  teamGold: number;
  /** The winning side's `[side] income=` (`Team.income`; the raw per-turn income beyond `BASE_INCOME`, NOT `team::base_income()`). */
  teamIncome: number;
  /** The winning side's `[side] village_gold=` (`Team.incomePerVillage`). */
  incomePerVillage: number;
  /** EVERY village hex on the finishing scenario's map, unfiltered by ownership -- see `GameMap.villages`. */
  totalVillages: number;
  /** The finishing scenario's `[scenario] turns=`, or `null` if it has none (unlimited). */
  scenarioTurnsLimit: number | null;
  /** The turn number the scenario ended on. */
  turnNumberAtVictory: number;
  /** The winning `[endlevel]`'s bonus=/carryover_add=/carryover_percentage= -- see `findVictoryEndlevelGoldConfig`. */
  endlevel: EndlevelGoldConfig;
  /** The next scenario's own declared starting gold for this side (its `[side] gold=`), before carryover is applied. */
  nextScenarioDeclaredGold: number;
}

export interface GoldCarryoverResult {
  finishingBonusPerTurn: number;
  turnsLeft: number;
  finishingBonus: number;
  /** The amount reported to the player as "Bonus gold"/"Retained gold" -- NOT necessarily the next scenario's final starting gold when `carryoverAdd` is false (see `nextScenarioGold`). */
  carryoverGoldValue: number;
  /** What the next scenario's side should actually start with -- see this module's doc comment for the `carryoverAdd` branch. */
  nextScenarioGold: number;
}

/** Exact port of the real gold-carryover formula -- see this module's own doc comment. */
export function computeGoldCarryover(input: GoldCarryoverInput): GoldCarryoverResult {
  const finishingBonusPerTurn = input.totalVillages * input.incomePerVillage + (input.teamIncome + BASE_INCOME);
  // Mirrors carryover_gold.lua's turns_left(): wesnoth.scenario.turns is -1
  // for an unlimited scenario, so `max(0, -1 - current_turn)` is always 0 --
  // modeled the same way here via a -1 stand-in for `null`.
  const limit = input.scenarioTurnsLimit ?? -1;
  const turnsLeft = Math.max(0, limit - input.turnNumberAtVictory);
  const bonusFlag = input.endlevel.bonus ? 1 : 0;
  const finishingBonus = Math.ceil(bonusFlag * finishingBonusPerTurn * turnsLeft);
  const carryoverGoldValue = Math.ceil(((input.teamGold + finishingBonus) * input.endlevel.carryoverPercentage) / 100);
  const nextScenarioGold = input.endlevel.carryoverAdd
    ? input.nextScenarioDeclaredGold + carryoverGoldValue
    : Math.max(carryoverGoldValue, input.nextScenarioDeclaredGold);
  return { finishingBonusPerTurn, turnsLeft, finishingBonus, carryoverGoldValue, nextScenarioGold };
}

/** Unit ids inline-declared directly inside one `[side]` block: the leader's own `id=` plus any nested `[leader]`/`[unit] id=`. Deliberately does NOT look at `[recall]` children (those name units already ON the recall list, not a fresh re-declaration that should suppress carryover) or events elsewhere in the scenario (e.g. `{RECALL_LOYAL_UNITS}`, which upstream calls from a `prestart` `[event]`, not from `[side]` itself -- see this module's doc comment on why that auto-placement isn't replicated). */
function inlineDeclaredIds(sideCfg: WmlConfig): Set<string> {
  const ids = new Set<string>();
  const leaderId = sideCfg.getString('id', '');
  if (leaderId) ids.add(leaderId);
  for (const unitCfg of [...sideCfg.children('leader'), ...sideCfg.children('unit')]) {
    const id = unitCfg.getString('id', '');
    if (id) ids.add(id);
  }
  return ids;
}

/** The next scenario's own `[side side=N]` config, or `undefined` if it has none. */
export function findSideConfig(scenarioConfigJson: WmlConfigJson, side: number): WmlConfig | undefined {
  const scenarioCfg = WmlConfig.fromJSON(scenarioConfigJson);
  return scenarioCfg.children('side').find((s) => s.getNumber('side', 1) === side);
}

/**
 * Which of `board`'s current (surviving) `playerSide` units should carry
 * over into `nextScenarioConfigJson`'s recall list -- see this module's doc
 * comment for the exact, documented simplification. Returns the live `Unit`
 * instances themselves (not copies): callers transplanting them into a new
 * scenario's `GameBoard.addToRecallList` reuse the same objects directly,
 * preserving hp/level/traits exactly, since a `Unit`/`UnitType` pair carries
 * no back-reference to the board it was built against.
 *
 * Includes BOTH units still on the map (`board.unitsForSide`) AND units
 * already sitting in `playerSide`'s recall list (`board.recallList`) --
 * real Wesnoth's recall list is unconditionally persistent (`[side]
 * persistent=`/`save_id=`'s whole point): a hero the player never got
 * around to recalling during the *previous* scenario does not vanish, it
 * simply stays on the list. Missing this was a real bug found while
 * extending Dead Water content past scenario 2: `startNextScenario` only
 * ever passed `finished.board`'s on-map units through this function, so
 * any survivor still sitting in the recall list from an *earlier* carry
 * (e.g. Cylanna/Gwabbo arriving in scenario 2's recall list per this
 * module's own test, then never recalled onto scenario 2's board) was
 * silently dropped the moment scenario 2 finished, instead of carrying on
 * into scenario 3 as real Wesnoth does.
 */
export function computeCarryoverRecruits(board: GameBoard, playerSide: number, nextScenarioConfigJson: WmlConfigJson): Unit[] {
  const nextSideCfg = findSideConfig(nextScenarioConfigJson, playerSide);
  const declaredIds = nextSideCfg ? inlineDeclaredIds(nextSideCfg) : new Set<string>();
  const notReDeclared = (u: Unit): boolean => !(u.id && declaredIds.has(u.id));
  return [...board.unitsForSide(playerSide).filter(notReDeclared), ...board.recallList(playerSide).filter(notReDeclared)];
}
