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
import type { UnitType } from '../model/UnitType.js';
import type { WmlConfig } from '../wml/config.js';
import type { VariableStore } from './variables.js';

/** A recorded `[message]` (see actionWml.ts's `message` handler) -- this port's headless stand-in for showing a dialog. */
export interface RecordedMessage {
  speaker: string;
  message: string;
  image?: string;
  caption?: string;
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
  variables: VariableStore;
  registry: ActionRegistry;
  /** Looks up a `UnitType` by WML `type=` id, e.g. for `[unit]`/`[modify_unit] type=`. */
  resolveType: (id: string) => UnitType;
  /** `[message]`'s headless stand-in for "show a dialog" -- see `RecordedMessage`. */
  messages: RecordedMessage[];
  /** The event currently being processed: `loc1`/`loc2` back `$x1`/`$y1`/`$x2`/`$y2` and `[filter]`/`[filter_second]`. */
  loc1: Location;
  loc2: Location;
  /** The `queued_event`'s own `data` config (e.g. weapon info for combat events) -- opaque here, not yet consumed by any ported tag. */
  eventData: WmlConfig;
  exit: ExitState;
  /** Queues a new event, processed once the current pump pass finishes (see pump.ts's module doc comment on batching). */
  raise: (name: string, loc1?: Location, loc2?: Location, data?: WmlConfig) => void;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}
