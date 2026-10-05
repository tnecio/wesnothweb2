import { describe, expect, it } from 'vitest';
import { Location } from '../../src/model/Location.js';
import { GameMap } from '../../src/model/Map.js';
import { TerrainTypeData } from '../../src/model/Terrain.js';
import { GameBoard } from '../../src/model/GameBoard.js';
import { Team } from '../../src/model/Team.js';
import { Unit } from '../../src/model/Unit.js';
import { UnitType, AttackType } from '../../src/model/UnitType.js';
import { MoveType } from '../../src/model/MoveType.js';
import { WmlConfig } from '../../src/wml/config.js';
import { parseConfig } from '../../src/wml/parser.js';
import { RngDeterministic } from '../../src/rng/RngDeterministic.js';
import { MtRng } from '../../src/rng/MtRng.js';
import { executeAttack } from '../../src/actions/combat.js';
import { CampaignStats, Statistics, StatsT, sumStrIntMap } from '../../src/statistics/statistics.js';

/** Phase 25: `statistics_t` / `statistics_record`, against hand-verifiable fights (as `combat.test.ts`). */

function moveType(terrainData: TerrainTypeData, chanceToBeHit: number): MoveType {
  const cfg = new WmlConfig();
  cfg.addChild('defense').setAttribute('Gg', chanceToBeHit);
  return MoveType.fromConfig(cfg, terrainData);
}

function weapon(damage: number, number: number): AttackType {
  const cfg = new WmlConfig();
  cfg.setAttribute('name', 'w').setAttribute('type', 'blade').setAttribute('range', 'melee').setAttribute('damage', damage).setAttribute('number', number);
  return AttackType.fromConfig(cfg);
}

function unitType(id: string, hp: number, mt: MoveType, w: AttackType, cost = 14): UnitType {
  return new UnitType(id, id, '', 'neutral', 1, hp, 5, 5, 0, cost, 0, -1, 500, [], '', false, false, false, mt, [w], []);
}

function fight(attackerWeapon: AttackType, defenderHp: number, defenderWeapon = weapon(0, 0)) {
  const terrainData = TerrainTypeData.fromConfigs([]);
  const map = GameMap.fromMapString('Gg, Gg, Gg, Gg\nGg, Gg, Gg, Gg\nGg, Gg, Gg, Gg\nGg, Gg, Gg, Gg', terrainData);
  const board = new GameBoard(map);
  board.addTeam(new Team(1, { saveId: 'Konrad' }));
  board.addTeam(new Team(2));
  const record = new CampaignStats();
  record.newScenario('Test');
  board.statistics = new Statistics(record);
  const mt = moveType(terrainData, 100);
  board.addUnit(Unit.create(unitType('Fighter', 30, mt, attackerWeapon), 1, new Location(0, 0)));
  board.addUnit(Unit.create(unitType('Orc', defenderHp, mt, defenderWeapon), 2, new Location(0, 1)));
  const result = executeAttack(board, new RngDeterministic(new MtRng(1)), new Location(0, 0), 0, new Location(0, 1));
  return { board, record, stats: board.statistics, result };
}

describe('statistics_attack_context', () => {
  it('records each strike by chance to hit, the damage done and expected, under each side', () => {
    const { stats } = fight(weapon(8, 2), 30, weapon(3, 1));
    const konrad = stats.getStats('Konrad');
    const orcs = stats.getStats('2');
    // Two hits of 8 at 100%, one return hit of 3.
    expect(konrad.attacksInflicted).toEqual(new Map([[100, new Map([['s11', 1]])]]));
    expect(konrad.attacksTaken).toEqual(new Map([[100, new Map([['s1', 1]])]]));
    expect(orcs.defendsInflicted).toEqual(new Map([[100, new Map([['s1', 1]])]]));
    expect(orcs.defendsTaken).toEqual(new Map([[100, new Map([['s11', 1]])]]));
    expect(konrad.byCthInflicted.get(100)).toEqual({ strikes: 2, hits: 2 });
    expect(konrad.byCthTaken.get(100)).toEqual({ strikes: 1, hits: 1 });
    expect(konrad.damageInflicted).toBe(16);
    expect(konrad.damageTaken).toBe(3);
    expect(orcs.damageTaken).toBe(16);
    expect(konrad.expectedDamageInflicted).toBe(16000);
    expect(konrad.turnExpectedDamageTaken).toBe(3000);
  });

  it('a kill counts the damage actually done, and the victim under killed and deaths', () => {
    const { stats } = fight(weapon(50, 1), 20);
    const konrad = stats.getStats('Konrad');
    expect(konrad.damageInflicted).toBe(20);
    expect(konrad.expectedDamageInflicted).toBe(20000);
    expect(konrad.killed).toEqual(new Map([['Orc', 1]]));
    expect(stats.getStats('2').deaths).toEqual(new Map([['Orc', 1]]));
  });
});

describe('statistics_record (the [statistics] WML)', () => {
  it('round-trips, rebuilding the hit rates from the sequences', () => {
    const { record } = fight(weapon(8, 2), 30, weapon(3, 1));
    const again = CampaignStats.fromConfig(record.toConfig());
    const a = new Statistics(again).getStats('Konrad');
    expect(a.byCthInflicted.get(100)).toEqual({ strikes: 2, hits: 2 });
    expect(a.damageInflicted).toBe(16);
    expect(again.toConfig().toJSON()).toEqual(record.toConfig().toJSON());
  });

  it('reads a real save\'s [statistics] and sums the campaign, the turn figures from the last scenario', () => {
    const cfg = parseConfig(`
[scenario]
    scenario="The Elves Besieged"
    [team]
        [recruits]
            2="Elvish Fighter"
            1="Elvish Archer,Merman Hunter"
        [/recruits]
        [killed]
            3="Orcish Grunt"
        [/killed]
        [attacks]
            [sequence]
                2="s101"
                _num=60
            [/sequence]
        [/attacks]
        recruit_cost=72
        damage_inflicted=40
        turn_damage_inflicted=5
        save_id="Konrad"
    [/team]
[/scenario]
[scenario]
    scenario="Blackwater Port"
    [team]
        [recruits]
            1="Elvish Fighter"
        [/recruits]
        damage_inflicted=10
        turn_damage_inflicted=7
        save_id="Konrad"
    [/team]
[/scenario]
`);
    const stats = new Statistics(CampaignStats.fromConfig(cfg));
    expect(stats.levelStats('Konrad').map((l) => l.name)).toEqual(['The Elves Besieged', 'Blackwater Port']);
    const all = stats.calculateStats('Konrad');
    expect(all.recruits).toEqual(new Map([['Elvish Fighter', 3], ['Elvish Archer', 1], ['Merman Hunter', 1]]));
    expect(sumStrIntMap(all.recruits)).toBe(5);
    expect(all.damageInflicted).toBe(50);
    expect(all.turnDamageInflicted).toBe(7);
    // s101 twice at 60%: 6 strikes, 4 hits.
    expect(all.byCthInflicted.get(60)).toEqual({ strikes: 6, hits: 4 });
    expect(stats.levelStats('nobody')).toHaveLength(1);
  });

  it('recruits, recalls and their undoing, advancements and the turn reset', () => {
    const stats = new Statistics(new CampaignStats());
    const u = { typeId: 'Elvish Fighter', baseTypeId: 'Elvish Fighter', saveId: 'Konrad', cost: 14 };
    stats.recruitUnit(u);
    stats.recruitUnit(u);
    stats.unRecruitUnit(u);
    stats.recallUnit(u);
    stats.advanceUnit({ ...u, typeId: 'Elvish Captain' });
    const s = stats.getStats('Konrad');
    expect(s.recruits.get('Elvish Fighter')).toBe(1);
    expect(s.recruitCost).toBe(14);
    expect(s.recalls.get('Elvish Fighter')).toBe(1);
    expect(s.advancedTo.get('Elvish Captain')).toBe(1);
    s.turnDamageInflicted = 9;
    stats.resetTurnStats('Konrad');
    expect(s.turnDamageInflicted).toBe(0);
    expect(new StatsT().saveId).toBe('');
  });
});
