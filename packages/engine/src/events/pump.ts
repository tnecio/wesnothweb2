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
 *   (highest first, stable for ties -- `event_handlers::cmp` is ascending,
 *   but upstream `std::stable_sort`s the handlers' *reversed* range),
 *   duplicate-`id=` rejection.
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
 * - `undo_disabled`/`action_canceled` context-stack tracking
 *   (`context::scoped`, `[allow_undo]`) and WML message/error de-duplicated
 *   chat display (`show_wml_messages`) are not modeled -- this port has no
 *   undo stack or chat log to hook them into yet. The third flag of
 *   upstream's `context::state`, `skip_messages`, IS modeled as of
 *   Phase 17 -- see `processEvent`.
 *
 * ## Suspension (Phase 17)
 * `pumpFlow`/`fireFlow` are the real implementations: generators that
 * suspend whenever a handler needs the player or the display (see
 * `interaction.ts`). `pump`/`fire` keep their old synchronous signatures
 * by driving those with `autoRespond`, so every headless caller is
 * unaffected.
 */

import { ItemStore } from './itemsWml.js';
import { LabelStore } from './labelsWml.js';
import type { GameBoard } from '../model/GameBoard.js';
import { Location } from '../model/Location.js';
import { Schedule, DEFAULT_MAX_LIMINAL_BONUS } from '../model/Schedule.js';
import type { UnitType } from '../model/UnitType.js';
import type { Rng } from '../rng/Rng.js';
import { WmlConfig } from '../wml/config.js';
import { createDefaultActionRegistry, runActionFlow, unitToVarNode } from './actionWml.js';
import { ActionRegistry, type EventContext, type RecordedMessage } from './context.js';
import { runFlow, type Flow, type Responder } from './interaction.js';
import { conditionalPassed } from './conditionalWml.js';
import { unitMatchesFilter } from './filter.js';
import type { VariableStore } from './variables.js';
import { MusicList } from '../audio/musicList.js';
import { SoundSourceStore } from '../audio/soundSources.js';

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
    // Highest priority first (`std::stable_sort(active_.rbegin(), active_.rend(), cmp)`); Array#sort is stable
    // (ES2019+), so ties keep registration order. Heir to the Throne 1's `priority=-50` prestart must run last.
    this.handlers.sort((a, b) => b.priority - a.priority);
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

  /** `manager::remove_event_handler(id)` (`[remove_event]`): the handler with this id stops handling anything. */
  removeById(id: string): void {
    for (const h of this.handlers) if (h.id === id) h.disabled = true;
    this.handlers = this.handlers.filter((h) => !h.disabled);
  }

  /**
   * The live handlers' configs, in order -- what a save records (upstream
   * writes the current `[event]`s into `[snapshot]`: a spent
   * `first_time_only` handler is gone, one added at run time is there).
   */
  activeConfigs(): WmlConfig[] {
    return this.getActive().map((h) => h.rawCfg);
  }

  /** Replaces every handler with `cfgs`, as loading a save's `[event]`s does. */
  replaceAll(cfgs: readonly WmlConfig[]): void {
    this.handlers = [];
    for (const cfg of cfgs) this.addFromWml(cfg);
  }
}

export interface EventPumpOptions {
  board: GameBoard;
  variables: VariableStore;
  resolveType: (id: string) => UnitType;
  /** Defaults to `createDefaultActionRegistry()`; pass a shared one to layer combat/recruit/Lua handlers in. */
  registry?: ActionRegistry;
  log?: EventContext['log'];
  /** Defaults to a fresh, empty (permanently neutral) `Schedule` -- pass the session's real one so `[time_area]`/`[replace_schedule]`/`[store_time_of_day]` have somewhere to act. */
  schedule?: Schedule;
  /** The session's synced RNG, for `[set_variable] rand=`. */
  rng?: Rng;
  /** The music playlist, handed on from the previous scenario (one is made if absent). */
  music?: MusicList;
}

const MAX_RECORDED_SOUNDS = 200;

/** TS port of `wml_event_pump`: queues and dispatches events to registered `[event]` handlers. */
export class EventPump {
  private queue: QueuedEvent[] = [];
  /** How many `pumpFlow` calls are on the stack: 1 is a top-level drain, more means `fireNow` nested into one. */
  private nesting = 0;
  /**
   * Upstream's per-context `undo_disabled` flags (`pump.cpp`'s
   * `context::state`): every handler that passes its filter runs in a new
   * context that starts disabled, `[allow_undo]`/`[disallow_undo]` set the
   * innermost one, and a context's flag ORs into its parent when it ends.
   * The bottom entry collects everything since `takeUndoDisabled` last
   * reset it -- the synced action's own answer to "did an event change
   * something undo can't take back?".
   */
  private readonly undoDisabled: boolean[] = [false];
  readonly ctx: EventContext;

  constructor(
    readonly manager: EventManager,
    options: EventPumpOptions,
  ) {
    this.ctx = {
      board: options.board,
      schedule: options.schedule ?? new Schedule([], 0, DEFAULT_MAX_LIMINAL_BONUS),
      variables: options.variables,
      registry: options.registry ?? createDefaultActionRegistry(),
      resolveType: options.resolveType,
      rng: options.rng,
      messages: [] as RecordedMessage[],
      endTurn: { allowed: true },
      endTurnForced: false,
      choices: [],
      usedItems: new Set(),
      turnLimit: -1,
      actionCanceled: false,
      objectivesConfigBySide: new Map(),
      objectivesChanged: new Set(),
      items: new ItemStore(),
      labels: new LabelStore(),
      music: options.music ?? new MusicList({ random: (max) => Math.floor(Math.random() * (max + 1)) }),
      sounds: [],
      soundSources: new SoundSourceStore(),
      playSound: (request) => {
        this.ctx.sounds.push(request);
        if (this.ctx.sounds.length > MAX_RECORDED_SOUNDS) this.ctx.sounds.splice(0, this.ctx.sounds.length - MAX_RECORDED_SOUNDS);
        this.ctx.onSound?.(request);
      },
      objectivesBySide: new Map(),
      menuItems: new Map(),
      loc1: Location.NULL,
      loc2: Location.NULL,
      eventData: new WmlConfig(),
      exit: { type: 'none' },
      raise: (name, loc1 = Location.NULL, loc2 = Location.NULL, data = new WmlConfig()) => {
        this.queue.push({ name: standardizeEventName(name), id: '', loc1, loc2, data });
      },
      fireNow: (name, loc1 = Location.NULL, loc2 = Location.NULL, data = new WmlConfig(), id = '') =>
        this.fireNowFlow(name, loc1, loc2, data, id),
      addEvent: (cfg) => this.manager.addFromWml(cfg) !== undefined,
      removeEvent: (id) => this.manager.removeById(id),
      skipMessages: false,
      setUndoable: (undoable) => {
        this.undoDisabled[this.undoDisabled.length - 1] = !undoable;
      },
      gameStarted: true,
      log: options.log ?? (() => {}),
    };
  }

  raise(name: string, loc1: Location = Location.NULL, loc2: Location = Location.NULL, data: WmlConfig = new WmlConfig()): void {
    this.ctx.raise(name, loc1, loc2, data);
  }

  raiseById(name: string, id: string, loc1: Location = Location.NULL, loc2: Location = Location.NULL, data: WmlConfig = new WmlConfig()): void {
    this.queue.push({ name: standardizeEventName(name), id, loc1, loc2, data });
  }

  /** Whether any event handler ran since the last call without `[allow_undo]`; resets the flag. */
  takeUndoDisabled(): boolean {
    const disabled = this.undoDisabled[0]!;
    this.undoDisabled[0] = false;
    return disabled;
  }

  /**
   * Raises then immediately drains the queue, answering any interaction
   * inline (`autoRespond` unless a caller supplies its own). Mirrors
   * `wml_event_pump::fire`, and is the form every headless caller uses.
   */
  fire(name: string, loc1?: Location, loc2?: Location, data?: WmlConfig, respond?: Responder): void {
    runFlow(this.fireFlow(name, loc1, loc2, data), respond);
  }

  /** `fire`, suspendably: the caller drives the generator and answers each interaction itself. */
  *fireFlow(name: string, loc1?: Location, loc2?: Location, data?: WmlConfig): Flow {
    this.raise(name, loc1, loc2, data);
    yield* this.pumpFlow();
  }

  /**
   * Fires one event *now*, on top of whatever is already queued, and
   * drains it completely before returning -- upstream's recursive
   * `wml_event_pump::operator()()` with its own nested `pump_manager`.
   * Backs `ctx.fireNow` (`[fire_event]`, `[kill] fire_event=yes`).
   */
  *fireNowFlow(name: string, loc1: Location, loc2: Location, data: WmlConfig, id: string): Flow {
    const outer = this.queue;
    this.queue = [{ name: standardizeEventName(name), id, loc1, loc2, data }];
    try {
      yield* this.pumpFlow();
    } finally {
      this.queue = outer;
    }
  }

  /**
   * Runs `cfg` the way an event handler's body runs -- event locations set,
   * `$x1`/`$y1`/`$x2`/`$y2` bound, its own undo context -- then drains
   * whatever it raised. For a `[set_menu_item]`'s `[command]`, which
   * upstream fires as the event `menu item <id>` rather than calling directly.
   */
  *runAsHandlerFlow(cfg: WmlConfig, loc1: Location, loc2: Location): Flow {
    this.ctx.loc1 = loc1;
    this.ctx.loc2 = loc2;
    this.ctx.eventData = new WmlConfig();
    this.ctx.exit = { type: 'none' };
    this.ctx.variables.set('x1', loc1.valid() ? loc1.wmlX : 0);
    this.ctx.variables.set('y1', loc1.valid() ? loc1.wmlY : 0);
    this.ctx.variables.set('x2', loc2.valid() ? loc2.wmlX : 0);
    this.ctx.variables.set('y2', loc2.valid() ? loc2.wmlY : 0);
    const outerSkip = this.ctx.skipMessages;
    this.ctx.skipMessages = false;
    this.undoDisabled.push(true);
    const restoreUnit = this.bindEventUnit('unit', loc1);
    const restoreSecond = this.bindEventUnit('second_unit', loc2);
    try {
      yield* runActionFlow(cfg, this.ctx);
    } finally {
      restoreSecond();
      restoreUnit();
      this.ctx.skipMessages = outerSkip;
      const disabled = this.undoDisabled.pop()!;
      this.undoDisabled[this.undoDisabled.length - 1] ||= disabled;
    }
    yield* this.pumpFlow();
  }

  /**
   * Drains the event queue, answering any interaction inline. The
   * pre-Phase-17 shape, kept for every headless caller (tests, the
   * snapshot builder, the AI host).
   */
  pump(respond?: Responder): void {
    runFlow(this.pumpFlow(), respond);
  }

  /**
   * Drains the event queue, suspending whenever a handler needs the
   * player or the display (see interaction.ts). Mirrors
   * `wml_event_pump::operator()()` + `pump_manager`'s swap-based
   * batching: each iteration snapshots and clears the current queue and
   * processes every event in it, with anything those handlers `raise()`
   * landing in the NEXT snapshot; `ctx.fireNow` is the other half of
   * upstream's model, running a nested pump immediately.
   */
  *pumpFlow(): Flow {
    this.nesting++;
    try {
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
            yield* this.processEvent(handler, ev);
          }
        }
      }
    } finally {
      this.nesting--;
    }
  }

  /**
   * `scoped_xy_unit`: binds `$<name>` to the unit standing at `loc` for the
   * duration of one handler -- filter included, as upstream binds it before
   * `filter_event` -- and returns the function that puts back whatever the
   * variable held before. Real content leans on it: `LIMIT_RECRUITS` counts
   * recruits by `$unit.type`, so without it the limit never triggered.
   * No unit there: the variable is left alone, as upstream's own "failed to
   * auto-store" path does.
   */
  private bindEventUnit(name: string, loc: Location): () => void {
    const unit = loc.valid() ? this.ctx.board.unitAt(loc) : undefined;
    if (!unit) return () => {};
    const previous = [...this.ctx.variables.getArray(name)];
    this.ctx.variables.setArray(name, [unitToVarNode(unit)]);
    return () => {
      if (previous.length > 0) this.ctx.variables.setArray(name, previous);
      else this.ctx.variables.clear(name);
    };
  }

  /** Mirrors `wml_event_pump::process_event`: bind `$unit`/`$second_unit`, filter, then (if first-time-only) disable, then run the body. */
  private *processEvent(handler: WmlEventHandler, ev: QueuedEvent): Flow {
    const restoreUnit = this.bindEventUnit('unit', ev.loc1);
    const restoreSecond = this.bindEventUnit('second_unit', ev.loc2);
    try {
      yield* this.processBoundEvent(handler, ev);
    } finally {
      restoreSecond();
      restoreUnit();
    }
  }

  private *processBoundEvent(handler: WmlEventHandler, ev: QueuedEvent): Flow {
    if (!this.filterEvent(handler, ev)) return;
    if (!handler.repeatable) handler.disabled = true;

    this.ctx.loc1 = ev.loc1;
    this.ctx.loc2 = ev.loc2;
    this.ctx.eventData = ev.data;
    this.ctx.exit = { type: 'none' };

    // `context::scoped` (pump.cpp:324-343): a nested event inherits the
    // enclosing one's skip-messages flag, a fresh top-level one starts
    // without it. `nesting === 1` is the top-level pump; anything deeper
    // got there through `fireNow`.
    const outerSkip = this.ctx.skipMessages;
    if (this.nesting <= 1) this.ctx.skipMessages = false;
    this.undoDisabled.push(true);
    try {
      yield* runActionFlow(handler.rawCfg, this.ctx);
    } finally {
      this.ctx.skipMessages = outerSkip;
      const disabled = this.undoDisabled.pop()!;
      this.undoDisabled[this.undoDisabled.length - 1] ||= disabled;
    }
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
