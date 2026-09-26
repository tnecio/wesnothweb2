/**
 * TS port of upstream Wesnoth's map representation (src/map/map.hpp/.cpp,
 * merging `gamemap_base` and `gamemap` into one `GameMap` class -- the split
 * upstream exists for an editor-only subclassing reason that doesn't apply
 * here).
 *
 * Terrain *imagery* (which image tiles to draw for a neighborhood of
 * terrain codes, `terrain/builder.cpp`) is explicitly out of scope, per the
 * project's phase plan; this class only stores/queries terrain codes.
 *
 * WML wiring note: a `[scenario]`'s map data can arrive either as an inline
 * `map_data=` string or via `map_file=` (a filename resolved and inlined by
 * the scenario/campaign loader before the engine ever sees a `config`).
 * `GameMap.fromConfig` only reads `map_data` -- resolving `map_file` to text
 * is a resource-loading concern for whatever loads `.cfg`/`.map` files from
 * disk or fetch(), not the core data model.
 */

import { Location } from './Location.js';
import { NONE_TERRAIN, TerrainCode, TerrainTypeData, parseTerrainCode, writeTerrainCode, type MergeMode } from './Terrain.js';
import type { WmlConfig } from '../wml/config.js';

export type VillageChange = 'unchanged' | 'new_village' | 'former_village';

export interface SetTerrainResult {
  newTerrain: TerrainCode;
  villageChange: VillageChange;
}

interface ParsedGameMap {
  tiles: TerrainCode[]; // flat, index = x * height + y (matches t_translation::ter_map::get)
  width: number;
  height: number;
  startingPositions: Map<string, Location>;
}

function isNewline(ch: string): boolean {
  return ch === '\n' || ch === '\r';
}

/** Mirrors `t_translation::get_map_size`: max comma-count+1 per line, and line count. */
function getMapSize(str: string): { width: number; height: number } {
  let width = 1;
  let height = 0;
  let i = 0;
  while (i < str.length) {
    let curW = 1;
    height++;
    while (i < str.length && !isNewline(str[i]!)) {
      if (str[i] === ',') curW++;
      i++;
    }
    width = Math.max(width, curW);
    while (i < str.length && isNewline(str[i]!)) i++;
  }
  return { width, height };
}

/**
 * Mirrors `t_translation::read_game_map`: parses the whole-map text format
 * (rows separated by newlines, hexes comma-separated, an optional leading
 * `"<name> "` token per hex marking a starting position/special location)
 * into a flat terrain grid plus a starting-position table.
 */
function parseGameMapText(input: string, borderOffset: Location): ParsedGameMap {
  let str = input;
  let start = 0;
  while (start < str.length && isNewline(str[start]!)) start++;
  str = str.slice(start);

  if (str.length <= 1) {
    return { tiles: [], width: 0, height: 0, startingPositions: new Map() };
  }

  const { width: mapW, height: mapH } = getMapSize(str);
  const tiles: TerrainCode[] = new Array(mapW * mapH).fill(NONE_TERRAIN);
  const startingPositions = new Map<string, Location>();

  let offset = 0;
  let x = 0;
  let y = 0;
  let width = 0;

  while (offset < str.length) {
    let posSeparator = -1;
    for (let i = offset; i < str.length; i++) {
      const c = str[i]!;
      if (c === ',' || isNewline(c)) {
        posSeparator = i;
        break;
      }
    }
    const chunk = posSeparator === -1 ? str.slice(offset) : str.slice(offset, posSeparator);

    // A chunk may be "<name1> <name2> ... <terrain code>": all but the last
    // space-separated token are starting-position/special-location names.
    const trimmedChunk = chunk.trim();
    const parts = trimmedChunk.length === 0 ? [] : trimmedChunk.split(/\s+/);
    const terrainToken = parts.length > 0 ? parts[parts.length - 1]! : '';
    const names = parts.slice(0, -1);

    const tile = terrainToken.length === 0 ? NONE_TERRAIN : parseTerrainCode(terrainToken);

    for (const name of names) {
      startingPositions.set(name, new Location(x - borderOffset.x, y - borderOffset.y));
    }

    if (mapW <= x || mapH <= y) {
      throw new Error('Map not a rectangle.');
    }
    tiles[x * mapH + y] = tile;

    if (posSeparator === -1 || isNewline(str[posSeparator]!)) {
      if (y === 0) {
        width = x + 1;
      } else if (x + 1 !== width) {
        throw new Error('Map not a rectangle.');
      }
      y++;
      x = 0;
      if (posSeparator === -1) {
        offset = str.length;
      } else {
        offset = posSeparator + 1;
        while (offset < str.length && isNewline(str[offset]!)) offset++;
      }
    } else {
      x++;
      offset = posSeparator + 1;
    }
  }

  if (x !== 0 && x + 1 !== width) {
    throw new Error('Map not a rectangle.');
  }

  return { tiles, width: mapW, height: mapH, startingPositions };
}

/**
 * The game map: a rectangular grid of terrain codes plus starting positions
 * ("special locations", including the numbered per-side ones). Mirrors
 * `gamemap`/`gamemap_base`.
 */
export class GameMap {
  static readonly DEFAULT_BORDER = 1;
  static readonly MAX_PLAYERS = 9;

  private readonly tiles: TerrainCode[];
  private readonly totalWidthVal: number;
  private readonly totalHeightVal: number;
  private readonly startingPositions: Map<string, Location>;
  readonly borderSize: number;
  readonly villages: readonly Location[];

  private constructor(
    tiles: TerrainCode[],
    totalWidth: number,
    totalHeight: number,
    startingPositions: Map<string, Location>,
    borderSize: number,
    private readonly terrainData: TerrainTypeData,
  ) {
    this.tiles = tiles;
    this.totalWidthVal = totalWidth;
    this.totalHeightVal = totalHeight;
    this.startingPositions = startingPositions;
    this.borderSize = borderSize;

    const villages: Location[] = [];
    for (let x = 0; x < totalWidth; x++) {
      for (let y = 0; y < totalHeight; y++) {
        const loc = new Location(x - borderSize, y - borderSize);
        if (this.onBoard(loc) && this.isVillage(loc)) villages.push(loc);
      }
    }
    this.villages = villages;
  }

  /** Parses map text (the `[S ]TERRAIN,...` per-row format used by `.map` files and `map_data=`). */
  static fromMapString(data: string, terrainData: TerrainTypeData, borderSize = GameMap.DEFAULT_BORDER): GameMap {
    const borderOffset = new Location(borderSize, borderSize);
    const parsed = parseGameMapText(data, borderOffset);
    const totalW = Math.max(parsed.width, 1);
    const totalH = Math.max(parsed.height, 1);
    const tiles = parsed.tiles.length > 0 ? parsed.tiles : [NONE_TERRAIN];
    return new GameMap(tiles, totalW, totalH, parsed.startingPositions, borderSize, terrainData);
  }

  /**
   * `gamemap::write` (`t_translation::write_game_map`): the map as
   * `map_data=` text, border included -- rows of `, `-separated codes, a
   * hex's special-location names before its code, and a final newline.
   * `fromMapString(map.write())` gives the same map back.
   */
  write(): string {
    const namesAt = new Map<string, string[]>();
    for (const [name, loc] of this.startingPositions) {
      const key = `${loc.x + this.borderSize},${loc.y + this.borderSize}`;
      namesAt.set(key, [...(namesAt.get(key) ?? []), name]);
    }
    const rows: string[] = [];
    for (let y = 0; y < this.totalHeightVal; y++) {
      const row: string[] = [];
      for (let x = 0; x < this.totalWidthVal; x++) {
        const names = namesAt.get(`${x},${y}`) ?? [];
        row.push([...names, writeTerrainCode(this.tiles[x * this.totalHeightVal + y]!)].join(' '));
      }
      rows.push(row.join(', '));
    }
    return rows.join('\n') + '\n';
  }

  /**
   * Builds a GameMap from a scenario config's `map_data=` attribute. Does
   * NOT resolve `map_file=` (see module doc comment) -- callers loading a
   * real scenario must have already inlined the referenced file's text into
   * `map_data` before this point.
   */
  static fromConfig(cfg: WmlConfig, terrainData: TerrainTypeData, borderSize = GameMap.DEFAULT_BORDER): GameMap {
    return GameMap.fromMapString(cfg.getString('map_data', ''), terrainData, borderSize);
  }

  /** Effective width/height, excluding the border. */
  w(): number {
    return this.totalWidthVal - 2 * this.borderSize;
  }
  h(): number {
    return this.totalHeightVal - 2 * this.borderSize;
  }

  totalWidth(): number {
    return this.totalWidthVal;
  }
  totalHeight(): number {
    return this.totalHeightVal;
  }

  empty(): boolean {
    return this.w() <= 0 || this.h() <= 0;
  }

  onBoard(loc: Location): boolean {
    return loc.valid() && loc.x < this.w() && loc.y < this.h();
  }

  onBoardWithBorder(loc: Location): boolean {
    return (
      this.tiles.length > 0 &&
      loc.x >= -this.borderSize &&
      loc.x < this.w() + this.borderSize &&
      loc.y >= -this.borderSize &&
      loc.y < this.h() + this.borderSize
    );
  }

  /** Looks up terrain at `loc`; off-map (but within the emulated border) hexes return their border terrain. */
  getTerrain(loc: Location): TerrainCode {
    if (!this.onBoardWithBorder(loc)) return NONE_TERRAIN;
    const x = loc.x + this.borderSize;
    const y = loc.y + this.borderSize;
    return this.tiles[x * this.totalHeightVal + y] ?? NONE_TERRAIN;
  }

  private setTerrainRaw(loc: Location, terrain: TerrainCode): void {
    const x = loc.x + this.borderSize;
    const y = loc.y + this.borderSize;
    (this.tiles as TerrainCode[])[x * this.totalHeightVal + y] = terrain;
  }

  /** Mirrors `gamemap::set_terrain`: merges `terrain` onto the existing code per `mode`. */
  setTerrain(loc: Location, terrain: TerrainCode, mode: MergeMode = 'BOTH', replaceIfFailed = false): SetTerrainResult {
    if (!this.onBoardWithBorder(loc)) {
      return { newTerrain: NONE_TERRAIN, villageChange: 'unchanged' };
    }

    const newTerrain = this.terrainData.mergeTerrains(this.getTerrain(loc), terrain, mode, replaceIfFailed);
    if (newTerrain.equals(NONE_TERRAIN)) {
      return { newTerrain: NONE_TERRAIN, villageChange: 'unchanged' };
    }

    let villageChange: VillageChange = 'unchanged';
    if (this.onBoard(loc)) {
      const wasVillage = this.isVillage(loc);
      const isVillageNow = this.terrainData.isVillage(newTerrain);
      const villages = this.villages as Location[];
      if (wasVillage && !isVillageNow) {
        const idx = villages.findIndex((v) => v.equals(loc));
        if (idx !== -1) villages.splice(idx, 1);
        villageChange = 'former_village';
      } else if (!wasVillage && isVillageNow) {
        villages.push(loc);
        villageChange = 'new_village';
      }
    }

    this.setTerrainRaw(loc, newTerrain);
    return { newTerrain, villageChange };
  }

  /** Parses `map_data=` text with this map's terrain types and border (for comparing or restoring a saved map). */
  parseSibling(data: string): GameMap {
    return GameMap.fromMapString(data, this.terrainData, this.borderSize);
  }

  /** `wesnoth.terrain_types[code]` exists: a terrain type this game knows. */
  isKnownTerrain(code: TerrainCode): boolean {
    return this.terrainData.isKnown(code);
  }

  isVillage(loc: Location): boolean {
    return this.onBoard(loc) && this.terrainData.isVillage(this.getTerrain(loc));
  }
  isCastle(loc: Location): boolean {
    return this.onBoard(loc) && this.terrainData.isCastle(this.getTerrain(loc));
  }
  isKeep(loc: Location): boolean {
    return this.onBoard(loc) && this.terrainData.isKeep(this.getTerrain(loc));
  }
  givesHealing(loc: Location): number {
    return this.onBoard(loc) ? this.terrainData.getTerrainInfo(this.getTerrain(loc)).givesHealing() : 0;
  }
  /** The `[terrain_type] id=` of the terrain at `loc` (WFL's `terrain_callable.id`) -- empty string off-board. */
  terrainId(loc: Location): string {
    return this.onBoard(loc) ? this.terrainData.getTerrainInfo(this.getTerrain(loc)).id : '';
  }
  /** The real `[terrain_type] name=` for the terrain at `loc` (e.g. "Grassland", "Castle") -- empty string off-board or for an unregistered code. */
  terrainName(loc: Location): string {
    return this.onBoard(loc) ? this.terrainData.getTerrainInfo(this.getTerrain(loc)).name : '';
  }

  // --- special locations / starting positions ---

  specialLocation(id: string): Location {
    return this.startingPositions.get(id) ?? Location.NULL;
  }

  setSpecialLocation(id: string, loc: Location): void {
    if (loc.valid()) {
      this.startingPositions.set(id, loc);
    } else {
      this.startingPositions.delete(id);
    }
  }

  startingPosition(side: number): Location {
    return this.specialLocation(String(side));
  }

  setStartingPosition(side: number, loc: Location): void {
    this.setSpecialLocation(String(side), loc);
  }

  /** The name of the special location at `loc`, if any (first match; upstream uses a bimap). */
  isSpecialLocation(loc: Location): string | undefined {
    for (const [id, pos] of this.startingPositions) {
      if (pos.equals(loc)) return id;
    }
    return undefined;
  }

  /** The (1-based) side number starting at `loc`, or 0 if none. */
  isStartingPosition(loc: Location): number {
    const id = this.isSpecialLocation(loc);
    if (id !== undefined && /^\d+$/.test(id)) return Number.parseInt(id, 10);
    return 0;
  }

  /** Highest numbered starting position defined (i.e. the number of sides with a valid start). */
  numValidStartingPositions(): number {
    let max = 0;
    for (const id of this.startingPositions.keys()) {
      if (/^\d+$/.test(id)) max = Math.max(max, Number.parseInt(id, 10));
    }
    return max;
  }

  /** Starting positions for sides 1..N, in order. */
  allStartingPositions(): Location[] {
    const n = this.numValidStartingPositions();
    const result: Location[] = [];
    for (let i = 1; i <= n; i++) result.push(this.startingPosition(i));
    return result;
  }
}
