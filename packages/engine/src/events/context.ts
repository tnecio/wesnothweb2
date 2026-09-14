/**
 * Shared types for the event pump / action-tag / conditional-WML modules:
 * the execution context an action or conditional handler runs with, and the
 * pluggable registry action tags are looked up in.
 *
 * Split into its own module (rather than living in `actionWml.ts`) purely
 * to avoid a circular import between `actionWml.ts` (needs
 * `conditionalPassed` for `[if]`) and `conditionalWml.ts` (needs
 * `EventContext`/`ActionRegistry` for its own type signatures).
 */

import type { GameBoard } from '../model/GameBoard.js';
import type { Location } from '../model/Location.js';
import type { Schedule } from '../model/Schedule.js';
import type { Unit } from '../model/Unit.js';
import type { UnitType } from '../model/UnitType.js';
import type { WmlConfig } from '../wml/config.js';
import type { VariableStore } from './variables.js';
import type { ScenarioObjectives } from './objectives.js';

/**
 * One real `[set_menu_item]` declaration -- see `actionWml.ts`'s
 * `actionSetMenuItem` for the real (subset) semantics this stores, and
 * `GameSession.menuItems`/`runMenuItem` (packages/ui) for how the UI turns
 * these into right-click context-menu entries and runs `command` when one
 * is picked.
 */
export interface MenuItemDef {
  readonly id: string;
  readonly description: string;
  readonly command: WmlConfig;
}

/**
 * One unit's position/hp as of a `[message]` boundary -- see
 * `RecordedMessage.unitsBefore`'s own doc comment for why this exists.
 * `unit` is the live `Unit` reference (for id/type/side lookups whose
 * values don't change mid-event -- e.g. a startup event never advances a
 * unit); `x`/`y`/`hitpoints` are VALUES captured at that moment, since
 * `unit.location`/`unit.hitpoints` themselves keep changing as later
 * actions in the same event run.
 */
export interface UnitCheckpoint {
  readonly unit: Unit;
  readonly x: number;
  readonly y: number;
  readonly hitpoints: number;
}

/** A recorded `[message]` (see actionWml.ts's `message` handler) -- this port's headless stand-in for showing a dialog. */
export interface RecordedMessage {
  speaker: string;
  message: string;
  image?: string;
  caption?: string;
  /**
   * Phase 16: the portrait to show, resolved like `message.lua`'s
   * `get_image`: `image=`, else the speaker unit's portrait (only when no
   * `second_image=` either); `''` for none or `image=none`. `~RIGHT()` is
   * stripped into `leftSide`.
   */
  portrait: string;
  /** Portrait side: left by default; `~RIGHT()` or `image_pos=right` puts it right, `image_pos=left` back left. Not decided by the unit's side. */
  leftSide: boolean;
  mirror: boolean;
  /** `second_image=`: a second portrait on the right (upstream's double-portrait dialog); `''` for none. */
  secondPortrait: string;
  secondMirror: boolean;
  /** Dialog title, like `get_caption`: `caption=`, else the speaker's name, else its type name; `''` for none. */
  title: string;
  /** Where the speaking unit stood when the message fired (engine 0-based), for scroll-to-speaker; absent for the narrator or no unit. */
  speakerLocation?: { x: number; y: number };
  /** `scroll=` (default yes): whether to scroll to the speaker. */
  scroll: boolean;
  /** `highlight=` (default yes): whether to highlight the speaker's hex. */
  highlight: boolean;
  /**
   * Real, reported bug (bugs2.md "Lua events/narration ... not synced with
   * the narrative messages"): every unit's position/hp exactly as of right
   * before THIS message fired (captured by `actionMessage`) -- e.g. in
   * Dead_Water, Gwabbo's `[unit]` (spawning him) precedes his own
   * `[message]` in the same event body, so he's already present in THIS
   * checkpoint, but the LATER `{MOVE_UNIT id=Gwabbo 20 10}` (after his
   * message) is not reflected until the NEXT checkpoint (or the final
   * post-event state, if this was the last message). A caller that wants
   * the board to visually match the story as it's being told -- not the
   * fully-resolved end state from the very first message -- reads this
   * instead of the live board while stepping through messages one at a
   * time.
   */
  unitsBefore: readonly UnitCheckpoint[];
}

/**
 * Mirrors WML's loop-control exit signal (`current_exit` in upstream's
 * `wml-utils.lua`): `'none'` is ordinary flow; `'break'`/`'continue'` exit
 * or restart a loop scope (`[while]`/`[for]`/`[foreach]`/`[repeat]` --
 * not ported yet, see actionWml.ts's module doc comment); `'return'`
 * unwinds out of the whole event handler. A single mutable box shared by
 * the whole action-execution call tree, so nested `[if][then]` bodies
 * signalling `return` correctly stop every enclosing sequence, not just
 * their own immediate scope.
 */
export interface ExitState {
  type: 'none' | 'break' | 'continue' | 'return';
}

/** What `[endlevel]` decided (`data/lua/wml/endlevel.lua`), for whoever owns the scenario flow. */
export interface EndLevelState {
  result: 'victory' | 'defeat';
  /** `next_scenario=` override, if given. */
  nextScenario?: string;
  /** Per-side carryover overrides from `[endlevel]` or its `[result] side=` children. */
  carryover: Map<number, { bonus?: boolean; carryoverAdd?: boolean; carryoverPercentage?: number }>;
  /** `end_text=`: the outro's first screen when the campaign ends here (upstream default "The End"). */
  endText?: string;
  /** `end_text_duration=` in ms, clamped to 0–5000 like `game_classification`; 0/absent means the 3500 ms default. */
  endTextDuration?: number;
  /** `end_credits=` (default yes): whether the outro rolls the campaign credits after the end text. */
  endCredits?: boolean;
}

export type ActionHandler = (cfg: WmlConfig, ctx: EventContext) => void;

/**
 * The `[tag] -> handler` lookup action-tag execution consults, mirroring
 * `wml_action::registry_`/Lua's `wesnoth.wml_actions` table. Exposed as a
 * mutable, publicly `register`-able map so code outside this module (a
 * future Lua bridge, or `packages/engine/src/actions/`'s move/combat/
 * recruit implementations) can add or override handlers -- see
 * `actionWml.ts`'s "extension point" placeholders for `[attack]`,
 * `[recruit]`, `[move_unit]`, `[lua]`.
 */
export class ActionRegistry {
  private handlers = new Map<string, ActionHandler>();

  register(tag: string, handler: ActionHandler): void {
    this.handlers.set(tag, handler);
  }

  get(tag: string): ActionHandler | undefined {
    return this.handlers.get(tag);
  }

  has(tag: string): boolean {
    return this.handlers.has(tag);
  }
}

/**
 * Everything an action-tag or conditional-WML handler needs. Roughly
 * mirrors the ambient globals upstream's Lua WML actions reach for
 * (`wesnoth.current.event_context`, `resources::gameboard`,
 * `resources::gamedata`, `wml.variables`) bundled into one explicit,
 * headless-safe object instead of module-level singletons.
 */
export interface EventContext {
  board: GameBoard;
  /** The scenario's live ToD schedule -- `[time_area]`/`[remove_time_area]`/`[replace_schedule]` mutate it in place (see `todWml.ts`). */
  schedule: Schedule;
  variables: VariableStore;
  registry: ActionRegistry;
  /** Looks up a `UnitType` by WML `type=` id, e.g. for `[unit]`/`[modify_unit] type=`. */
  resolveType: (id: string) => UnitType;
  /** `[message]`'s headless stand-in for "show a dialog" -- see `RecordedMessage`. */
  messages: RecordedMessage[];
  /**
   * Real, reported bug (bugs3.md "objectives dialog"): `[objectives]` used
   * to be a plain no-op. Mirrors Lua's own `scenario_objectives` table
   * (`data/lua/wml/objectives.lua`), keyed by side -- `actionWml.ts`'s
   * `actionObjectives` populates this for every side named in `side=`
   * (or every side on the board, if absent); a later firing for the same
   * side replaces its entry, matching upstream's own "last one wins"
   * table-write semantics.
   */
  objectivesBySide: Map<number, ScenarioObjectives>;
  /** Real `[set_menu_item]`/`[clear_menu_item]` firings, by id -- see `MenuItemDef`'s own doc comment. */
  menuItems: Map<string, MenuItemDef>;
  /** The event currently being processed: `loc1`/`loc2` back `$x1`/`$y1`/`$x2`/`$y2` and `[filter]`/`[filter_second]`. */
  loc1: Location;
  loc2: Location;
  /** The `queued_event`'s own `data` config (e.g. weapon info for combat events) -- opaque here, not yet consumed by any ported tag. */
  eventData: WmlConfig;
  exit: ExitState;
  /** Set by `[endlevel]` (first firing wins); the session ends the scenario when it sees this. */
  endLevel?: EndLevelState;
  /** Queues a new event, processed once the current pump pass finishes (see pump.ts's module doc comment on batching). */
  raise: (name: string, loc1?: Location, loc2?: Location, data?: WmlConfig) => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Set by a host with a real AI engine (`packages/ui`'s `GameSession`, Phase 29 S5) -- backs the `[modify_ai]`/`[modify_side]`/`[micro_ai]` action tags (`ai/wmlActions.ts`). Undefined (rather than a no-op stub) in any context without one, e.g. a headless test that never constructs an `AiManager`, so those tags log a clear "not loaded" warning instead of silently doing nothing. */
  ai?: import('../ai/wmlActions.js').AiWmlHooks;
}
