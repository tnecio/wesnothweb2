/**
 * Phase 27b: campaigns' own specials and weapon abilities, through the campaigns' own macros -- Descent into
 * Darkness's soul eater (a `[damage]` ability) and malice (a `[leadership]` for the undead), and The Deceiver's
 * Gambit's Eldred, whose shadow wave is `[disable] active_on=offense` (for retaliation only).
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { dataRoot, loadRealContent } from '../helpers/realContent.js';
import { parseWml, preloadDefinesFromDir, preloadDefines, type DefineMap } from '../../src/wml/index.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { Location } from '../../src/model/Location.js';
import { AttackType, type RegistryEntry } from '../../src/model/UnitType.js';
import { buildBattleContext, chooseDefenderWeaponIndex, fillWeaponChoices } from '../../src/actions/combatStats.js';

const real = loadRealContent();
const defines: DefineMap = new Map();
preloadDefinesFromDir(path.join(dataRoot, 'core/macros'), defines, { dataRoot });
preloadDefines(path.join(dataRoot, 'campaigns/Descent_Into_Darkness/utils/abilities.cfg'), defines, { dataRoot });

/** The abilities a macro expands to, as a unit's ability list. */
function abilitiesOf(macro: string): RegistryEntry[] {
  return parseWml(`[abilities]\n{${macro}}\n[/abilities]`, { defines: new Map(defines) })
    .child('abilities')!
    .allChildren()
    .map(({ tag, config }) => ({ tag, config }));
}

function board(): GameBoard {
  const b = new GameBoard(real.map(['Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg', 'Gg, Gg, Gg, Gg']));
  b.addTeam(new Team(1, { teamName: 'one' }));
  b.addTeam(new Team(2, { teamName: 'two' }));
  return b;
}

function place(b: GameBoard, type: string, side: number, x: number, y: number): Unit {
  const u = Unit.create(real.unitType(type), side, new Location(x, y));
  b.addUnit(u);
  b.assignUnitId(u);
  return u;
}

describe('Descent into Darkness', () => {
  it("soul eater (a [damage] ability, multiply=1.15 on offense) raises its owner's damage when attacking only", () => {
    const b = board();
    const malin = place(b, 'Dark Adept', 1, 1, 1);
    const target = place(b, 'Spearman', 2, 2, 1);
    const plain = buildBattleContext({ board: b, attacker: malin, attackerWeapon: malin.attacks[1], defender: target, defenderWeapon: undefined }).attacker.damage;
    malin.abilities = abilitiesOf('ABILITY_SOUL_EATER3');
    const eating = buildBattleContext({ board: b, attacker: malin, attackerWeapon: malin.attacks[1], defender: target, defenderWeapon: undefined }).attacker.damage;
    expect(eating).toBeGreaterThan(plain);
    // Defending, it does not apply.
    const asDefender = buildBattleContext({ board: b, attacker: target, attackerWeapon: target.attacks.find((a) => a.range === 'ranged'), defender: malin, defenderWeapon: malin.attacks[1] });
    malin.abilities = [];
    const asDefenderPlain = buildBattleContext({ board: b, attacker: target, attackerWeapon: target.attacks.find((a) => a.range === 'ranged'), defender: malin, defenderWeapon: malin.attacks[1] });
    expect(asDefender.defender.damage).toBe(asDefenderPlain.defender.damage);
  });

  it('malice lifts adjacent undead by 20%, not the living', () => {
    const b = board();
    const lich = place(b, 'Dark Adept', 1, 1, 1);
    lich.abilities = abilitiesOf('ABILITY_MALICE1');
    const skeleton = place(b, 'Skeleton', 1, 1, 0);
    const adept = place(b, 'Dark Adept', 1, 0, 1);
    const target = place(b, 'Spearman', 2, 2, 0);
    const bonus = (u: Unit) => buildBattleContext({ board: b, attacker: u, attackerWeapon: u.attacks[0], defender: target, defenderWeapon: undefined }).attacker.leadershipBonus;
    expect(bonus(skeleton)).toBe(20);
    expect(bonus(adept)).toBe(0);
  });
});

describe("The Deceiver's Gambit: Eldred's shadow wave", () => {
  const shadowWave = AttackType.fromConfig(
    parseWml(
      '[attack]\nname=shadow wave\nrange=ranged\ntype=arcane\ndamage=8\nnumber=2\n[specials]\n{WEAPON_SPECIAL_MAGICAL}\n[disable]\nactive_on=offense\n[/disable]\n[/specials]\n[/attack]',
      { defines: new Map(defines) },
    ).child('attack')!,
  );

  it('cannot be chosen to attack with', () => {
    const b = board();
    const eldred = place(b, 'Spearman', 1, 1, 1);
    eldred.attacks = [eldred.attacks[0]!, shadowWave];
    const target = place(b, 'Spearman', 2, 2, 1);
    const ids = fillWeaponChoices({ board: b, attacker: eldred, defender: target }).choices.map((c) => eldred.attacks[c.attackerWeaponIndex]!.id);
    expect(ids).not.toContain('shadow wave');
  });

  it('answers a ranged attack', () => {
    const b = board();
    const eldred = place(b, 'Spearman', 1, 1, 1);
    eldred.attacks = [eldred.attacks[0]!, shadowWave];
    const archer = place(b, 'Bowman', 2, 2, 1);
    const bow = archer.attacks.findIndex((a) => a.range === 'ranged');
    expect(chooseDefenderWeaponIndex({ board: b, attacker: archer, defender: eldred }, bow)).toBe(1);
  });
});
