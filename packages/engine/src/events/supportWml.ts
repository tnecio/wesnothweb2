/**
 * Phase 28c: mainline action tags the next campaigns use (The South Guard first), ported from upstream:
 *
 * - `[set_global_variable]`/`[get_global_variable]`/`[clear_global_variable]` (`persist_var.cpp`):
 *   variables kept across games, per `namespace=`, through `EventContext.persistent`;
 * - `[unsynced]` (`wml-tags.lua`): its body, run as `[command]`;
 * - `[allow_end_turn]`/`[disallow_end_turn]` (`wesnoth.interface.allow_end_turn`): `EventContext.endTurn`;
 * - `[allow_extra_recruit]`/`[disallow_extra_recruit]`/`[set_extra_recruit]` (`wml-tags.lua`): a unit's own
 *   `extra_recruit=`;
 * - `[end_turn]` (`wml-tags.lua`, `wesnoth.interface.end_turn`): `EventContext.endTurnForced`;
 * - `[petrify]`/`[unpetrify]` (`wml-tags.lua`): the `petrified` status, on the map and on recall lists;
 * - `[do_command]` (`action_wml.cpp`): player commands from WML, through `EventContext.doCommand`;
 * - `[story]` (`wml-tags.lua`, `gui.show_story`): a story screen mid-scenario, as a `story` beat;
 * - `[floating_text]`/`[print]` (`wml-tags.lua`): floating labels (`floatingLabels.ts`);
 * - `[set_achievement]`/`[set_sub_achievement]`/`[progress_achievement]` (`wml-tags.lua`), through
 *   `EventContext.achievements`;
 * - `[replace_map]` (`action_wml.cpp`), `GameBoard.replaceMap`;
 * - `[open_help]` (`wml-tags.lua`, `gui.show_help`): the help browser, as an `openHelp` beat (Phase 24);
 * - `[change_theme]`: this port has no themes, so it logs and does nothing (as a presentation tag with
 *   nothing to show would).
 *
 * `[harm_unit]` is `harmUnitWml.ts`.
 */

import type { EventContext } from './context.js';
import { WmlConfig } from '../wml/config.js';
import { TString } from '../i18n/tstring.js';
import type { Flow } from './interaction.js';
import { runActionFlow } from './actionWml.js';
import { findUnits } from './filter.js';
import { UnitStatus } from '../model/Unit.js';
import { varNodeFromConfig } from './variables.js';
import { actionHarmUnit } from './harmUnitWml.js';
import { resolveStory } from '../story/storyParser.js';
import { actionFloatingText, actionPrint } from './floatingLabels.js';

/** Where `[set_global_variable]` keeps its values (upstream: a `persist_context` file per namespace). */
export interface PersistentVariables {
  /** The stored value: `name=` holds a scalar, or `[name]` children an array. Undefined when never set. */
  get(namespace: string, name: string): WmlConfig | undefined;
  set(namespace: string, name: string, value: WmlConfig): void;
  clear(namespace: string, name: string): void;
}

/** An in-memory `PersistentVariables`, for headless runs and tests. */
export function memoryPersistentVariables(): PersistentVariables {
  const store = new Map<string, WmlConfig>();
  const key = (ns: string, name: string) => `${ns}\u0000${name}`;
  return {
    get: (ns, name) => store.get(key(ns, name))?.clone(),
    set: (ns, name, value) => void store.set(key(ns, name), value.clone()),
    clear: (ns, name) => void store.delete(key(ns, name)),
  };
}

/** Where `[set_achievement]` and friends report (upstream: `wesnoth.achievements`, saved per player). */
export interface AchievementSink {
  set(contentFor: string, id: string): void;
  setSub(contentFor: string, id: string, subId: string): void;
  progress(contentFor: string, id: string, amount: number, limit: number): void;
}

function requireAttrs(cfg: WmlConfig, ctx: EventContext, tag: string, names: readonly string[]): boolean {
  const missing = names.filter((n) => !cfg.hasAttribute(n));
  for (const n of missing) ctx.log('error', `[${tag}] missing required attribute "${n}"`);
  return missing.length === 0;
}

/** `verify_and_set_global_variable` -> `set_global_variable`. */
function actionSetGlobalVariable(cfg: WmlConfig, ctx: EventContext): void {
  if (!requireAttrs(cfg, ctx, 'set_global_variable', ['to_global', 'namespace'])) return;
  const store = ctx.persistent;
  if (!store) {
    ctx.log('warn', '[set_global_variable]: no persistent storage here (skipped)');
    return;
  }
  const ns = cfg.getString('namespace');
  const global = cfg.getString('to_global');
  const local = cfg.getString('from_local', '');
  if (local === '') {
    store.clear(ns, global);
    return;
  }
  const value = new WmlConfig();
  const array = ctx.variables.arrayLength(local);
  if (array === 0) {
    // pack_scalar(global, get_variable(local).t_str())
    const raw = ctx.variables.getRaw(local);
    value.setAttribute(global, raw === undefined ? '' : raw instanceof TString ? raw : String(raw));
  } else {
    for (let i = 0; i < array; i++) value.addChild(global, ctx.variables.getConfig(`${local}[${i}]`) ?? new WmlConfig());
  }
  store.set(ns, global, value);
}

/** `verify_and_get_global_variable` -> `get_global_variable`. */
function actionGetGlobalVariable(cfg: WmlConfig, ctx: EventContext): void {
  if (!requireAttrs(cfg, ctx, 'get_global_variable', ['from_global', 'to_local', 'namespace'])) return;
  const global = cfg.getString('from_global');
  const local = cfg.getString('to_local');
  const value = ctx.persistent?.get(cfg.getString('namespace'), global) ?? new WmlConfig();
  const items = value.children(global);
  if (items.length === 0) {
    ctx.variables.set(local, value.getRaw(global) ?? '');
  } else {
    ctx.variables.clear(local);
    for (const item of items) ctx.variables.pushArray(local, varNodeFromConfig(item));
  }
}

/** `verify_and_clear_global_variable` -> `clear_global_variable`. */
function actionClearGlobalVariable(cfg: WmlConfig, ctx: EventContext): void {
  if (!requireAttrs(cfg, ctx, 'clear_global_variable', ['global', 'namespace'])) return;
  ctx.persistent?.clear(cfg.getString('namespace'), cfg.getString('global'));
}

/** `wml_actions.unsynced`: the body, as `[command]` (this port has no networked sync to leave). */
function* actionUnsynced(cfg: WmlConfig, ctx: EventContext): Flow {
  yield* runActionFlow(cfg, ctx);
}

/** `wml_actions.allow_end_turn`. */
function actionAllowEndTurn(_cfg: WmlConfig, ctx: EventContext): void {
  ctx.endTurn = { allowed: true };
}

/** `wml_actions.disallow_end_turn`: `reason=` is what the player is told on trying. */
function actionDisallowEndTurn(cfg: WmlConfig, ctx: EventContext): void {
  ctx.endTurn = { allowed: false, reason: cfg.getTString('reason') };
}

/**
 * `wml_actions.petrify`/`unpetrify`: the matching units on the map, then on the recall lists (where upstream
 * passes the same filter, wrapped in `[and]` for `[petrify]`), get or lose the `petrified` status.
 */
function setPetrified(cfg: WmlConfig, ctx: EventContext, petrified: boolean): void {
  for (const unit of findUnits(ctx.board, cfg, true)) unit.setStatus(UnitStatus.Petrified, petrified);
}

/** The commands `[do_command]` may run (`action_wml.cpp`). */
const DO_COMMAND_TAGS = new Set(['attack', 'move', 'recruit', 'recall', 'disband', 'fire_event', 'custom_command']);

/**
 * `[do_command]` (`action_wml.cpp`): each child runs as the same command a player's action records, events
 * and all. Inside an action (an event) it is part of that action; otherwise it is recorded as its own.
 */
function* actionDoCommand(cfg: WmlConfig, ctx: EventContext): Flow {
  for (const { tag, config } of cfg.allChildren()) {
    if (!DO_COMMAND_TAGS.has(tag)) {
      ctx.log('error', `unsupported tag [${tag}] in [do_command]; allowed tags: ${[...DO_COMMAND_TAGS].sort().join(' ')}`);
      continue;
    }
    if (!ctx.doCommand) {
      ctx.log('error', '[do_command]: no game to run commands in');
      return;
    }
    yield* ctx.doCommand(tag, ctx.variables.expandConfigDeep(config));
  }
}

/**
 * `wml_actions.story` (`gui.show_story(cfg, cfg.title or wesnoth.scenario.name)`): this `[story]`'s parts,
 * resolved now as the scenario's own are, shown on the story screen; the event waits for the player.
 */
function* actionStory(cfg: WmlConfig, ctx: EventContext): Flow {
  const title = cfg.hasAttribute('title') ? (cfg.getTString('title') ?? TString.literal(cfg.getString('title'))) : (ctx.scenarioName?.() ?? TString.literal(''));
  const holder = new WmlConfig();
  holder.addChild('story', cfg);
  const parts = resolveStory(holder, title, ctx);
  if (parts.length > 0) yield { kind: 'beat', beat: { kind: 'story', parts } };
}

/** `wml_actions.end_turn`: `wesnoth.interface.end_turn()`, `play_controller::force_end_turn`. */
function actionEndTurn(_cfg: WmlConfig, ctx: EventContext): void {
  ctx.endTurnForced = true;
}

function splitList(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/** `wml_actions.set_extra_recruit`: each matching unit on the map may recruit exactly these types. */
function actionSetExtraRecruit(cfg: WmlConfig, ctx: EventContext): void {
  if (!cfg.hasAttribute('extra_recruit')) {
    ctx.log('error', '[set_extra_recruit] missing required extra_recruit= attribute');
    return;
  }
  const recruits = splitList(cfg.getString('extra_recruit'));
  for (const unit of findUnits(ctx.board, cfg)) unit.extraRecruit = [...recruits];
}

/** `wml_actions.allow_extra_recruit`: each matching unit on the map may also recruit these types. */
function actionAllowExtraRecruit(cfg: WmlConfig, ctx: EventContext): void {
  if (!cfg.hasAttribute('extra_recruit')) {
    ctx.log('error', '[allow_extra_recruit] missing required extra_recruit= attribute');
    return;
  }
  const added = splitList(cfg.getString('extra_recruit'));
  for (const unit of findUnits(ctx.board, cfg)) unit.extraRecruit = [...unit.extraRecruit, ...added];
}

/** `wml_actions.disallow_extra_recruit`: removes the first occurrence of each named type. */
function actionDisallowExtraRecruit(cfg: WmlConfig, ctx: EventContext): void {
  if (!cfg.hasAttribute('extra_recruit')) {
    ctx.log('error', '[disallow_extra_recruit] missing required extra_recruit= attribute');
    return;
  }
  for (const unit of findUnits(ctx.board, cfg)) {
    const list = [...unit.extraRecruit];
    for (const type of splitList(cfg.getString('extra_recruit'))) {
      const i = list.indexOf(type);
      if (i >= 0) list.splice(i, 1);
    }
    unit.extraRecruit = list;
  }
}

function actionSetAchievement(cfg: WmlConfig, ctx: EventContext): void {
  ctx.achievements?.set(cfg.getString('content_for'), cfg.getString('id'));
}

function actionSetSubAchievement(cfg: WmlConfig, ctx: EventContext): void {
  ctx.achievements?.setSub(cfg.getString('content_for'), cfg.getString('id'), cfg.getString('sub_id'));
}

function actionProgressAchievement(cfg: WmlConfig, ctx: EventContext): void {
  const amount = Number(cfg.getString('amount'));
  if (!Number.isFinite(amount)) {
    ctx.log('error', `[progress_achievement] amount attribute not a number for content '${cfg.getString('content_for')}' and achievement '${cfg.getString('id')}'`);
    return;
  }
  const limit = Number(cfg.getString('limit'));
  ctx.achievements?.progress(cfg.getString('content_for'), cfg.getString('id'), amount, Number.isFinite(limit) && cfg.hasAttribute('limit') ? limit : 999999999);
}

/**
 * `WML_HANDLER_FUNCTION(replace_map)`: the map from `map_data=` (the snapshot builder inlines a
 * `map_file=`'s contents there, as upstream reads the file at this point), refused if it grows without
 * `expand=yes` or shrinks without `shrink=yes`. A village that is no longer one is lost; a unit that
 * would be off the map is put on its side's recall list.
 */
function* actionReplaceMap(cfg: WmlConfig, ctx: EventContext): Flow {
  const data = cfg.getString('map_data', '') || cfg.getString('map', '');
  if (data === '') {
    ctx.log('error', `replace_map: Unable to load map ${cfg.getString('map_file', '')}`);
    return;
  }
  const current = ctx.board.map;
  let map;
  try {
    map = current.parseSibling(data);
  } catch {
    ctx.log('error', 'replace_map: Unable to load map from inline data');
    return;
  }
  if ((map.totalWidth() > current.totalWidth() || map.totalHeight() > current.totalHeight()) && !cfg.getBoolean('expand', false)) {
    ctx.log('error', 'replace_map: Map dimension(s) increase but expand is not set');
    return;
  }
  if ((map.totalWidth() < current.totalWidth() || map.totalHeight() < current.totalHeight()) && !cfg.getBoolean('shrink', false)) {
    ctx.log('error', 'replace_map: Map dimension(s) decrease but shrink is not set');
    return;
  }
  ctx.board.replaceMap(map);
  // display::reload_map: the event goes on once the board shows the new map.
  yield { kind: 'beat', beat: { kind: 'mapReplaced' } };
}

/** `wml_actions.open_help`: `gui.show_help(cfg.topic)`, which the display shows until the player closes it. */
function* actionOpenHelp(cfg: WmlConfig): Flow {
  yield { kind: 'beat', beat: { kind: 'openHelp', topic: cfg.getString('topic') } };
}

function actionChangeTheme(cfg: WmlConfig, ctx: EventContext): void {
  ctx.log('debug', `[change_theme] theme=${cfg.getString('theme')}: themes are not ported (skipped)`);
}

export function registerSupportActions(register: (tag: string, handler: (cfg: WmlConfig, ctx: EventContext) => void | Flow) => void): void {
  register('set_global_variable', actionSetGlobalVariable);
  register('get_global_variable', actionGetGlobalVariable);
  register('clear_global_variable', actionClearGlobalVariable);
  register('unsynced', actionUnsynced);
  register('allow_end_turn', actionAllowEndTurn);
  register('disallow_end_turn', actionDisallowEndTurn);
  register('allow_extra_recruit', actionAllowExtraRecruit);
  register('disallow_extra_recruit', actionDisallowExtraRecruit);
  register('set_extra_recruit', actionSetExtraRecruit);
  register('end_turn', actionEndTurn);
  register('do_command', actionDoCommand);
  register('story', actionStory);
  register('floating_text', actionFloatingText);
  register('print', actionPrint);
  register('petrify', (cfg, ctx) => setPetrified(cfg, ctx, true));
  register('unpetrify', (cfg, ctx) => setPetrified(cfg, ctx, false));
  register('set_achievement', actionSetAchievement);
  register('set_sub_achievement', actionSetSubAchievement);
  register('progress_achievement', actionProgressAchievement);
  register('replace_map', actionReplaceMap);
  register('harm_unit', actionHarmUnit);
  register('open_help', actionOpenHelp);
  register('change_theme', actionChangeTheme);
}
