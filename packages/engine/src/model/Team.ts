/**
 * TS port of upstream Wesnoth's `team`/`team::team_info` (src/team.hpp/.cpp).
 *
 * Scope: the gameplay-relevant fields of a `[side]` -- gold/income, the
 * recruit list, controller, team/display name, defeat state, and per-side
 * shroud/fog (`shroud_`, `fog_`, `fog_clearer_`, `share_vision`). Not
 * ported: observer/proxy-controller/countdown-clock bookkeeping
 * (`side_proxy_controller`, `countdown_time`, `disallow_observers`, ...).
 *
 * Upstream's `team::shrouded`/`fogged` reach the team list through
 * `resources::gameboard`; here the caller passes the ally teams instead
 * (`GameBoard.isShrouded`/`isFogged` do that).
 */

import type { WmlConfig } from '../wml/config.js';
import type { Location } from './Location.js';
import { ShroudMap } from './ShroudMap.js';

/** Mirrors `team_shared_vision::type`. */
export type SharedVision = 'all' | 'shroud' | 'none';

function parseSharedVision(cfg: WmlConfig): SharedVision {
  // `team_info::handle_legacy_share_vision`: the old keys override share_vision= when present.
  if (cfg.hasAttribute('share_view') || cfg.hasAttribute('share_maps')) {
    if (cfg.getBoolean('share_view', false)) return 'all';
    if (cfg.getBoolean('share_maps', true)) return 'shroud';
    return 'none';
  }
  const v = cfg.getString('share_vision', 'all');
  return v === 'shroud' || v === 'none' ? v : 'all';
}

/** `side_controller::type`; `null` is an empty side, which takes no turns (`team::is_empty`). */
export type SideController = 'human' | 'ai' | 'network' | 'network_ai' | 'reserved' | 'null';

/** `side_controller::get_enum(cfg["controller"]).value_or(side_controller::type::ai)` (`team::team_info::read`). */
export function parseController(str: string): SideController {
  switch (str) {
    case 'human':
    case 'ai':
    case 'network':
    case 'network_ai':
    case 'reserved':
    case 'null':
      return str;
    default:
      return 'ai';
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
  /** Mirrors `shroud_`: terrain hidden until explored. */
  shroud: ShroudMap;
  /** Mirrors `fog_`: units hidden on hexes not currently in vision. */
  fog: ShroudMap;
  /** Mirrors `fog_clearer_`: hexes kept clear of fog by `[lift_fog] multiturn=yes`, keyed by `Location.key()`. */
  fogClearer: Set<string>;
  shareVision: SharedVision;
  /** Mirrors `auto_shroud_updates_` (false = the player's "delay shroud updates" mode). */
  autoShroudUpdates: boolean;

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
    this.shroud = options.shroud ?? new ShroudMap(false);
    this.fog = options.fog ?? new ShroudMap(false);
    this.fogClearer = options.fogClearer ?? new Set();
    this.shareVision = options.shareVision ?? 'all';
    this.autoShroudUpdates = options.autoShroudUpdates ?? true;
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
    const team = new Team(side, {
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
      // `saved_game::expand_scenario`/`team_info::read`: the side's `id=`, else its `[leader]`'s.
      saveId: cfg.getString('save_id', '') || cfg.getString('id', '') || (cfg.child('leader')?.getString('id', '') ?? ''),
      controller: parseController(cfg.getString('controller', '')),
      color: cfg.getString('color', String(side)),
      flag: cfg.getString('flag', ''),
      noLeader: cfg.getBoolean('no_leader', false),
      hidden: cfg.getBoolean('hidden', false),
      scrollToLeader: cfg.getBoolean('scroll_to_leader', true),
      // `team_info::read`: a human side is persistent unless it says otherwise.
      persistent: cfg.getBoolean('persistent', parseController(cfg.getString('controller', '')) === 'human'),
      objectives: cfg.getString('objectives', ''),
      carryoverPercentage: cfg.getNumber('carryover_percentage', 100),
      carryoverAdd: cfg.getBoolean('carryover_add', false),
      carryoverBonus: cfg.getNumber('carryover_bonus', 0),
      carryoverGold: cfg.getNumber('carryover_gold', 0),
      variables: cfg.child('variables'),
      shareVision: parseSharedVision(cfg),
      autoShroudUpdates: cfg.getBoolean('auto_shroud', true),
    });
    // `team::build`
    team.fog.enabled = cfg.getBoolean('fog', false);
    team.fog.read(cfg.getString('fog_data', ''));
    team.shroud.enabled = cfg.getBoolean('shroud', false);
    team.shroud.read(cfg.getString('shroud_data', ''));
    return team;
  }

  usesShroud(): boolean {
    return this.shroud.enabled;
  }
  usesFog(): boolean {
    return this.fog.enabled;
  }
  fogOrShroud(): boolean {
    return this.usesShroud() || this.usesFog();
  }
  shareMaps(): boolean {
    return this.shareVision !== 'none';
  }
  shareView(): boolean {
    return this.shareVision === 'all';
  }

  /** Mirrors `team::ally_shroud`: shroud maps of non-enemy teams sharing maps with this one (and this team's own). */
  allyShroudMaps(teams: readonly Team[]): ShroudMap[] {
    return teams.filter((t) => !this.isEnemy(t) && (t === this || t.shareMaps())).map((t) => t.shroud);
  }

  /** Mirrors `team::ally_fog`. */
  allyFogMaps(teams: readonly Team[]): ShroudMap[] {
    return teams.filter((t) => !this.isEnemy(t) && (t === this || t.shareView())).map((t) => t.fog);
  }

  /** Mirrors `team::shrouded`. Pass the full team list to honour shared maps; omit it to use only this team's own map. */
  shrouded(loc: Location, teams?: readonly Team[]): boolean {
    if (!teams) return this.shroud.valueAt(loc);
    return this.shroud.sharedValueAt(this.allyShroudMaps(teams), loc);
  }

  /** Mirrors `team::fogged` (shrouded implies fogged; `fog_clearer_` overrides fog). */
  fogged(loc: Location, teams?: readonly Team[]): boolean {
    if (this.shrouded(loc, teams)) return true;
    if (this.fogClearer.has(loc.key())) return false;
    if (!teams) return this.fog.valueAt(loc);
    return this.fog.sharedValueAt(this.allyFogMaps(teams), loc);
  }

  /** Mirrors `team::clear_shroud`. */
  clearShroud(loc: Location): boolean {
    return this.shroud.clearLoc(loc);
  }
  /** Mirrors `team::clear_fog`. */
  clearFog(loc: Location): boolean {
    return this.fog.clearLoc(loc);
  }
  placeShroud(loc: Location): void {
    this.shroud.placeLoc(loc);
  }
  /** Mirrors `team::reshroud`. */
  reshroud(): void {
    this.shroud.reset();
  }
  /** Mirrors `team::refog`. */
  refog(): void {
    this.fog.reset();
  }

  /**
   * Mirrors `team::calculate_is_enemy`: a side is no enemy of itself, nor of any side it shares a team name
   * with -- `team_name=` is a comma-separated list (The South Guard's Mari is `South_Guard,quintain`: an ally
   * of the player's `South_Guard` and of the training dummies' `quintain`, which are each other's enemies).
   */
  isEnemy(other: Team): boolean {
    if (other === this) return false;
    const theirs = teamNames(other.teamName);
    return !teamNames(this.teamName).some((name) => theirs.includes(name));
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

/** `utils::split(team_name)`: the names, trimmed, empty ones dropped. */
function teamNames(teamName: string): string[] {
  return teamName
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n !== '');
}
