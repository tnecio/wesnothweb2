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
import type { UnitType } from '../model/UnitType.js';
import type { ItemStore } from './itemsWml.js';
import type { LabelStore } from './labelsWml.js';
import type { WmlConfig } from '../wml/config.js';
import type { Rng } from '../rng/Rng.js';
import type { VariableStore } from './variables.js';
import type { ScenarioObjectives } from './objectives.js';
import type { Flow } from './interaction.js';
import type { MusicList } from '../audio/musicList.js';
import type { SoundRequest } from '../audio/sounds.js';

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
  /** `sound=`: a one-off effect to play with the line; carried for Phase 19, not played here. */
  sound: string;
  /** `voice=`: the speaker's recorded line; carried for Phase 19, not played here. */
  voice: string;
}

/**
 * One answered `[message]` choice, in the shape upstream records for
 * replay: an `[input]` child carrying `value=` and/or `text=` plus the
 * side that answered (`synced_user_choice.cpp:354-378`). Phase 25's
 * replay log is the eventual consumer; recording the shape now means it
 * won't have to be reconstructed later.
 */
export interface ChoiceRecord {
  /** The 1-based index of the chosen `[option]`. */
  readonly value?: number;
  /** The `[text_input]` contents. */
  readonly text?: string;
  /** Which side was asked -- upstream's `from_side`; 0 during startup events, when no side is active yet. */
  readonly side: number;
}

/**
 * Mirrors WML's loop-control exit signal (`current_exit` in upstream's
 * `wml-utils.lua`): `'none'` is ordinary flow; `'break'`/`'continue'` exit
 * or restart a loop scope (`[while]`/`[for]`/`[foreach]`/`[repeat]`, see
 * `flowWml.ts`); `'return'` unwinds out of the whole event handler. A
 * single mutable box shared by the whole action-execution call tree, so
 * nested `[if][then]` bodies signalling `return` correctly stop every
 * enclosing sequence, not just their own immediate scope.
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
  /** `carryover_report=` (default yes): whether the victory summary is shown -- and the victory stinger played. */
  carryoverReport?: boolean;
  /** `music=`: the tracks to choose the stinger from, in place of the scenario's `victory_music=`/`defeat_music=`. */
  music?: string[];
}

/**
 * A WML action tag's implementation. Most run to completion and return
 * nothing; one that has to stop mid-way (a `[message]` waiting to be
 * dismissed, a cutscene beat waiting to finish playing) returns the
 * generator described in `interaction.ts` instead, and whoever drives the
 * pump decides how to answer it. `runActionFlow` delegates into either
 * shape, so a handler only opts in when it actually needs to block.
 */
export type ActionHandler = (cfg: WmlConfig, ctx: EventContext) => void | Flow;

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
  /**
   * The scenario's own synced RNG, where there is one -- `[set_variable]
   * rand=` draws from it, so a scenario that randomises something (Two
   * Brothers picks its guards' passwords this way) stays reproducible
   * and, later, replayable. Undefined in a context with no game behind
   * it, where `rand=` logs and does nothing rather than inventing an
   * unsynced number.
   */
  rng?: Rng;
  /**
   * Every `[message]` that has been shown, oldest first. Before Phase 17
   * this was the whole of `[message]` -- events ran to completion and the
   * UI replayed the array afterwards. Now a message blocks its event and
   * is shown as it happens, so this is a log rather than a work queue,
   * kept for headless callers and tests that assert what was said.
   */
  messages: RecordedMessage[];
  /** Every `[option]`/`[text_input]` answer, oldest first -- see `ChoiceRecord`. */
  choices: ChoiceRecord[];
  /**
   * `[object] id=`s already taken (`used_items` in `object.lua`, saved with
   * the game as `[used_items]`): a `take_only_once` object is not given
   * twice, and `[found_item]` asks whether one was.
   */
  usedItems: Set<string>;
  /**
   * `objectives.lua`'s `scenario_objectives`: the raw `[objectives]` last
   * given for each side (0: for every side), kept so `[show_objectives]`
   * can regenerate them. Saved with the game.
   */
  objectivesConfigBySide: Map<number, WmlConfig>;
  /** Sides whose objectives changed since they were last shown (`team.objectives_changed`). */
  objectivesChanged: Set<number>;
  /** Phase 18: the items on the map (`items.lua`'s `scenario_items`) and its name counter. */
  items: ItemStore;
  /** Phase 18: map labels (`map_labels`). */
  labels: LabelStore;
  /** Phase 19: the music playlist (`sound.cpp`'s `current_track_list`), shared across scenarios. */
  music: MusicList;
  /** Phase 19: every sound effect the game has asked for, oldest first (capped), for headless callers. */
  sounds: SoundRequest[];
  /** Where sound effects go to be heard (`sound::play_sound`); the session installs it. Without one they are only recorded. */
  onSound?: (request: SoundRequest) => void;
  /** Asks for a sound effect: records it and hands it to `onSound`. */
  playSound: (request: SoundRequest) => void;
  /** `[cancel_action]` (`wml_event_pump::set_action_canceled`): the move firing this event stops at this hex. */
  actionCanceled: boolean;
  /**
   * `tod_manager::num_turns_`: the scenario's turn limit, `-1` for none.
   * `[modify_turns]` changes it, `[store_turns]` reads it, and the game
   * checks it when a turn wraps (`check_time_over`).
   */
  turnLimit: number;
  /** `[modify_turns] current=`: move the game to that turn (`tod_manager::set_turn_by_wml`). Installed by the session. */
  setTurnNumber?: (turn: number) => void;
  /** A unit type's full config (`unit_type::get_cfg`, for `[store_unit_type]`). Installed by the session. */
  unitTypeConfig?: (id: string) => WmlConfig | undefined;
  /** The current turn (`tod_manager::turn`). Installed by the session; `$turn_number` otherwise. */
  turnNumber?: () => number;
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
  /**
   * Phase 17: fires an event *now*, draining it (and anything it raises)
   * completely before the caller's next action runs -- upstream's own
   * recursive `wml_event_pump::operator()()`. `[fire_event]` and
   * `[kill] fire_event=yes` use it; `raise` remains the "queue it for
   * after this event body" form. Must be delegated to with `yield*`, so
   * a `[message]` inside the nested event can still suspend.
   */
  fireNow: (name: string, loc1?: Location, loc2?: Location, data?: WmlConfig, id?: string) => Flow;
  /**
   * Upstream's per-context `skip_messages` flag (`pump.cpp`'s
   * `context::state`): set when the player pressed Escape on a message
   * with no input, which drops the *rest of this event's* input-less
   * messages. Inherited by nested events, and reset for each new
   * top-level event, exactly like `context::scoped`.
   */
  skipMessages: boolean;
  /**
   * `[allow_undo]`/`[disallow_undo]` (`wesnoth.experimental.game_events.
   * set_undoable`): marks the running event handler as having (not) changed
   * anything an undo would have to take back. See `EventPump.undoDisabled`.
   */
  setUndoable: (undoable: boolean) => void;
  /** `wesnoth.game_events.add_wml`: registers an `[event]` at run time (a nested `[event]` tag). False if rejected (no name/id, or a duplicate id). */
  addEvent: (cfg: WmlConfig) => boolean;
  /** `wesnoth.game_events.remove`: the handler with this id stops handling events (`[remove_event]`). */
  removeEvent: (id: string) => void;
  /**
   * `[on_undo]`: WML to run if the action that fired this event is undone.
   * Set by a host with an undo stack (`GameSession`); without one the tag
   * logs and does nothing.
   */
  addUndoCommands?: (commands: WmlConfig) => void;
  /**
   * False while the scenario's `prestart` (and anything before it) runs,
   * true once `start` has fired. Only `[delay]` reads it, mirroring
   * `intf_delay`'s own "do nothing during PRELOAD/PRESTART/INITIAL" guard
   * (`game_lua_kernel.cpp:4491`), so a scenario that opens with scripted
   * pauses doesn't stall before its board is up. Defaults to true; the
   * scenario host (`GameSession`) clears it around startup.
   */
  gameStarted: boolean;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  /** Set by a host with a real AI engine (`packages/ui`'s `GameSession`, Phase 29 S5) -- backs the `[modify_ai]`/`[modify_side]`/`[micro_ai]` action tags (`ai/wmlActions.ts`). Undefined (rather than a no-op stub) in any context without one, e.g. a headless test that never constructs an `AiManager`, so those tags log a clear "not loaded" warning instead of silently doing nothing. */
  ai?: import('../ai/wmlActions.js').AiWmlHooks;
}
