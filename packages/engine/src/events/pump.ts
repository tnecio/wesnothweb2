/**
 * TS port of the WML event dispatch loop: `src/game_events/pump.hpp/.cpp`
 * (`wml_event_pump`, `pump_manager`, `queued_event`) and the handler
 * bookkeeping half of `src/game_events/manager.hpp/.cpp` +
 * `manager_impl.cpp` (`event_handlers`, id/name lookup, priority
 * ordering). Headless: none of `display`/`game_display`/`video::headless`/
 * `whiteboard` (upstream's display/UI-session coupling in `pump.cpp`) is
 * ported -- see the module doc comments on what that coupling was for.
 *
 * ## What's ported
 * - Registering `[event]` handlers from a scenario config (`name=`/`id=`
 *   comma-split and standardized -- spaces to underscores, matching
 *   `event_handlers::standardize_name`), `first_time_only=` (default
 *   `yes`, i.e. NOT repeatable by default -- matches
 *   `!handler["first_time_only"].to_bool(true)`), `priority=` ordering
 *   (ascending, stable for ties -- matches `event_handlers::cmp` +
 *   `std::stable_sort`), duplicate-`id=` rejection.
 * - Firing/raising events by name or id, with `$x1`/`$y1`/`$x2`/`$y2` set
 *   from the event's locations before dispatch (matches `operator()()`).
 * - Filter matching before a handler's body runs: `[filter_condition]`
 *   (via `conditionalWml.ts`), `[filter]`/`[filter_second]` (unit filters
 *   against `loc1`/`loc2`, via `filter.ts`).
 * - Disabling non-repeatable handlers *before* running their body (so a
 *   handler that re-raises its own event during its own body doesn't
 *   re-trigger itself), matching `event_handler::handle_event`.
 *
 * ## NOT ported / simplified
 * - `[filter_side]`, `[filter_attack]`/`[filter_second_attack]`,
 *   `filter_formula=` on `[event]` itself: not matched (a handler with
 *   only these filter kinds runs unconditionally rather than being
 *   correctly gated -- flagged here rather than silently "supported").
 * - `[insert_tag]`-based dynamic handler content, `[filter_condition]`
 *   with `might_contain_variables` deferred re-evaluation
 *   (`dynamic_`/`by_name_` split in `manager_impl.cpp`): all handlers are
 *   matched by their name(s) as computed once at registration time.
 * - Batching semantics around *recursive* firing (an action handler itself
 *   causing a nested `pump()` call) are simplified -- see `EventPump.pump`'s
 *   doc comment for the specific, documented divergence.
 * - `undo_disabled`/`action_canceled` context-stack tracking
 *   (`context::scoped`, `[allow_undo]`) and WML message/error de-duplicated
 *   chat display (`show_wml_messages`) are not modeled -- this port has no
 *   undo stack or chat log to hook them into yet.
 */

import type { GameBoard } from '../model/GameBoard.js';
import { Location } from '../model/Location.js';
import type { UnitType } from '../model/UnitType.js';
import { WmlConfig } from '../wml/config.js';
import { createDefaultActionRegistry, runActionSequence } from './actionWml.js';
import { ActionRegistry, type EventContext, type RecordedMessage } from './context.js';
import { conditionalPassed } from './conditionalWml.js';
import { unitMatchesFilter } from './filter.js';
import type { VariableStore } from './variables.js';

/** Mirrors `event_handlers::standardize_name`: trim, then spaces -> underscores. */
export function standardizeEventName(name: string): string {
  return name.trim().replace(/ /g, '_');
}

export interface WmlEventHandler {
  /** The original `[event]` config, unexpanded -- both filters and the action body are read from this. */
  rawCfg: WmlConfig;
  names: string[];
  id: string;
  repeatable: boolean;
  priority: number;
  disabled: boolean;
}

export interface QueuedEvent {
  name: string;
  id: string;
  loc1: Location;
  loc2: Location;
  data: WmlConfig;
}

/** Handler registration/lookup, mirroring `game_events::manager` + `event_handlers`. */
export class EventManager {
  private handlers: WmlEventHandler[] = [];

  /** Registers an `[event]` config. Returns the handler, or `undefined` if rejected (missing name+id, or duplicate id). */
  addFromWml(cfg: WmlConfig): WmlEventHandler | undefined {
    const id = cfg.getString('id', '');
    const nameRaw = cfg.getString('name', '');
    if (nameRaw === '' && id === '') return undefined;
    if (id !== '' && this.handlers.some((h) => h.id === id && !h.disabled)) return undefined;

    const names = nameRaw === '' ? [] : nameRaw.split(',').map((s) => standardizeEventName(s));
    const handler: WmlEventHandler = {
      rawCfg: cfg,
      names,
      id,
      repeatable: !cfg.getBoolean('first_time_only', true),
      priority: cfg.getNumber('priority', 0),
      disabled: false,
    };
    this.handlers.push(handler);
    this.handlers.sort((a, b) => a.priority - b.priority); // Array#sort is stable (ES2019+): ties keep registration order.
    return handler;
  }

  /** Registers every `[event]` child of a `[scenario]` (or similar) config, in document order. Mirrors `manager::read_scenario`. */
  loadScenarioEvents(scenarioCfg: WmlConfig): void {
    for (const ev of scenarioCfg.children('event')) this.addFromWml(ev);
  }

  getActive(): WmlEventHandler[] {
    return this.handlers.filter((h) => !h.disabled);
  }

  handlersForName(name: string): WmlEventHandler[] {
    return this.getActive().filter((h) => h.names.includes(name));
  }

  handlerById(id: string): WmlEventHandler | undefined {
    return this.getActive().find((h) => h.id === id);
  }
}

export interface EventPumpOptions {
  board: GameBoard;
  variables: VariableStore;
  resolveType: (id: string) => UnitType;
  /** Defaults to `createDefaultActionRegistry()`; pass a shared one to layer combat/recruit/Lua handlers in. */
  registry?: ActionRegistry;
  log?: EventContext['log'];
}

/** TS port of `wml_event_pump`: queues and dispatches events to registered `[event]` handlers. */
export class EventPump {
  private queue: QueuedEvent[] = [];
  readonly ctx: EventContext;

  constructor(
    private readonly manager: EventManager,
    options: EventPumpOptions,
  ) {
    this.ctx = {
      board: options.board,
      variables: options.variables,
      registry: options.registry ?? createDefaultActionRegistry(),
      resolveType: options.resolveType,
      messages: [] as RecordedMessage[],
      objectivesBySide: new Map(),
      loc1: Location.NULL,
      loc2: Location.NULL,
      eventData: new WmlConfig(),
      exit: { type: 'none' },
      raise: (name, loc1 = Location.NULL, loc2 = Location.NULL, data = new WmlConfig()) => {
        this.queue.push({ name: standardizeEventName(name), id: '', loc1, loc2, data });
      },
      log: options.log ?? (() => {}),
    };
  }

  raise(name: string, loc1: Location = Location.NULL, loc2: Location = Location.NULL, data: WmlConfig = new WmlConfig()): void {
    this.ctx.raise(name, loc1, loc2, data);
  }

  raiseById(name: string, id: string, loc1: Location = Location.NULL, loc2: Location = Location.NULL, data: WmlConfig = new WmlConfig()): void {
    this.queue.push({ name: standardizeEventName(name), id, loc1, loc2, data });
  }

  /** Raises then immediately drains the queue. Mirrors `wml_event_pump::fire`. */
  fire(name: string, loc1?: Location, loc2?: Location, data?: WmlConfig): void {
    this.raise(name, loc1, loc2, data);
    this.pump();
  }

  /**
   * Drains the event queue. Mirrors `wml_event_pump::operator()()` +
   * `pump_manager`'s swap-based batching, simplified: each iteration of
   * this loop snapshots and clears the current queue, processes every
   * event in that snapshot (running to completion, including any
   * newly-`raise()`d events those handlers add to the NEXT snapshot), and
   * repeats until nothing is left. Upstream instead gives a *recursive*
   * `operator()()` call (triggered from inside a handler, e.g. via
   * `wesnoth.game_events.fire`) its own nested `pump_manager` that drains
   * immediately, synchronously, before the outer call's handler resumes.
   * This port's batching is observably different only for handlers that
   * depend on a nested event completing strictly before their own next
   * action runs -- see `actionWml.ts`'s `kill` handler for the one place
   * this is a real, documented gap (`fire_event=yes`'s die/last-breath
   * ordering relative to the unit's removal).
   */
  pump(): void {
    let iterations = 0;
    while (this.queue.length > 0) {
      if (++iterations > 10000) {
        throw new Error('game_events pump exceeded max iterations (possible runaway event loop)');
      }
      const batch = this.queue;
      this.queue = [];
      for (const ev of batch) {
        if (ev.name === '' && ev.id === '') continue;

        this.ctx.variables.set('x1', ev.loc1.valid() ? ev.loc1.wmlX : 0);
        this.ctx.variables.set('y1', ev.loc1.valid() ? ev.loc1.wmlY : 0);
        this.ctx.variables.set('x2', ev.loc2.valid() ? ev.loc2.wmlX : 0);
        this.ctx.variables.set('y2', ev.loc2.valid() ? ev.loc2.wmlY : 0);

        const handlers =
          ev.id !== ''
            ? ([this.manager.handlerById(ev.id)].filter(Boolean) as WmlEventHandler[])
            : this.manager.handlersForName(ev.name);

        for (const handler of handlers) {
          if (handler.disabled) continue;
          this.processEvent(handler, ev);
        }
      }
    }
  }

  /** Mirrors `wml_event_pump::process_event`: filter, then (if first-time-only) disable, then run the body. */
  private processEvent(handler: WmlEventHandler, ev: QueuedEvent): void {
    if (!this.filterEvent(handler, ev)) return;
    if (!handler.repeatable) handler.disabled = true;

    this.ctx.loc1 = ev.loc1;
    this.ctx.loc2 = ev.loc2;
    this.ctx.eventData = ev.data;
    this.ctx.exit = { type: 'none' };

    runActionSequence(handler.rawCfg, this.ctx);
  }

  /** Mirrors `event_handler::filter_event`, for the filter kinds this port implements -- see module doc comment. */
  private filterEvent(handler: WmlEventHandler, ev: QueuedEvent): boolean {
    const cfg = handler.rawCfg;

    const filterConditionCfg = cfg.child('filter_condition');
    if (filterConditionCfg && !conditionalPassed(this.ctx.variables.expandConfig(filterConditionCfg), this.ctx)) {
      return false;
    }

    const filterCfg = cfg.child('filter');
    if (filterCfg) {
      const unit = ev.loc1.valid() ? this.ctx.board.unitAt(ev.loc1) : undefined;
      if (!unit || !unitMatchesFilter(unit, this.ctx.variables.expandConfig(filterCfg), this.ctx.board)) return false;
    }

    const filterSecondCfg = cfg.child('filter_second');
    if (filterSecondCfg) {
      const unit = ev.loc2.valid() ? this.ctx.board.unitAt(ev.loc2) : undefined;
      if (!unit || !unitMatchesFilter(unit, this.ctx.variables.expandConfig(filterSecondCfg), this.ctx.board)) return false;
    }

    return true;
  }
}
