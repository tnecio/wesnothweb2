/**
 * Phase 18d: WML action tags upstream defines in Lua (`data/lua/wml-tags.lua`)
 * or in `action_wml.cpp`, that the shipped scenarios use and the port lacked
 * (see `docs/WML_AUDIT.md`): the `[store_*]` family, `[set_recruit]`,
 * `[hide_unit]`/`[unhide_unit]`, `[put_to_recall_list]`, `[unit_worth]`,
 * `[modify_turns]` and `[wml_message]`.
 *
 * Sides are picked by the full side filter (`wesnoth.sides.find(cfg)`, see
 * `sideFilter.ts`), units by the unit filter over the tag's own config
 * (`wesnoth.units.find_on_map(cfg)`), locations by the location filter
 * (`wesnoth.map.find(cfg)`). Stored locations come out sorted by (x, y), as
 * `location_filter::get_locations` returns a `std::set<map_location>`.
 */
import { WmlConfig } from '../wml/config.js';
import type { EventContext } from './context.js';
import type { Location } from '../model/Location.js';
import { UnitStatus } from '../model/Unit.js';
import { applyModifier } from '../model/UnitType.js';
import { BASE_INCOME } from '../actions/carryover.js';
import { findLocations, findUnits } from './filter.js';
import { findSides } from './sideFilter.js';

/** The tag's config with variables substituted throughout, filter children included (`wml.parsed`). */
const parsed = (cfg: WmlConfig, ctx: EventContext) => ctx.variables.expandConfigDeep(cfg);

export function sidesFor(cfg: WmlConfig, ctx: EventContext): number[] {
  return findSides(ctx.board, cfg, (msg) => ctx.log('error', msg));
}

/**
 * `utils.vwriter`: writes `items` to `variable=` (else `defaultVariable`)
 * by `mode=`: `always_clear` (default) clears it first, `append` adds after
 * what is there, `replace` overwrites from index 0 keeping any tail. A
 * variable ending in an explicit `[index]` is always written in place.
 */
export function writeContainers(cfg: WmlConfig, ctx: EventContext, defaultVariable: string, items: readonly WmlConfig[]): void {
  const variable = cfg.getString('variable', defaultVariable);
  if (variable.endsWith(']')) {
    for (const item of items) ctx.variables.setConfig(variable, item);
    return;
  }
  const mode = cfg.getString('mode', 'always_clear');
  let index = 0;
  if (mode === 'append') index = ctx.variables.arrayLength(variable);
  else if (mode !== 'replace') ctx.variables.clear(variable);
  for (const item of items) ctx.variables.setConfig(`${variable}[${index++}]`, item);
}

const byXY = (a: Location, b: Location) => a.x - b.x || a.y - b.y;

/** `{ x, y, terrain [, owner_side] }` as the store tags write a hex (`owner_side` only for villages). */
function locationContainer(ctx: EventContext, loc: Location, alwaysOwner = false): WmlConfig {
  const out = new WmlConfig();
  out.setAttribute('x', loc.wmlX);
  out.setAttribute('y', loc.wmlY);
  out.setAttribute('terrain', ctx.board.map.getTerrain(loc).toString());
  if (alwaysOwner || ctx.board.map.isVillage(loc)) out.setAttribute('owner_side', ctx.board.villageOwner(loc) ?? 0);
  return out;
}

export function actionStoreStartingLocation(raw: WmlConfig, ctx: EventContext): void {
  const cfg = parsed(raw, ctx);
  const items: WmlConfig[] = [];
  for (const side of sidesFor(cfg, ctx)) {
    const loc = ctx.board.map.startingPosition(side);
    if (!ctx.board.map.onBoard(loc)) continue; // SIDE_GETTER starting_location: nil off the board
    items.push(locationContainer(ctx, loc));
  }
  writeContainers(cfg, ctx, 'location', items);
}

export function actionStoreLocations(raw: WmlConfig, ctx: EventContext): void {
  const cfg = parsed(raw, ctx);
  // Found before the variable is cleared: the filter may name it in find_in=.
  const locs = findLocations(ctx.board, cfg).sort(byXY);
  writeContainers(cfg, ctx, 'location', locs.map((loc) => locationContainer(ctx, loc)));
}

export function actionStoreVillages(raw: WmlConfig, ctx: EventContext): void {
  const cfg = parsed(raw, ctx);
  const inFilter = new Set(findLocations(ctx.board, cfg).map((l) => l.key()));
  const villages = ctx.board.map.villages.filter((v) => inFilter.has(v.key())).sort(byXY);
  writeContainers(cfg, ctx, 'location', villages.map((loc) => locationContainer(ctx, loc, true)));
}

export function actionStoreUnitType(raw: WmlConfig, ctx: EventContext): void {
  const cfg = parsed(raw, ctx);
  const types = cfg.getString('type', '');
  if (types === '') {
    ctx.log('error', '[store_unit_type] missing required type= attribute.');
    return;
  }
  const items: WmlConfig[] = [];
  for (const id of types.split(',').map((t) => t.trim()).filter((t) => t !== '')) {
    const typeCfg = ctx.unitTypeConfig?.(id);
    if (!typeCfg) {
      ctx.log('error', `Attempt to store nonexistent unit type '${id}'.`);
      return;
    }
    items.push(typeCfg);
  }
  writeContainers(cfg, ctx, 'unit_type', items);
}

/** `[store_side]`: the side's `__cfg`, plus the economy fields `__cfg` does not carry (`wml-tags.lua`). */
export function actionStoreSide(raw: WmlConfig, ctx: EventContext): void {
  const cfg = parsed(raw, ctx);
  const items: WmlConfig[] = [];
  for (const side of sidesFor(cfg, ctx)) {
    const t = ctx.board.getTeam(side)!;
    const units = ctx.board.unitsForSide(side);
    const villages = ctx.board.villageCount(side);
    const baseIncome = t.income + BASE_INCOME;
    const totalIncome = baseIncome + villages * t.incomePerVillage;
    const totalUpkeep = units.reduce((sum, u) => sum + u.upkeepCost, 0);
    const expenses = Math.max(0, totalUpkeep - villages * t.supportPerVillage);
    const out = new WmlConfig();
    out.setAttribute('side', side);
    out.setAttribute('gold', t.gold);
    out.setAttribute('team_name', t.teamName);
    out.setAttribute('user_team_name', t.userTeamName);
    out.setAttribute('side_name', t.sideName);
    out.setAttribute('faction', t.faction);
    out.setAttribute('save_id', t.saveId);
    out.setAttribute('controller', t.controller);
    out.setAttribute('color', t.color);
    out.setAttribute('flag', t.flag);
    out.setAttribute('recruit', [...t.canRecruit].join(','));
    out.setAttribute('village_gold', t.incomePerVillage);
    out.setAttribute('village_support', t.supportPerVillage);
    out.setAttribute('recall_cost', t.recallCost);
    out.setAttribute('fog', t.fog.enabled);
    out.setAttribute('shroud', t.shroud.enabled);
    out.setAttribute('hidden', t.hidden);
    out.setAttribute('persistent', t.persistent);
    out.setAttribute('lost', t.lost);
    out.setAttribute('income', totalIncome);
    out.setAttribute('base_income', baseIncome);
    out.setAttribute('net_income', totalIncome - expenses);
    out.setAttribute('expenses', expenses);
    out.setAttribute('total_upkeep', totalUpkeep);
    out.setAttribute('num_units', units.length);
    out.setAttribute('num_villages', villages);
    items.push(out);
  }
  writeContainers(cfg, ctx, 'side', items);
}

export function actionStoreTurns(raw: WmlConfig, ctx: EventContext): void {
  const cfg = parsed(raw, ctx);
  ctx.variables.set(cfg.getString('variable', 'turns'), ctx.turnLimit);
}

/** `[unit_worth]`: the first matching unit's worth, into `$cost`, `$next_cost`, `$health`, `$experience`, `$recall_cost`, `$unit_worth`. */
export function actionUnitWorth(raw: WmlConfig, ctx: EventContext): void {
  const u = findUnits(ctx.board, parsed(raw, ctx))[0];
  if (!u) {
    ctx.log('error', "[unit_worth]'s filter didn't match any unit");
    return;
  }
  const ut = u.type;
  const hp = u.hitpoints / u.maxHitpoints;
  const xp = u.experience / u.maxExperience;
  let bestAdv = ut.cost;
  for (const id of ut.advancesTo) {
    try {
      bestAdv = Math.max(bestAdv, ctx.resolveType(id).cost);
    } catch {
      // `wesnoth.unit_types[w]` nil: skipped.
    }
  }
  ctx.variables.set('cost', ut.cost);
  ctx.variables.set('next_cost', bestAdv);
  ctx.variables.set('health', Math.floor(hp * 100));
  ctx.variables.set('experience', Math.floor(xp * 100));
  ctx.variables.set('recall_cost', ut.recallCost);
  ctx.variables.set('unit_worth', Math.floor(Math.max(ut.cost * hp, bestAdv * xp)));
}

export function actionSetRecruit(raw: WmlConfig, ctx: EventContext): void {
  const cfg = parsed(raw, ctx);
  if (!cfg.hasAttribute('recruit')) {
    ctx.log('error', '[set_recruit] missing required recruit= attribute');
    return;
  }
  const recruit = cfg.getString('recruit').split(',').map((r) => r.trim()).filter((r) => r !== '');
  for (const side of sidesFor(cfg, ctx)) {
    const team = ctx.board.getTeam(side);
    if (team) team.canRecruit = new Set(recruit);
  }
}

export function actionHideUnit(raw: WmlConfig, ctx: EventContext): void {
  for (const u of findUnits(ctx.board, parsed(raw, ctx))) u.hidden = true;
}

export function actionUnhideUnit(raw: WmlConfig, ctx: EventContext): void {
  for (const u of findUnits(ctx.board, parsed(raw, ctx))) u.hidden = false;
}

/** `[put_to_recall_list]`: matching map units go to their side's recall list, `heal=yes` refreshing them first. */
export function actionPutToRecallList(raw: WmlConfig, ctx: EventContext): void {
  const cfg = parsed(raw, ctx);
  const heal = cfg.getBoolean('heal', false);
  for (const u of findUnits(ctx.board, cfg)) {
    if (heal) {
      u.hitpoints = u.maxHitpoints;
      u.movesLeft = u.maxMoves;
      u.attacksLeft = u.maxAttacksPerTurn;
      u.setStatus(UnitStatus.Poisoned, false);
      u.setStatus(UnitStatus.Slowed, false);
    }
    ctx.board.removeUnitAt(u.location);
    ctx.board.addToRecallList(u.side, u);
  }
}

/**
 * `[modify_turns]` (`action_wml.cpp`): `add=` (a modifier, `tod_manager::
 * modify_turns_by_wml`) or else `value=` sets the limit (never below -1,
 * "none"); then `current=` moves the game to that turn, if it is in range.
 */
export function actionModifyTurns(raw: WmlConfig, ctx: EventContext): void {
  const cfg = parsed(raw, ctx);
  const add = cfg.getString('add', '');
  if (add !== '') ctx.turnLimit = Math.max(applyModifier(ctx.turnLimit, add, 0), -1);
  else if (cfg.getString('value', '') !== '') ctx.turnLimit = Math.max(cfg.getNumber('value', -1), -1);
  if (cfg.getString('current', '') !== '') {
    const current = ctx.turnNumber?.() ?? ctx.variables.getNumber('turn_number', 1);
    const next = cfg.getNumber('current', current);
    if (next < 1 || (ctx.turnLimit !== -1 && next > ctx.turnLimit)) {
      ctx.log('error', `attempted to change current turn number to one out of range (${next})`);
    } else if (next !== current) {
      ctx.setTurnNumber?.(next);
    }
  }
}

/** `[wml_message]`: `wesnoth.log(logger, message)`. */
export function actionWmlMessage(raw: WmlConfig, ctx: EventContext): void {
  const cfg = parsed(raw, ctx);
  const logger = cfg.getString('logger', 'info');
  const level = logger.startsWith('err') ? 'error' : logger.startsWith('warn') ? 'warn' : logger === 'debug' ? 'debug' : 'info';
  ctx.log(level, cfg.getString('message', ''));
}
