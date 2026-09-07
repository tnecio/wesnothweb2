/**
 * TS port of upstream Wesnoth's `team`/`team::team_info` (src/team.hpp/.cpp).
 *
 * Scope: the gameplay-relevant fields of a `[side]` -- gold/income, the
 * recruit list, controller, team/display name, and defeat state. Explicitly
 * NOT ported here: shroud/fog-of-war tile bitmaps (`shroud_map`,
 * `fog_clearer_`) and the observer/proxy-controller/countdown-clock
 * bookkeeping (`side_proxy_controller`, `countdown_time`, `disallow_observers`,
 * ...), which are UI/session concerns rather than core simulation state --
 * revisit if/when Phase 2's fog-of-war or Phase 8's multiplayer session
 * handling needs them.
 */

import type { WmlConfig } from '../wml/config.js';

export type SideController = 'human' | 'ai' | 'network' | 'network_ai' | 'reserved';

function parseController(str: string): SideController {
  switch (str) {
    case 'human':
    case 'ai':
    case 'network':
    case 'network_ai':
    case 'reserved':
      return str;
    default:
      return 'human';
  }
}

/** Mirrors `team`, minus display/session bookkeeping -- see module doc comment. */
export class Team {
  side: number;
  gold: number;
  startGold: number;
  income: number;
  incomePerVillage: number;
  supportPerVillage: number;
  recallCost: number;
  /** Unit type ids this side may recruit (`can_recruit`, built from `recruit=` and `[unit] canrecruit=yes` entries). */
  canRecruit: Set<string>;
  teamName: string;
  userTeamName: string;
  sideName: string;
  faction: string;
  saveId: string;
  controller: SideController;
  color: string;
  flag: string;
  noLeader: boolean;
  hidden: boolean;
  scrollToLeader: boolean;
  persistent: boolean;
  /** Mirrors `lost_`: true once this side's leader has died with no gold/units left to continue. */
  lost: boolean;
  objectives: string;
  carryoverPercentage: number;
  carryoverAdd: boolean;
  carryoverBonus: number;
  carryoverGold: number;
  variables: WmlConfig | undefined;

  constructor(side: number, options: Partial<Team> = {}) {
    this.side = side;
    this.gold = options.gold ?? 100;
    this.startGold = options.startGold ?? this.gold;
    this.income = options.income ?? 0;
    this.incomePerVillage = options.incomePerVillage ?? 1;
    this.supportPerVillage = options.supportPerVillage ?? 1;
    this.recallCost = options.recallCost ?? 20;
    this.canRecruit = options.canRecruit ?? new Set();
    this.teamName = options.teamName ?? String(side);
    this.userTeamName = options.userTeamName ?? '';
    this.sideName = options.sideName ?? '';
    this.faction = options.faction ?? '';
    this.saveId = options.saveId ?? '';
    this.controller = options.controller ?? 'human';
    this.color = options.color ?? String(side);
    this.flag = options.flag ?? '';
    this.noLeader = options.noLeader ?? false;
    this.hidden = options.hidden ?? false;
    this.scrollToLeader = options.scrollToLeader ?? true;
    this.persistent = options.persistent ?? true;
    this.lost = options.lost ?? false;
    this.objectives = options.objectives ?? '';
    this.carryoverPercentage = options.carryoverPercentage ?? 100;
    this.carryoverAdd = options.carryoverAdd ?? false;
    this.carryoverBonus = options.carryoverBonus ?? 0;
    this.carryoverGold = options.carryoverGold ?? 0;
    this.variables = options.variables;
  }

  /**
   * Builds a Team from a `[side]` config. Mirrors `team::team::build` /
   * `team_info::read` for the fields in scope (see module doc comment).
   * `recruit=` is a comma-separated list of unit type ids; individual
   * `[unit] canrecruit=yes` entries elsewhere in the scenario also
   * contribute to `can_recruit` upstream but that requires cross-
   * referencing the scenario's unit list, so callers building a full
   * GameBoard should union those in afterward (see GameBoard.fromConfig).
   */
  static fromConfig(cfg: WmlConfig): Team {
    const side = cfg.getNumber('side', 1);
    const recruit = cfg
      .getString('recruit', '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const gold = cfg.getNumber('gold', 100);
    return new Team(side, {
      gold,
      startGold: gold,
      income: cfg.getNumber('income', 0),
      incomePerVillage: cfg.getNumber('village_gold', 1),
      supportPerVillage: cfg.getNumber('village_support', 1),
      recallCost: cfg.getNumber('recall_cost', 20),
      canRecruit: new Set(recruit),
      teamName: cfg.getString('team_name', String(side)),
      userTeamName: cfg.getString('user_team_name', ''),
      sideName: cfg.getString('side_name', ''),
      faction: cfg.getString('faction', ''),
      saveId: cfg.getString('save_id', ''),
      controller: parseController(cfg.getString('controller', 'human')),
      color: cfg.getString('color', String(side)),
      flag: cfg.getString('flag', ''),
      noLeader: cfg.getBoolean('no_leader', false),
      hidden: cfg.getBoolean('hidden', false),
      scrollToLeader: cfg.getBoolean('scroll_to_leader', true),
      persistent: cfg.getBoolean('persistent', true),
      objectives: cfg.getString('objectives', ''),
      carryoverPercentage: cfg.getNumber('carryover_percentage', 100),
      carryoverAdd: cfg.getBoolean('carryover_add', false),
      carryoverBonus: cfg.getNumber('carryover_bonus', 0),
      carryoverGold: cfg.getNumber('carryover_gold', 0),
      variables: cfg.child('variables'),
    });
  }

  /** Mirrors `team::is_enemy`: sides are hostile unless the same team_name (alliance) groups them. */
  isEnemy(other: Team): boolean {
    return this.teamName !== other.teamName;
  }

  canRecruitType(unitTypeId: string): boolean {
    return this.canRecruit.has(unitTypeId);
  }

  /** Mirrors `team::spend_gold`/`team::get_gold`-adjacent bookkeeping used by recruit/recall actions. */
  spendGold(amount: number): void {
    this.gold -= amount;
  }

  /** Mirrors `team::new_turn`'s income application (village upkeep is computed by the caller, which knows village counts). */
  applyIncome(totalIncome: number): void {
    this.gold += totalIncome;
  }
}
