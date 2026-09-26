/**
 * Phase 18: map items (`data/lua/wml/items.lua`) -- images and halos placed
 * on hexes by `[item]`, removed by `[remove_item]`, listed by
 * `[store_items]`, and saved with the game as upstream's persistent
 * `[item]`/`[next_item_name]` tags (scenario-level `[item]`s are read the
 * same way when the scenario starts).
 *
 * Each hex keeps its items in the order they were added (`scenario_items`);
 * the view draws them by `z_order=` (`display::add_overlay`). Who sees one
 * is settled when it is added: `[filter_team]` (a side filter) becomes the
 * matching sides' team names, else `team_name=` (`intf_add_tile_overlay`).
 */
import { WmlConfig } from '../wml/config.js';
import type { EventContext } from './context.js';
import { Location } from '../model/Location.js';
import { findLocations } from './filter.js';
import { findSides } from './sideFilter.js';

/** One item on a hex, as `scenario_items` stores it (and as `[store_items]`/saves write it). */
export interface MapItem {
  readonly loc: Location;
  readonly image: string;
  readonly halo: string;
  /** The raw `team_name=` (saved/stored as given). */
  readonly teamName: string;
  readonly filterTeam?: WmlConfig;
  /** Team names that see it (resolved from `[filter_team]` or `team_name=`); empty: everyone. */
  readonly overlayTeamName: string;
  /** `visible_in_fog=`, default yes. */
  readonly visibleInFog: boolean;
  readonly submerge: number;
  readonly redraw?: boolean;
  readonly name: string;
  readonly zOrder: number;
  readonly variables?: WmlConfig;
}

/** The items on the board and upstream's `next_item_name` counter. */
export class ItemStore {
  private readonly byHex = new Map<string, MapItem[]>();
  nextItemName = 0;

  at(loc: Location): readonly MapItem[] {
    return this.byHex.get(loc.key()) ?? [];
  }

  /** Every item, hex by hex in the order hexes first got one. */
  all(): MapItem[] {
    return [...this.byHex.values()].flat();
  }

  clear(): void {
    this.byHex.clear();
  }

  add(item: MapItem): void {
    const list = this.byHex.get(item.loc.key());
    if (list) list.push(item);
    else this.byHex.set(item.loc.key(), [item]);
  }

  /** `wesnoth.interface.remove_item`: the items named `name` (by image, halo or name), or all of them. */
  remove(loc: Location, name?: string): void {
    const list = this.byHex.get(loc.key());
    if (!list) return;
    if (name) {
      for (let i = list.length - 1; i >= 0; i--) {
        const it = list[i]!;
        if (it.image === name || it.halo === name || it.name === name) list.splice(i, 1);
      }
    }
    if (!name || list.length === 0) this.byHex.delete(loc.key());
  }
}

/** `add_overlay`: names the item (`item_N`) if it has no name, settles who sees it, and stores it. */
export function addItem(ctx: EventContext, loc: Location, cfg: WmlConfig): MapItem {
  let name = cfg.getString('name', '');
  if (!cfg.hasAttribute('name')) name = `item_${ctx.items.nextItemName++}`;
  const filterTeam = cfg.child('filter_team');
  const overlayTeamName = filterTeam
    ? findSides(ctx.board, ctx.variables.expandConfigDeep(filterTeam))
        .map((side) => ctx.board.getTeam(side)!.teamName)
        .join(',')
    : cfg.getString('team_name', '');
  const variables = cfg.child('variables');
  const item: MapItem = {
    loc,
    image: cfg.getString('image', ''),
    halo: cfg.getString('halo', ''),
    teamName: cfg.getString('team_name', ''),
    ...(filterTeam ? { filterTeam: filterTeam.clone() } : {}),
    overlayTeamName,
    visibleInFog: cfg.getBoolean('visible_in_fog', true),
    submerge: cfg.getNumber('submerge', 0),
    ...(cfg.hasAttribute('redraw') ? { redraw: cfg.getBoolean('redraw') } : {}),
    name,
    zOrder: cfg.getNumber('z_order', 0),
    ...(variables ? { variables: variables.clone() } : {}),
  };
  ctx.items.add(item);
  return item;
}

/** An item as `scenario_items` holds it: what `[store_items]` and saves write. */
export function itemToConfig(item: MapItem): WmlConfig {
  const out = new WmlConfig();
  out.setAttribute('x', item.loc.wmlX);
  out.setAttribute('y', item.loc.wmlY);
  if (item.image) out.setAttribute('image', item.image);
  if (item.halo) out.setAttribute('halo', item.halo);
  if (item.teamName) out.setAttribute('team_name', item.teamName);
  if (item.filterTeam) out.addChild('filter_team', item.filterTeam.clone());
  out.setAttribute('visible_in_fog', item.visibleInFog);
  if (item.submerge) out.setAttribute('submerge', item.submerge);
  if (item.redraw !== undefined) out.setAttribute('redraw', item.redraw);
  out.setAttribute('name', item.name);
  if (item.zOrder) out.setAttribute('z_order', item.zOrder);
  out.addChild('variables', item.variables?.clone() ?? new WmlConfig());
  return out;
}

/** `persistent_tags.item.read`: an `[item]` from the scenario or a save, placed as written (`name=""` if it had none). */
export function readPersistentItem(ctx: EventContext, cfg: WmlConfig): void {
  const withName = cfg.clone();
  if (!withName.hasAttribute('name')) withName.setAttribute('name', '');
  addItem(ctx, Location.fromWml(cfg.getNumber('x'), cfg.getNumber('y')), withName);
}

/** `wml_actions.item`: the item on every hex the tag matches; `write_name=` stores its name. */
export function actionItem(cfg: WmlConfig, ctx: EventContext): void {
  const parsed = ctx.variables.expandConfigDeep(cfg);
  if (!parsed.hasAttribute('image') && !parsed.hasAttribute('halo')) {
    ctx.log('error', '[item] missing required image= and halo= attributes.');
    return;
  }
  // One name for every hex, as the Lua sets cfg.name on the first add.
  const named = parsed.clone();
  for (const loc of findLocations(ctx.board, parsed)) {
    const item = addItem(ctx, loc, named);
    if (!named.hasAttribute('name')) named.setAttribute('name', item.name);
  }
  const writeName = parsed.getString('write_name', '');
  if (writeName !== '' && named.hasAttribute('name')) ctx.variables.set(writeName, named.getString('name'));
}

/** `wml_actions.remove_item`: the `image=` named items (or all) on every matching hex. */
export function actionRemoveItem(cfg: WmlConfig, ctx: EventContext): void {
  const parsed = ctx.variables.expandConfigDeep(cfg);
  const name = parsed.getString('image', '') || undefined;
  for (const loc of findLocations(ctx.board, parsed)) ctx.items.remove(loc, name);
}

/** `wml_actions.store_items`: the items on the matching hexes (only `item_name=`'s, if given) into `$variable` (default `items`). */
export function actionStoreItems(cfg: WmlConfig, ctx: EventContext): void {
  const parsed = ctx.variables.expandConfigDeep(cfg);
  const variable = parsed.getString('variable', 'items');
  const itemName = parsed.hasAttribute('item_name') ? parsed.getString('item_name') : undefined;
  ctx.variables.clear(variable);
  let index = 0;
  const locs = findLocations(ctx.board, parsed).sort((a, b) => a.x - b.x || a.y - b.y);
  for (const loc of locs) {
    for (const item of ctx.items.at(loc)) {
      if (itemName === undefined || item.name === itemName) ctx.variables.setConfig(`${variable}[${index++}]`, itemToConfig(item));
    }
  }
}
