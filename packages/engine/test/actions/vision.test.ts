import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWml, parseWmlFile, preloadDefinesFromDir, type DefineMap } from '../../src/wml/index.js';
import { WmlConfig } from '../../src/wml/config.js';
import { Location } from '../../src/model/Location.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { ShroudMap } from '../../src/model/ShroudMap.js';
import { Unit } from '../../src/model/Unit.js';
import { UnitType, type RegistryEntry } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { clearShroud, recalculateFog } from '../../src/actions/vision.js';
import { getVisibleUnit, isUnitVisibleToTeam } from '../../src/pathfind/visibility.js';
import { reachableHexes } from '../../src/pathfind/pathfind.js';

/**
 * Maps are 9x9 raw grids; the default 1-hex border leaves logical 0..6 on
 * each axis, with CENTER at logical (4,4). Override keys are raw text
 * coordinates (logical + 1).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dataRoot = path.join(repoRoot, 'wesnoth/data');

const defines: DefineMap = new Map();
preloadDefinesFromDir(path.join(dataRoot, 'core'), defines, { dataRoot });

const terrainData = (() => {
  const cfg = parseWmlFile(path.join(dataRoot, 'core/terrain.cfg'), { dataRoot, defines });
  return TerrainTypeData.fromConfigs(cfg.children('terrain_type'));
})();

const smallfoot = (() => {
  const cfg = parseWmlFile(path.join(dataRoot, 'core/units.cfg'), { dataRoot, defines });
  function walk({ tag, config }: { tag: string; config: WmlConfig }): WmlConfig[] {
    if (tag === 'movetype' && config.getString('name') === 'smallfoot') return [config];
    return config.allChildren().flatMap(walk);
  }
  return MoveType.fromConfig(cfg.allChildren().flatMap(walk)[0]!, terrainData);
})();

const CENTER = new Location(4, 4);

function gridMapText(overrides: Record<string, string> = {}): string {
  const rows: string[] = [];
  for (let y = 0; y < 9; y++) {
    const cells: string[] = [];
    for (let x = 0; x < 9; x++) cells.push(overrides[`${x},${y}`] ?? 'Gg');
    rows.push(cells.join(', '));
  }
  return rows.join('\n');
}

function makeType(id: string, options: { movement?: number; vision?: number; abilities?: RegistryEntry[] } = {}): UnitType {
  const movement = options.movement ?? 1;
  const vision = options.vision ?? movement;
  return new UnitType(
    id, id, '', 'neutral', 1, 20, movement, vision, 0, 1, 0, -1, 32, [], '', false, false, false,
    smallfoot, [], options.abilities ?? [], undefined, undefined, options.vision !== undefined,
  );
}

function makeBoard(options: { fog?: boolean; shroud?: boolean; overrides?: Record<string, string> } = {}): { board: GameBoard; t1: Team; t2: Team } {
  const board = new GameBoard(GameMap.fromMapString(gridMapText(options.overrides), terrainData));
  const t1 = new Team(1, { teamName: 'north' });
  const t2 = new Team(2, { teamName: 'south' });
  t1.fog.enabled = options.fog ?? false;
  t1.shroud.enabled = options.shroud ?? false;
  board.addTeam(t1);
  board.addTeam(t2);
  return { board, t1, t2 };
}

function place(board: GameBoard, type: UnitType, side: number, loc: Location): Unit {
  const unit = Unit.create(type, side, loc);
  board.addUnit(unit);
  return unit;
}

function hidesAbility(filterLocationBody: string): RegistryEntry {
  const cfg = parseWml(`[hides]\nid=test\naffect_self=yes\n[filter]\n[filter_location]\n${filterLocationBody}\n[/filter_location]\n[/filter]\n[/hides]`);
  return { tag: 'hides', config: cfg.child('hides')! };
}

describe('ShroudMap (shroud_map)', () => {
  it('reports nothing covered while disabled', () => {
    const m = new ShroudMap(false);
    expect(m.value(3, 3)).toBe(false);
    expect(m.clear(3, 3)).toBe(false);
  });

  it('starts covered, clears once, and can be re-covered', () => {
    const m = new ShroudMap(true);
    expect(m.value(2, 5)).toBe(true);
    expect(m.clear(2, 5)).toBe(true);
    expect(m.clear(2, 5)).toBe(false);
    expect(m.value(2, 5)).toBe(false);
    m.place(2, 5);
    expect(m.value(2, 5)).toBe(true);
  });

  it('writes and reads the upstream shroud_data format', () => {
    const m = new ShroudMap(true);
    m.clear(0, 0);
    m.clear(1, 2);
    expect(m.write()).toBe('|1\n|001\n');
    const copy = new ShroudMap(true);
    copy.read(m.write());
    expect(copy.value(1, 2)).toBe(false);
    expect(copy.value(1, 1)).toBe(true);
    const merged = new ShroudMap(true);
    merged.clear(3, 0);
    merged.merge(m.write());
    expect(merged.value(0, 0)).toBe(false);
    expect(merged.value(3, 0)).toBe(false);
  });

  it('shared value is uncovered if any enabled map is uncovered', () => {
    const a = new ShroudMap(true);
    const b = new ShroudMap(true);
    b.clear(1, 1);
    expect(a.sharedValue([a, b], 1, 1)).toBe(false);
    b.enabled = false;
    expect(a.sharedValue([a, b], 1, 1)).toBe(true);
  });
});

describe('Team fog/shroud state', () => {
  it('parses fog/shroud and legacy share_maps/share_view keys from [side]', () => {
    const side = (body: string) => Team.fromConfig(parseWml(`[side]\nside=1\n${body}\n[/side]`).child('side')!);
    const t = side('fog=yes\nshroud=yes\nshare_maps=no');
    expect(t.usesFog()).toBe(true);
    expect(t.usesShroud()).toBe(true);
    expect(t.shareVision).toBe('none');
    expect(side('share_view=yes').shareVision).toBe('all');
    expect(side('share_vision=shroud').shareVision).toBe('shroud');
  });

  it('shroud implies fog; fog overrides clear fog but not shroud', () => {
    const t = new Team(1);
    t.fog.enabled = true;
    t.shroud.enabled = true;
    const loc = new Location(2, 2);
    t.fogClearer.add(loc.key());
    expect(t.fogged(loc)).toBe(true);
    t.clearShroud(loc);
    expect(t.fogged(loc)).toBe(false);
  });

  it('allies share fog only with share_vision=all, shroud with shroud or all', () => {
    const a = new Team(1, { teamName: 'allies' });
    const b = new Team(2, { teamName: 'allies', shareVision: 'shroud' });
    for (const t of [a, b]) {
      t.fog.enabled = true;
      t.shroud.enabled = true;
    }
    const loc = new Location(1, 1);
    b.clearShroud(loc);
    b.clearFog(loc);
    expect(a.shrouded(loc, [a, b])).toBe(false);
    expect(a.fogged(loc, [a, b])).toBe(true);
    b.shareVision = 'all';
    expect(a.fogged(loc, [a, b])).toBe(false);
  });
});

describe('clear_shroud / recalculate_fog', () => {
  it('clears the vision range plus the edge ring beyond it', () => {
    const { board, t1 } = makeBoard({ fog: true, shroud: true });
    place(board, makeType('scout', { movement: 1 }), 1, CENTER);
    expect(clearShroud(board, 1)).toBe(true);
    expect(t1.fogged(new Location(4, 3))).toBe(false);
    expect(t1.fogged(new Location(4, 2))).toBe(false);
    expect(t1.shrouded(new Location(4, 1))).toBe(true);
    expect(clearShroud(board, 1)).toBe(false);
  });

  it('uses explicit vision= instead of movement when set', () => {
    const { board, t1 } = makeBoard({ shroud: true });
    place(board, makeType('watcher', { movement: 1, vision: 2 }), 1, CENTER);
    clearShroud(board, 1);
    expect(t1.shrouded(new Location(4, 1))).toBe(false);
    expect(t1.shrouded(new Location(4, 0))).toBe(true);
  });

  it('does nothing for a side without fog or shroud', () => {
    const { board } = makeBoard();
    place(board, makeType('scout'), 1, CENTER);
    expect(clearShroud(board, 1)).toBe(false);
  });

  it('raises sighted for uncovered units, with the sighter as secondary unit', () => {
    const { board } = makeBoard({ fog: true });
    place(board, makeType('scout'), 1, CENTER);
    place(board, makeType('enemy'), 2, new Location(4, 2));
    const raised: string[] = [];
    clearShroud(board, 1, { raise: (name, l1, l2) => raised.push(`${name} ${l1.key()} ${l2.key()}`) });
    expect(raised).toEqual([`sighted ${new Location(4, 2).key()} ${CENTER.key()}`]);
  });

  it('recalculate_fog re-fogs hexes out of sight and does not re-sight visible units', () => {
    const { board, t1 } = makeBoard({ fog: true });
    const scout = place(board, makeType('scout'), 1, CENTER);
    place(board, makeType('enemy'), 2, new Location(4, 5));
    clearShroud(board, 1);
    board.moveUnit(CENTER, new Location(4, 6));
    expect(scout.location.equals(new Location(4, 6))).toBe(true);
    const raised: string[] = [];
    recalculateFog(board, 1, (name) => raised.push(name));
    expect(t1.fogged(new Location(4, 2))).toBe(true);
    expect(t1.fogged(new Location(4, 5))).toBe(false);
    expect(raised).toEqual([]);
  });
});

describe('unit visibility (is_visible_to_team, invisible)', () => {
  it('hides enemies on fogged hexes until the fog is cleared', () => {
    const { board, t1 } = makeBoard({ fog: true });
    place(board, makeType('scout'), 1, CENTER);
    const enemyLoc = new Location(4, 2);
    place(board, makeType('enemy'), 2, enemyLoc);
    expect(getVisibleUnit(board, enemyLoc, t1, false)).toBeUndefined();
    expect(getVisibleUnit(board, enemyLoc, t1, true)).toBeDefined();
    expect(getVisibleUnit(board, CENTER, t1, false)).toBeDefined();
    clearShroud(board, 1);
    expect(getVisibleUnit(board, enemyLoc, t1, false)).toBeDefined();
  });

  it('ambush hides a unit in forest unless an enemy is adjacent', () => {
    const forest = new Location(4, 1);
    const { board, t1 } = makeBoard({ overrides: { '5,2': 'Gs^Fp' } });
    const ambusher = place(board, makeType('ranger', { abilities: [hidesAbility('terrain=*^F*')] }), 2, forest);
    place(board, makeType('scout'), 1, new Location(4, 5));
    expect(isUnitVisibleToTeam(board, ambusher, t1)).toBe(false);
    place(board, makeType('scout'), 1, new Location(4, 2));
    expect(isUnitVisibleToTeam(board, ambusher, t1)).toBe(true);
  });

  it('ambush does nothing outside forest, and uncovered units are never hidden', () => {
    const { board, t1 } = makeBoard({ overrides: { '5,2': 'Gs^Fp' } });
    const onGrass = place(board, makeType('ranger', { abilities: [hidesAbility('terrain=*^F*')] }), 2, new Location(1, 1));
    expect(isUnitVisibleToTeam(board, onGrass, t1)).toBe(true);
    const inForest = place(board, makeType('ranger', { abilities: [hidesAbility('terrain=*^F*')] }), 2, new Location(4, 1));
    inForest.setStatus('uncovered', true);
    expect(isUnitVisibleToTeam(board, inForest, t1)).toBe(true);
  });

  it('nightstalk hides a unit only when the hex is chaotic', () => {
    const { board, t1 } = makeBoard();
    const stalker = place(board, makeType('shadow', { abilities: [hidesAbility('time_of_day=chaotic')] }), 2, new Location(1, 1));
    board.lawfulBonusAt = () => -25;
    expect(isUnitVisibleToTeam(board, stalker, t1)).toBe(false);
    board.lawfulBonusAt = () => 25;
    expect(isUnitVisibleToTeam(board, stalker, t1)).toBe(true);
  });
});

describe('pathfinding under fog/shroud', () => {
  it('an unseen enemy does not block movement for the viewing side', () => {
    const { board, t1 } = makeBoard({ fog: true });
    const mover = place(board, makeType('walker', { movement: 5 }), 1, CENTER);
    const hidden = new Location(4, 2);
    place(board, makeType('enemy'), 2, hidden);
    expect(reachableHexes(board, mover, { viewingTeam: t1 }).destinations.contains(hidden)).toBe(true);
    expect(reachableHexes(board, mover, { seeAll: true }).destinations.contains(hidden)).toBe(false);
  });

  it('enemy moves are not shown through the viewing side\'s shroud', () => {
    const { board, t1 } = makeBoard({ shroud: true });
    const enemy = place(board, makeType('enemy', { movement: 3 }), 2, CENTER);
    expect(reachableHexes(board, enemy, { viewingTeam: t1 }).destinations.size).toBe(1);
    expect(reachableHexes(board, enemy, { seeAll: true }).destinations.size).toBeGreaterThan(1);
  });
});
