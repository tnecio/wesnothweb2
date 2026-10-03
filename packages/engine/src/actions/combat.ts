/**
 * TS port of the real (RNG-rolled, not predicted) combat resolution from
 * `actions/attack.cpp`'s `attack` class (`perform()`/`perform_hit()`/
 * `unit_killed()`). Unlike `attackPrediction.ts` (which computes a full
 * probability distribution over outcomes for the UI popup), this module
 * rolls real hit/miss outcomes off the supplied `Rng` and mutates the
 * board accordingly, returning a structured `AttackResult` describing what
 * happened -- per this task's design note, nothing here mutates a unit
 * with no return value describing why.
 *
 * Deliberately NOT ported (display/event-pump-coupled, out of scope for
 * this actions-only task -- see `ARCHITECTURE.md`'s state/presentation
 * split and `IMPLEMENTATION_PLAN.md`'s separate WML-event-pump item):
 *  - `pre_attack`/`attack`/`attacker_hits`/`defender_hits`/`attacker_misses`/
 *    `defender_misses`/`unit_hits`/`unit_misses`/`attack_end`/`last_breath`/
 *    `die`/`petrified` WML events. `AttackResult` carries enough detail
 *    (per-blow hit/miss/damage/drain/poison/slow/petrify/kill) that a
 *    future event-pump integration can synthesize these without redoing
 *    the combat math.
 *  - The `use_prng_`/"biased RNG" experimental mode (a `synced_context`/
 *    replay concern, not core combat math).
 *  - Fog/shroud updates and animation.
 */

import { recalculateFog, type RaiseEvent } from './vision.js';
import { rollNewUnit } from './recruit.js';
import { Location, getAdjacentTiles, ALL_DIRECTIONS, distanceBetween, oppositeDirection, type Direction } from '../model/Location.js';
import type { GameBoard } from '../model/GameBoard.js';
import { WmlConfig } from '../wml/config.js';
import { Unit, UnitStatus } from '../model/Unit.js';
import type { UnitType } from '../model/UnitType.js';
import type { Rng } from '../rng/Rng.js';
import { buildBattleContext, chooseDefenderWeaponIndex, type UnitStatsOptions } from './combatStats.js';
import type { BattleContextUnitStats } from './attackPrediction.js';
import { combatXp, killXp } from './gameConfig.js';
import { computeLeadershipBonus, computeResistanceModifier } from './abilityEffects.js';

/** Outcome of a single blow (one strike within one round of combat). */
export interface AttackBlowResult {
  /** True if the attacker struck this blow, false if it was the defender's counter-strike. */
  readonly attackerTurn: boolean;
  readonly chanceToHit: number;
  readonly hit: boolean;
  readonly damage: number;
  readonly drainAmount: number;
  readonly strikerDiedFromDrain: boolean;
  readonly targetDied: boolean;
  readonly poisoned: boolean;
  readonly slowed: boolean;
  readonly petrified: boolean;
}

export interface PlagueSpawn {
  readonly type: string;
  readonly at: Location;
  /** True if `AttackOptions.resolveType` was supplied and actually resolved -- i.e. a unit was really added to the board. */
  readonly spawned: boolean;
}

/** Structured result of a full attack action (all rounds/blows), mirroring `attack::perform`'s net effect. */
export interface AttackResult {
  readonly attackerLoc: Location;
  readonly defenderLoc: Location;
  readonly attackerStats: BattleContextUnitStats;
  readonly defenderStats: BattleContextUnitStats;
  readonly blows: readonly AttackBlowResult[];
  readonly attackerXp: number;
  readonly defenderXp: number;
  readonly attackerDied: boolean;
  readonly defenderDied: boolean;
  readonly plagueSpawn?: PlagueSpawn;
}

export interface AttackOptions extends UnitStatsOptions {
  /**
   * If provided, an attacker weapon with a `[*] id=plague` special (see
   * `combatStats.ts`'s module doc comment on how specials are matched)
   * that kills the defender will spawn a replacement unit of the returned
   * type on the same side as the attacker, mirroring `attack::
   * unit_killed`'s reanimation branch. Simplified vs. upstream: the
   * plague type is read verbatim from `[plague] type=`, with no
   * `unit_type::parent_id()` fallback (not tracked by `UnitType.ts`), and
   * the spawned unit does not get the dead unit's `undead_variation`
   * re-applied (that needs the `[effect] apply_to=variation` modification
   * machinery, out of scope). Omit to skip reanimation; `AttackResult.
   * plagueSpawn` still reports the *candidate* (type/location) with
   * `spawned: false` so callers can tell a plague was skipped for lack of
   * a resolver, as opposed to not applicable at all.
   */
  readonly resolveType?: (id: string) => UnitType | undefined;
}

function directionTo(from: Location, to: Location): Direction {
  const adj = getAdjacentTiles(from);
  const idx = adj.findIndex((loc) => loc.equals(to));
  return idx === -1 ? ALL_DIRECTIONS[0]! : ALL_DIRECTIONS[idx]!;
}

/**
 * The real `[damage] id=backstab` condition, evaluated as a narrow
 * geometric proxy rather than the full WFL `[filter_opponent]` formula --
 * see `combatStats.ts`'s own module doc comment for why. Matches the
 * special's own plain-language `description=`: true when the hex
 * continuing in a straight line PAST the defender (attacker -> defender
 * -> flanker) holds a unit hostile to the defender (i.e. allied with the
 * attacker) and not incapacitated (petrified/stone). Exported so both
 * real combat resolution (`executeAttack` below) and the UI's attack
 * preview (`GameSession.buildPreview`, which has the same board/location
 * access but lives in a different package) compute it identically.
 */
export function isBackstabActive(board: GameBoard, attackerLoc: Location, defenderLoc: Location): boolean {
  const dirIndex = ALL_DIRECTIONS.indexOf(directionTo(attackerLoc, defenderLoc));
  const flankerLoc = getAdjacentTiles(defenderLoc)[dirIndex];
  if (!flankerLoc) return false;
  const flanker = board.unitAt(flankerLoc);
  if (!flanker || flanker.incapacitated) return false;
  const defender = board.unitAt(defenderLoc);
  if (!defender) return false;
  const defenderTeam = board.getTeam(defender.side);
  const flankerTeam = board.getTeam(flanker.side);
  return !!defenderTeam && !!flankerTeam && defenderTeam.isEnemy(flankerTeam);
}

function healBy(unit: Unit, amount: number): void {
  unit.hitpoints = Math.min(unit.maxHitpoints, unit.hitpoints + amount);
}

/**
 * The counter-weapon `executeAttack` would pick when none is given
 * (`chooseDefenderWeaponIndex` with the same terrain inputs), or -1 for no
 * counter-attack. A synced attack command records this up front, as
 * upstream's does (`defender_weapon=`), so a replay never has to re-derive it.
 */
export function resolveDefenderWeaponIndex(
  board: GameBoard,
  attackerLoc: Location,
  attackerWeaponIndex: number,
  defenderLoc: Location,
  options: AttackOptions = {},
): number {
  const attacker = board.unitAt(attackerLoc);
  const defender = board.unitAt(defenderLoc);
  if (!attacker || !defender || !attacker.attacks[attackerWeaponIndex]) return -1;
  return chooseDefenderWeaponIndex(
    attacker,
    attackerWeaponIndex,
    defender,
    distanceBetween(attackerLoc, defenderLoc),
    attacker.defenseModifier(board.map.getTerrain(attackerLoc)),
    defender.defenseModifier(board.map.getTerrain(defenderLoc)),
    options,
  );
}

/**
 * Executes a full attack action between the units at `attackerLoc` and
 * `defenderLoc`, mirroring `attack::perform()`'s net state-mutating effect.
 * `attackerWeaponIndex` selects `attacker.attacks[i]`; `defenderWeaponIndex`
 * selects the defender's counter-weapon, or omit it (or pass `-1`) to
 * auto-select via `chooseDefenderWeaponIndex` (upstream's default UX).
 * Consumes exactly one of the attacker's `attacksLeft` (see module doc
 * comment on `attacks_used()` not being tracked per-weapon here -- every
 * weapon costs exactly one of the unit's per-turn attacks, matching the
 * overwhelmingly common case).
 */
export function executeAttack(
  board: GameBoard,
  rng: Rng,
  attackerLoc: Location,
  attackerWeaponIndex: number,
  defenderLoc: Location,
  defenderWeaponIndex?: number,
  options: AttackOptions & {
    raise?: RaiseEvent;
    /**
     * Runs `last breath`/`die` while the dying unit is still on the board (`attack::unit_killed`).
     * If WML removes, replaces or heals the unit, it is not removed and no plague spawns.
     */
    onUnitDying?: (dead: Unit, killer: Unit) => void;
  } = {},
): AttackResult {
  const attacker = board.unitAt(attackerLoc);
  const defender = board.unitAt(defenderLoc);
  if (!attacker || !defender) {
    throw new Error('executeAttack: attacker and defender must both be on the board');
  }
  const attackerWeapon = attacker.attacks[attackerWeaponIndex];
  if (!attackerWeapon) {
    throw new Error(`executeAttack: attacker has no weapon at index ${attackerWeaponIndex}`);
  }
  // attack::perform: an invisible attacker isn't anymore.
  attacker.setStatus(UnitStatus.Uncovered, true);

  const distance = distanceBetween(attackerLoc, defenderLoc);
  const attackerTerrainDefense = attacker.defenseModifier(board.map.getTerrain(attackerLoc));
  const defenderTerrainDefense = defender.defenseModifier(board.map.getTerrain(defenderLoc));

  let defWeaponIdx = defenderWeaponIndex;
  if (defWeaponIdx === undefined) {
    defWeaponIdx = chooseDefenderWeaponIndex(
      attacker,
      attackerWeaponIndex,
      defender,
      distance,
      attackerTerrainDefense,
      defenderTerrainDefense,
      options,
    );
  }
  const defenderWeapon = defWeaponIdx >= 0 ? defender.attacks[defWeaponIdx] : undefined;

  const { attacker: attackerStats, defender: defenderStats } = buildBattleContext({
    attacker,
    attackerWeapon,
    defender,
    defenderWeapon,
    distance,
    attackerTerrainDefense,
    defenderTerrainDefense,
    options: {
      ...options,
      backstabActive: isBackstabActive(board, attackerLoc, defenderLoc),
      attackerLeadershipBonus: computeLeadershipBonus(board, attacker),
      defenderLeadershipBonus: computeLeadershipBonus(board, defender),
      attackerResistanceModifier: computeResistanceModifier(board, defender, attackerWeapon.type, false, defenderLoc),
      defenderResistanceModifier: defenderWeapon
        ? computeResistanceModifier(board, attacker, defenderWeapon.type, true, attackerLoc)
        : undefined,
    },
  });

  // Consume exactly one of the attacker's per-turn attacks (see this function's doc comment).
  attacker.attacksLeft = Math.max(0, attacker.attacksLeft - 1);
  attacker.setStatus(UnitStatus.NotMoved, false);
  attacker.resting = false;
  defender.resting = false;
  attacker.facing = directionTo(attackerLoc, defenderLoc);
  defender.facing = directionTo(defenderLoc, attackerLoc);

  const blows: AttackBlowResult[] = [];
  let attackerXp = combatXp(defenderStats.level);
  let defenderXp = combatXp(attackerStats.level);
  let attackerDied = false;
  let defenderDied = false;
  let plagueSpawn: PlagueSpawn | undefined;

  let aBlowsLeft = attackerStats.numBlows;
  let dBlowsLeft = defenderStats.numBlows;
  const aOrigBlows = aBlowsLeft;
  const dOrigBlows = dBlowsLeft;
  let defenderStrikesFirst = defenderStats.firststrike && !attackerStats.firststrike;
  let roundsLeft = Math.max(attackerStats.rounds, defenderStats.rounds) - 1;

  // Mutable "effective damage" trackers -- change mid-fight if the striker becomes slowed.
  let attackerEffectiveDamage = attackerStats.damage;
  let defenderEffectiveDamage = defenderStats.damage;

  const handleDeath = (killerIsAttacker: boolean, killerUnit: Unit, deadUnit: Unit): void => {
    const deadLoc = deadUnit.location;
    if (options.onUnitDying) {
      options.onUnitDying(deadUnit, killerUnit);
      if (board.unitAt(deadLoc) !== deadUnit || deadUnit.hitpoints > 0) return;
    }
    board.removeUnitAt(deadLoc);

    const killerWeapon = killerIsAttacker ? attackerWeapon : defenderWeapon;
    if (!killerWeapon) return;
    // `battle_context_unit_stats`: plague needs the special, a victim that is not `unplagueable` and whose
    // undead variation is not `null`, and a hex that is not a village.
    const plagueSpecials = killerWeapon.specials.filter((s) => s.getString('id', '') === 'plague');
    if (plagueSpecials.length === 0) return;
    if (deadUnit.hasStatus('unplagueable')) return;
    const undeadVariation = deadUnit.undeadVariation;
    if (undeadVariation === 'null') return;
    if (board.map.isVillage(deadLoc)) return;

    // No `type=`: the killer's own kind (`u.type().parent_id()`).
    const plagueType = plagueSpecials[0]!.getString('type', '') || killerUnit.baseType.id;

    const type = options.resolveType?.(plagueType);
    if (!type) {
      plagueSpawn = { type: plagueType, at: deadLoc, spawned: false };
      return;
    }
    // attack::unit_killed: `unit::create(*reanimator, side, true, MALE)` --
    // a real new unit, so it rolls its traits and name as any does.
    const { traits } = rollNewUnit(type, rng, { gender: 'male', randomGender: false, randomTraits: true, canRecruit: false, named: false });
    const spawned = Unit.create(type, killerUnit.side, deadLoc, { gender: 'male', modifications: traits });
    board.assignUnitId(spawned);
    spawned.attacksLeft = 0;
    spawned.movesLeft = 0;
    spawned.facing = oppositeDirection(killerUnit.facing);
    // The corpse takes the victim's shape: `[effect] apply_to=variation name=<undead_variation>`, healed full.
    if (undeadVariation !== '') {
      const mod = new WmlConfig();
      const effect = mod.addChild('effect');
      effect.setAttribute('apply_to', 'variation');
      effect.setAttribute('name', undeadVariation);
      spawned.addModification('variation', mod);
      spawned.healToFull();
    }
    board.addUnit(spawned);
    plagueSpawn = { type: plagueType, at: deadLoc, spawned: true };
  };

  const performHit = (attackerTurn: boolean): boolean => {
    const striker = attackerTurn ? attacker : defender;
    const target = attackerTurn ? defender : attacker;
    const strikerStats = attackerTurn ? attackerStats : defenderStats;
    const strikerDamage = attackerTurn ? attackerEffectiveDamage : defenderEffectiveDamage;

    const roll = rng.getRandomInt(0, 99);
    const hit = roll < strikerStats.chanceToHit;
    const damage = hit ? strikerDamage : 0;

    const damageDone = Math.min(target.hitpoints, strikerDamage);
    let drainAmount = 0;
    if (hit && strikerStats.drains) {
      drainAmount = Math.trunc((damageDone * strikerStats.drainPercent) / 100) + strikerStats.drainConstant;
      drainAmount = Math.min(drainAmount, striker.maxHitpoints - striker.hitpoints);
      drainAmount = Math.max(drainAmount, 1 - striker.hitpoints);
    }

    const targetDied = target.takeHit(damage);

    let strikerDiedFromDrain = false;
    if (drainAmount > 0) {
      healBy(striker, drainAmount);
    } else if (drainAmount < 0) {
      strikerDiedFromDrain = striker.takeHit(-drainAmount);
    }

    let poisoned = false;
    let slowed = false;
    let petrified = false;

    if (targetDied) {
      const xp = killXp(target.level);
      if (attackerTurn) {
        attackerXp = xp;
        defenderXp = 0;
        defenderDied = true;
      } else {
        defenderXp = xp;
        attackerXp = 0;
        attackerDied = true;
      }
      handleDeath(attackerTurn, striker, target);
    }
    if (strikerDiedFromDrain) {
      if (attackerTurn) attackerDied = true;
      else defenderDied = true;
      handleDeath(!attackerTurn, target, striker);
    }

    if (!targetDied && hit) {
      if (strikerStats.poisons && !target.poisoned) {
        target.setStatus(UnitStatus.Poisoned, true);
        poisoned = true;
      }
      if (strikerStats.slows && !target.slowed) {
        target.setStatus(UnitStatus.Slowed, true);
        slowed = true;
        if (attackerTurn) defenderEffectiveDamage = defenderStats.slowDamage;
        else attackerEffectiveDamage = attackerStats.slowDamage;
      }
      if (strikerStats.petrifies) {
        target.setStatus(UnitStatus.Petrified, true);
        petrified = true;
        // Petrification stops the whole exchange immediately (mirrors `attack::perform_hit`).
        if (attackerTurn) {
          aBlowsLeft = 0;
          dBlowsLeft = -1;
        } else {
          dBlowsLeft = 0;
          aBlowsLeft = -1;
        }
      }
    }

    blows.push({
      attackerTurn,
      chanceToHit: strikerStats.chanceToHit,
      hit,
      damage,
      drainAmount,
      strikerDiedFromDrain,
      targetDied,
      poisoned,
      slowed,
      petrified,
    });

    if (targetDied || strikerDiedFromDrain) return false;

    if (attackerTurn) aBlowsLeft -= 1;
    else dBlowsLeft -= 1;
    return true;
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (aBlowsLeft > 0 && !defenderStrikesFirst) {
      if (!performHit(true)) break;
    }
    defenderStrikesFirst = false;
    if (dBlowsLeft > 0) {
      if (!performHit(false)) break;
    }
    if (roundsLeft > 0 && dBlowsLeft === 0 && aBlowsLeft === 0) {
      aBlowsLeft = aOrigBlows;
      dBlowsLeft = dOrigBlows;
      roundsLeft -= 1;
      defenderStrikesFirst = defenderStats.firststrike && !attackerStats.firststrike;
    }
    if (aBlowsLeft <= 0 && dBlowsLeft <= 0) break;
  }

  if (!defenderDied) defender.experience += defenderXp;
  if (!attackerDied) attacker.experience += attackerXp;

  // attack::perform's update_def_fog_: the defending side's view may have lost a unit.
  recalculateFog(board, defender.side, options.raise);

  return {
    attackerLoc,
    defenderLoc,
    attackerStats,
    defenderStats,
    blows,
    attackerXp,
    defenderXp,
    attackerDied,
    defenderDied,
    plagueSpawn,
  };
}
