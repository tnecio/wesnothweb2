/**
 * TS port of upstream Wesnoth's terrain-code representation and matching
 * (src/terrain/translation.hpp/.cpp) plus the non-imagery parts of
 * `terrain_type`/`terrain_type_data` (src/terrain/terrain.hpp/.cpp,
 * src/terrain/type_data.hpp/.cpp).
 *
 * Deliberately NOT ported: `terrain/builder.cpp` (terrain *imagery*
 * layering -- which image tiles to draw for a given neighborhood of
 * terrain codes). That's a rendering concern for a later phase.
 *
 * ## Terrain code format
 *
 * A terrain code is a string of the form `BBBB` or `BBBB^OOOO`: a "base"
 * layer (2-4 chars, e.g. `Gg` grassland, `Ww` shallow water) and an
 * optional "overlay" layer after a caret (e.g. `Ff` forest, `Vh` village).
 * Upstream packs each layer's chars into a uint32 (first char in the
 * highest byte) purely so wildcard matching can be done with bitmasks; we
 * keep that exact packing (`TerLayer` below) rather than reinventing
 * matching semantics on top of plain strings, since the packed
 * representation is what upstream's `terrain_matches` wildcard rules
 * (`*`, `!`, layer-level wildcarding) are defined in terms of.
 *
 * `NO_LAYER` (all-ones) means "this code has no overlay at all" (e.g. plain
 * `Gg`). Verified directly against `string_to_number_`/`string_to_layer_` in
 * translation.cpp: an empty layer string (whether from omitting the `^`
 * entirely, or from a trailing `^` with nothing after it) both parse to
 * `NO_LAYER` -- there is no string spelling that produces the "explicit
 * empty overlay" state translation.hpp's doc comment mentions; that state
 * is only reachable by constructing a `TerrainCode` object directly with
 * `overlay: 0`, which we expose but which `parseTerrainCode` never
 * produces.
 */

import type { TString } from '../i18n/tstring.js';
import type { WmlConfig } from '../wml/config.js';

export type TerLayer = number; // uint32, held as a JS number via `>>> 0`

/** Sentinel: "no overlay layer at all" (upstream: 0xFFFFFFFF). */
export const NO_LAYER: TerLayer = 0xffffffff;

function stringToLayer(str: string): TerLayer {
  if (str.length === 0) return NO_LAYER;
  if (str.length > 4) {
    throw new Error(`A terrain layer with more than 4 characters was found: '${str}'`);
  }
  let result = 0;
  for (let i = 0; i < 4; i++) {
    const c = i < str.length ? str.charCodeAt(i) : 0;
    result = ((result << 8) + c) >>> 0;
  }
  return result;
}

function layerToString(layer: TerLayer): string {
  let out = '';
  for (let shift = 24; shift >= 0; shift -= 8) {
    const byte = (layer >>> shift) & 0xff;
    if (byte !== 0 && byte !== 0xff) out += String.fromCharCode(byte);
  }
  return out;
}

/** Mirrors `get_layer_mask_`: masks off everything from the first '*' byte onward. */
function getLayerMask(layer: TerLayer): TerLayer {
  if (((layer & 0xff000000) >>> 0) === 0x2a000000) return 0x00000000;
  if (((layer & 0x00ff0000) >>> 0) === 0x002a0000) return 0xff000000;
  if (((layer & 0x0000ff00) >>> 0) === 0x00002a00) return 0xffff0000;
  if (((layer & 0x000000ff) >>> 0) === 0x0000002a) return 0xffffff00;
  return 0xffffffff;
}

/** A terrain code: a base layer plus an optional overlay layer. Mirrors `t_translation::terrain_code`. */
export class TerrainCode {
  constructor(
    public readonly base: TerLayer,
    public readonly overlay: TerLayer = NO_LAYER,
  ) {}

  equals(other: TerrainCode): boolean {
    return this.base === other.base && this.overlay === other.overlay;
  }

  /** A string key suitable for use as a Map key (e.g. the terrain type registry). */
  key(): string {
    return `${this.base}^${this.overlay}`;
  }

  hasOverlay(): boolean {
    return this.overlay !== NO_LAYER;
  }

  toString(): string {
    return writeTerrainCode(this);
  }
}

/** Parse a single terrain code, e.g. "Gg", "Gg^Ff", "W*". */
export function parseTerrainCode(str: string, filler: TerLayer = NO_LAYER): TerrainCode {
  const trimmed = str.trim();
  if (trimmed.length === 0) return NONE_TERRAIN;
  const caret = trimmed.indexOf('^');
  if (caret !== -1) {
    return new TerrainCode(stringToLayer(trimmed.slice(0, caret)), stringToLayer(trimmed.slice(caret + 1)));
  }
  return new TerrainCode(stringToLayer(trimmed), filler);
}

/** Parse a comma-separated list of terrain codes, e.g. an `aliasof=` value. */
export function parseTerrainList(str: string, filler: TerLayer = NO_LAYER): TerrainCode[] {
  if (str.length === 0) return [];
  return str.split(',').map((chunk) => parseTerrainCode(chunk, filler));
}

export function writeTerrainCode(code: TerrainCode): string {
  let result = layerToString(code.base);
  if (code.overlay !== NO_LAYER) {
    result += '^' + layerToString(code.overlay);
  }
  return result;
}

/** `NONE_TERRAIN`: the default/empty terrain code (sentinel for "no terrain"). */
export const NONE_TERRAIN = new TerrainCode(0, NO_LAYER);

// Named terrain-code constants, ported verbatim from translation.cpp.
export const VOID_TERRAIN = parseTerrainCode('_s');
export const FOGGED = parseTerrainCode('_f');
export const OFF_MAP_USER = parseTerrainCode('_off^_usr');
export const HUMAN_CASTLE = parseTerrainCode('Ch');
export const HUMAN_KEEP = parseTerrainCode('Kh');
export const SHALLOW_WATER = parseTerrainCode('Ww');
export const DEEP_WATER = parseTerrainCode('Wo');
export const GRASS_LAND = parseTerrainCode('Gg');
export const FOREST = parseTerrainCode('Gg^Ff');
export const MOUNTAIN = parseTerrainCode('Mm');
export const HILL = parseTerrainCode('Hh');
export const CAVE_WALL = parseTerrainCode('Xu');
export const CAVE = parseTerrainCode('Uu');
export const UNDERGROUND_VILLAGE = parseTerrainCode('Uu^Vu');
export const DWARVEN_CASTLE = parseTerrainCode('Cud');
export const DWARVEN_KEEP = parseTerrainCode('Kud');

/** Pseudo-terrain markers used only inside alias/matching lists, never as real map hexes. */
export const PLUS = parseTerrainCode('+');
export const MINUS = parseTerrainCode('-');
export const NOT = parseTerrainCode('!');
export const STAR = parseTerrainCode('*');
/** References "the base terrain" inside an overlay's alias list (see terrain_type combining). */
export const BASE_MARKER = parseTerrainCode('_bas');

function hasWildcard(code: TerrainCode): boolean {
  if (code.overlay === NO_LAYER) return getLayerMask(code.base) !== NO_LAYER;
  return getLayerMask(code.base) !== NO_LAYER || getLayerMask(code.overlay) !== NO_LAYER;
}

function getMask(code: TerrainCode): TerrainCode {
  if (code.overlay === NO_LAYER) {
    return new TerrainCode(getLayerMask(code.base), 0xffffffff);
  }
  return new TerrainCode(getLayerMask(code.base), getLayerMask(code.overlay));
}

/**
 * Tests whether `src` matches the list of expressions `dest`. Mirrors
 * `terrain_matches(terrain_code, ter_list)` exactly, including its `*`
 * (match-everything, short-circuit), `!` (invert), and per-layer wildcard
 * (`W*`) semantics. `src` must not itself contain wildcards.
 */
export function terrainMatches(src: TerrainCode, dest: readonly TerrainCode[]): boolean {
  if (dest.length === 0) return false;

  let result = true;
  for (const entry of dest) {
    if (entry.equals(STAR)) {
      return result;
    }
    if (entry.base === NOT.base) {
      result = !result;
      continue;
    }
    if (src.equals(entry)) {
      return result;
    }
    const destMask = getMask(entry);
    const maskedDestBase = (entry.base & destMask.base) >>> 0;
    const maskedDestOverlay = (entry.overlay & destMask.overlay) >>> 0;
    if (
      hasWildcard(entry) &&
      ((src.base & destMask.base) >>> 0) === maskedDestBase &&
      ((src.overlay & destMask.overlay) >>> 0) === maskedDestOverlay
    ) {
      return result;
    }
  }
  return !result;
}

// --- terrain_type (non-imagery fields) ---

export type MergeMode = 'BOTH' | 'BASE' | 'OVERLAY';

/**
 * Non-imagery data from a `[terrain_type]` WML block. Fields that only
 * matter for rendering/editor UI (icon_image, symbol_image, editor_image,
 * sound, editor_group, hide_help, hide_in_editor) are intentionally
 * omitted.
 */
export class TerrainType {
  constructor(
    public readonly id: string,
    private readonly nameText: string,
    /** The terrain code this type is registered under (`string=` in WML). */
    public readonly code: TerrainCode,
    /** Alias list used to resolve movement cost (defaults to `[code]`, i.e. "not an alias"). */
    public readonly mvtType: TerrainCode[],
    /** Alias list used to resolve defense (defaults to `[code]`). */
    public readonly defType: TerrainCode[],
    /** Sorted union of mvtType/defType minus +/- markers, used for `is_indivisible`. */
    public readonly unionType: TerrainCode[],
    public readonly village: boolean,
    public readonly castle: boolean,
    public readonly keep: boolean,
    public readonly heals: number,
    public readonly submerge: number,
    public readonly heightAdjust: number,
    public readonly lightModification: number,
    public readonly maxLight: number,
    public readonly minLight: number,
    /** `name=` as the translatable string it is in WML, so the display name follows the language. */
    public readonly nameT?: TString,
  ) {}

  /** The display name, in the current language. */
  get name(): string {
    return this.nameT ? this.nameT.str() : this.nameText;
  }

  /** Mirrors `terrain_type::is_indivisible()`: true if this code has no separate underlying alias. */
  isIndivisible(): boolean {
    return isIndivisible(this.code, this.unionType);
  }

  isVillage(): boolean {
    return this.village;
  }

  isCastle(): boolean {
    return this.castle;
  }

  isKeep(): boolean {
    return this.keep;
  }

  givesHealing(): number {
    return this.heals;
  }

  static fromConfig(cfg: WmlConfig): TerrainType {
    const id = cfg.getString('id');
    const name = cfg.getString('name', id);
    const code = parseTerrainCode(cfg.getString('string'));

    const aliasOf = cfg.hasAttribute('aliasof') ? parseTerrainList(cfg.getString('aliasof')) : undefined;
    const mvtType = cfg.hasAttribute('mvt_alias')
      ? parseTerrainList(cfg.getString('mvt_alias'))
      : (aliasOf ?? [code]);
    const defType = cfg.hasAttribute('def_alias')
      ? parseTerrainList(cfg.getString('def_alias'))
      : (aliasOf ?? [code]);
    const unionType = dedupeSorted([...mvtType, ...defType].filter((t) => !t.equals(PLUS) && !t.equals(MINUS)));

    return new TerrainType(
      id,
      name,
      code,
      mvtType,
      defType,
      unionType,
      cfg.getBoolean('gives_income', false),
      cfg.getBoolean('recruit_onto', false),
      cfg.getBoolean('recruit_from', false),
      cfg.getNumber('heals', 0),
      cfg.getNumber('submerge', 0),
      cfg.getNumber('unit_height_adjust', 0),
      cfg.getNumber('light', 0),
      cfg.hasAttribute('max_light') ? cfg.getNumber('max_light') : cfg.getNumber('light', 0),
      cfg.hasAttribute('min_light') ? cfg.getNumber('min_light') : cfg.getNumber('light', 0),
      cfg.isTranslatable('name') ? cfg.getTString('name') : undefined,
    );
  }

  /** A default/"unknown" terrain_type for a code with no registered definition (mirrors the default `terrain_type()`). */
  static fromDefault(code: TerrainCode): TerrainType {
    return new TerrainType(
      writeTerrainCode(code),
      writeTerrainCode(code),
      code,
      [code],
      [code],
      [code],
      false,
      false,
      false,
      0,
      0,
      0,
      0,
      0,
      0,
    );
  }

  /**
   * The base+overlay combining constructor (`terrain_type(base, overlay)`):
   * synthesizes a terrain_type for a code like `Dd^Vda` when only `Dd` and
   * `^Vda` are separately declared in WML. Fields combine as upstream does:
   * booleans OR, heals/light take max, submerge/height_adjust prefer the
   * overlay's value, id is `base.id + "^" + overlay.id`.
   */
  static combine(base: TerrainType, overlay: TerrainType): TerrainType {
    const code = new TerrainCode(base.code.base, overlay.code.overlay);
    const named = overlay.name ? overlay : base;
    return new TerrainType(
      `${base.id}^${overlay.id}`,
      named.nameText,
      code,
      mergeAliasList(overlay.mvtType, base.mvtType),
      mergeAliasList(overlay.defType, base.defType),
      dedupeSorted(
        [...mergeAliasList(overlay.mvtType, base.mvtType), ...mergeAliasList(overlay.defType, base.defType)].filter(
          (t) => !t.equals(PLUS) && !t.equals(MINUS),
        ),
      ),
      base.village || overlay.village,
      base.castle || overlay.castle,
      base.keep || overlay.keep,
      Math.max(base.heals, overlay.heals),
      overlay.submerge,
      overlay.heightAdjust,
      base.lightModification + overlay.lightModification,
      Math.max(base.maxLight, overlay.maxLight),
      Math.min(base.minLight, overlay.minLight),
      named.nameT,
    );
  }
}

/**
 * Mirrors `terrain_type::is_indivisible(id, underlying)`: true if `underlying`
 * (a terrain_type's `mvtType`, `defType`, or `unionType`) represents "not an
 * alias of anything else" -- either empty, or exactly `[code]` itself.
 */
export function isIndivisible(code: TerrainCode, underlying: readonly TerrainCode[]): boolean {
  return underlying.length === 0 || (underlying.length === 1 && underlying[0]!.equals(code));
}

function dedupeSorted(list: TerrainCode[]): TerrainCode[] {
  const seen = new Map<string, TerrainCode>();
  for (const t of list) seen.set(t.key(), t);
  return [...seen.values()].sort((a, b) => (a.key() < b.key() ? -1 : a.key() > b.key() ? 1 : 0));
}

/**
 * Mirrors upstream's `merge_alias_lists` (src/terrain/terrain.cpp) exactly:
 * splices `baseList` in place of the first `BASE_MARKER` (`_bas`) sentinel
 * found in `overlayList` -- if the overlay's own alias list never mentions
 * `_bas`, it fully overrides and `baseList` is ignored entirely (returned
 * verbatim). Also inserts a `+`/`-` marker where the splice happens, mirroring
 * upstream's "revert" bookkeeping, so the spliced-in base terms compare the
 * same way (prefer-worse vs. prefer-better) the rest of the overlay's list
 * would at that position.
 *
 * Real, reported bug: the previous version of this function searched for
 * `BASE_MARKER` in `baseList` (which essentially never contains it -- `_bas`
 * is an OVERLAY-side placeholder referencing the base, not something a base
 * terrain's own alias list would contain) and spliced `overlayList` there
 * instead, i.e. the arguments were used backwards relative to upstream. For
 * any real overlay declared as `aliasof=_bas,Ft` (the standard "forest on
 * top of some base" idiom used by pine/deciduous/snow forest, and many
 * other overlay terrains), this left the `_bas` sentinel itself unresolved
 * as a literal (bogus) terrain code in the merged list, which resolves to
 * `UNREACHABLE` and -- because of the `-`/`+` "prefer worse" comparison
 * semantics `resolveValue` implements -- poisoned the WHOLE combined
 * terrain's movement cost to `UNREACHABLE`, regardless of the real forest
 * cost. This made every forest-on-grassland (etc.) hex on any real map
 * impassable to every unit. See `TerrainType.combine`'s call sites and
 * `packages/engine/test/model/Terrain.test.ts`.
 */
function mergeAliasList(overlayList: readonly TerrainCode[], baseList: readonly TerrainCode[]): TerrainCode[] {
  let revert = overlayList.length > 0 && overlayList[0]!.equals(MINUS);
  for (let i = 0; i < overlayList.length; i++) {
    const t = overlayList[i]!;
    if (t.equals(PLUS)) {
      revert = false;
      continue;
    }
    if (t.equals(MINUS)) {
      revert = true;
      continue;
    }
    if (t.equals(BASE_MARKER)) {
      const marker = revert ? MINUS : PLUS;
      return [...overlayList.slice(0, i), ...baseList, marker, ...overlayList.slice(i + 1)];
    }
  }
  return [...overlayList];
}

/**
 * The full terrain-type table, built from a scenario/core WML tree's
 * `[terrain_type]` children. Mirrors `terrain_type_data`.
 */
export class TerrainTypeData {
  private readonly byCode = new Map<string, TerrainType>();

  static fromConfigs(terrainTypeConfigs: readonly WmlConfig[]): TerrainTypeData {
    const data = new TerrainTypeData();
    for (const cfg of terrainTypeConfigs) {
      const type = TerrainType.fromConfig(cfg);
      const key = type.code.key();
      const existing = data.byCode.get(key);
      if (!existing) {
        data.byCode.set(key, type);
      }
      // else: a duplicate/add-on definition for the same code -- keep the first,
      // matching terrain_type_data's "first definition wins" merge behavior for
      // anything beyond the trivial case (we don't replicate its structural-
      // equality add-on merge, which only affects editor_group bookkeeping).
    }
    return data;
  }

  /** Direct, non-synthesizing lookup. */
  get(code: TerrainCode): TerrainType | undefined {
    return this.byCode.get(code.key());
  }

  /**
   * Mirrors `find_or_create`: an exact match if declared directly, else a
   * synthesized combination of a separately-declared pure-base and
   * pure-overlay terrain_type (e.g. `Dd` + `^Vda` -> `Dd^Vda`).
   */
  findOrCreate(code: TerrainCode): TerrainType | undefined {
    // The map shares one code object per terrain, and the table only ever gains combinations, so each
    // code object resolves once (the AI asks this of every hex it rates).
    const known = this.byObject.get(code);
    if (known !== undefined) return known ?? undefined;
    const found = this.resolve(code);
    this.byObject.set(code, found ?? null);
    return found;
  }

  private readonly byObject = new WeakMap<TerrainCode, TerrainType | null>();

  private resolve(code: TerrainCode): TerrainType | undefined {
    const exact = this.byCode.get(code.key());
    if (exact) return exact;

    if (code.overlay === NO_LAYER) return undefined;

    const baseOnly = this.byCode.get(new TerrainCode(code.base, NO_LAYER).key());
    const overlayOnly = this.byCode.get(new TerrainCode(NO_LAYER, code.overlay).key());
    if (baseOnly && overlayOnly) {
      const combined = TerrainType.combine(baseOnly, overlayOnly);
      this.byCode.set(code.key(), combined);
      return combined;
    }
    return undefined;
  }

  isKnown(code: TerrainCode): boolean {
    return this.findOrCreate(code) !== undefined;
  }

  getTerrainInfo(code: TerrainCode): TerrainType {
    return this.findOrCreate(code) ?? TerrainType.fromDefault(code);
  }

  isVillage(code: TerrainCode): boolean {
    return this.findOrCreate(code)?.isVillage() ?? false;
  }

  isCastle(code: TerrainCode): boolean {
    return this.findOrCreate(code)?.isCastle() ?? false;
  }

  isKeep(code: TerrainCode): boolean {
    return this.findOrCreate(code)?.isKeep() ?? false;
  }

  /**
   * Mirrors `terrain_type_data::merge_terrains`: applies `newTerrain` on top
   * of `oldTerrain` per `mode`, falling back to `newTerrain` verbatim if
   * `replaceIfFailed` and the merged code isn't a known terrain type.
   */
  mergeTerrains(oldTerrain: TerrainCode, newTerrain: TerrainCode, mode: MergeMode, replaceIfFailed = false): TerrainCode {
    let result = NONE_TERRAIN;

    if (mode === 'OVERLAY') {
      const t = new TerrainCode(oldTerrain.base, newTerrain.overlay);
      if (this.isKnown(t)) result = t;
    } else if (mode === 'BASE') {
      const t = new TerrainCode(newTerrain.base, oldTerrain.overlay);
      if (this.isKnown(t)) result = t;
    } else if (mode === 'BOTH' && newTerrain.base !== NO_LAYER) {
      if (this.isKnown(newTerrain)) result = newTerrain;
    }

    if (result.equals(NONE_TERRAIN) && replaceIfFailed && this.isKnown(newTerrain)) {
      if (newTerrain.base !== NO_LAYER) {
        result = newTerrain;
      }
      // else: overlay-only `newTerrain` with no base -- upstream substitutes the overlay's
      // declared `default_base=` (an editor-only convenience for painting overlays with no
      // base selected). Not ported: default_base is otherwise-unused rendering/editor data,
      // out of scope for the core model.
    }
    return result;
  }
}
