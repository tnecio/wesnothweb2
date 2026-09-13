import { describe, expect, it } from 'vitest';
import { GameBoard } from '../../src/model/GameBoard.js';
import { GameMap } from '../../src/model/Map.js';
import { Location } from '../../src/model/Location.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { AttackType, UnitType, type RegistryEntry } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { unitMatchesFilter, locationMatchesFilterOnBoard } from '../../src/events/filter.js';
import { parseWml } from '../../src/wml/index.js';
import { WmlConfig } from '../../src/wml/config.js';

/**
 * Phase 29 (real AI port) additions to the Standard Unit Filter / Standard
 * Location Filter: `role=`, `race=`, `ability=`, `has_weapon=`, `status=`,
 * `ai_special=` on units, and `locationMatchesFilterOnBoard` for `[avoid]`-
 * style single-hex checks -- see `filter.ts`'s own module doc comment.
 */

const emptyTerrainData = TerrainTypeData.fromConfigs([]);
const flatMoveType = MoveType.fromConfig(new WmlConfig(), emptyTerrainData);

function makeType(id: string, raceId = '', abilities: RegistryEntry[] = [], attacks: AttackType[] = []): UnitType {
  return new UnitType(id, id, raceId, 'neutral', 1, 20, 5, 5, 0, 1, 1, -1, 32, [], '', false, false, false, flatMoveType, attacks, abilities);
}

function healsAbility(id: string): RegistryEntry {
  const cfg = new WmlConfig();
  cfg.setAttribute('id', id);
  return { tag: 'heals', config: cfg };
}

function makeBoard(): GameBoard {
  const rows: string[] = [];
  for (let y = 0; y < 5; y++) rows.push(Array(5).fill('Gg').join(', '));
  const board = new GameBoard(GameMap.fromMapString(rows.join('\n'), emptyTerrainData));
  board.addTeam(new Team(1, { teamName: 'a' }));
  return board;
}

describe('SUF role=', () => {
  it('matches a comma list of roles', () => {
    const unit = Unit.create(makeType('x'), 1, new Location(0, 0), { role: 'scout' });
    const cfg = parseWml('[u]\nrole=healer,scout\n[/u]').child('u')!;
    expect(unitMatchesFilter(unit, cfg)).toBe(true);
    unit.role = 'fighter';
    expect(unitMatchesFilter(unit, cfg)).toBe(false);
  });
});

describe('SUF race=', () => {
  it('matches the unit type’s race id', () => {
    const unit = Unit.create(makeType('x', 'orc'), 1, new Location(0, 0));
    const cfg = parseWml('[u]\nrace=orc,goblin\n[/u]').child('u')!;
    expect(unitMatchesFilter(unit, cfg)).toBe(true);
    const elf = Unit.create(makeType('y', 'elf'), 1, new Location(0, 0));
    expect(unitMatchesFilter(elf, cfg)).toBe(false);
  });
});

describe('SUF ability=', () => {
  it('matches any of the unit type’s ability ids', () => {
    const unit = Unit.create(makeType('x', '', [healsAbility('healing')]), 1, new Location(0, 0));
    const cfg = parseWml('[u]\nability=healing,curing\n[/u]').child('u')!;
    expect(unitMatchesFilter(unit, cfg)).toBe(true);
    const plain = Unit.create(makeType('y'), 1, new Location(0, 0));
    expect(unitMatchesFilter(plain, cfg)).toBe(false);
  });
});

describe('SUF has_weapon=', () => {
  it('matches an attack whose id (WML name=) is in the list', () => {
    const sword = new AttackType('sword', 'Sword', 'blade', 'melee', 1, 1, 5, 3, 1, 1, 0, 0, undefined, []);
    const unit = Unit.create(makeType('x', '', [], [sword]), 1, new Location(0, 0));
    expect(unitMatchesFilter(unit, parseWml('[u]\nhas_weapon=sword\n[/u]').child('u')!)).toBe(true);
    expect(unitMatchesFilter(unit, parseWml('[u]\nhas_weapon=bow\n[/u]').child('u')!)).toBe(false);
  });
});

describe('SUF status=', () => {
  it('matches any set status flag', () => {
    const unit = Unit.create(makeType('x'), 1, new Location(0, 0));
    unit.setStatus('poisoned', true);
    expect(unitMatchesFilter(unit, parseWml('[u]\nstatus=poisoned,slowed\n[/u]').child('u')!)).toBe(true);
    expect(unitMatchesFilter(unit, parseWml('[u]\nstatus=slowed\n[/u]').child('u')!)).toBe(false);
  });
});

describe('SUF ai_special=guardian', () => {
  it('matches a unit whose ai_special=guardian was applied at construction time', () => {
    const cfg = new WmlConfig();
    cfg.setAttribute('type', 'x');
    cfg.setAttribute('x', 1);
    cfg.setAttribute('y', 1);
    cfg.setAttribute('ai_special', 'guardian');
    const type = makeType('x');
    const unit = Unit.fromConfig(cfg, () => type);
    expect(unitMatchesFilter(unit, parseWml('[u]\nai_special=guardian\n[/u]').child('u')!)).toBe(true);
    const other = Unit.create(type, 1, new Location(0, 0));
    expect(unitMatchesFilter(other, parseWml('[u]\nai_special=guardian\n[/u]').child('u')!)).toBe(false);
  });
});

describe('locationMatchesFilterOnBoard', () => {
  it('matches a single hex against terrain=/x=/y=, honoring [not] (the [avoid] aspect shape)', () => {
    const board = makeBoard();
    const hex = Location.fromWml(2, 2);
    const cfg = parseWml('[f]\nx=2\ny=1-3\n[/f]').child('f')!;
    expect(locationMatchesFilterOnBoard(board, hex, cfg)).toBe(true);
    expect(locationMatchesFilterOnBoard(board, Location.fromWml(5, 5), cfg)).toBe(false);
  });

  it('supports [not] composition, matching [avoid]\'s [value][not][/not][/value] "matches nothing" default idiom', () => {
    const board = makeBoard();
    const matchesNothing = parseWml('[f]\n[not]\n[/not]\n[/f]').child('f')!;
    expect(locationMatchesFilterOnBoard(board, new Location(2, 2), matchesNothing)).toBe(false);
  });
});
