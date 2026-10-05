/**
 * The only module in this project that knows how a real Wesnoth save file
 * is spelled. Everything else -- `GameSession`, the storage layer, the UI
 * -- deals in `SaveGameData`, plain JSON; this converts between that and
 * the WML tree a `.gz` save actually contains, and it is reached only when
 * the player downloads or uploads a file.
 *
 * ## What a real save is
 *
 * Gzipped, tab-indented WML text (there is no binary save format). At file
 * level: `version=`/`campaign=`/`difficulty=`/`label=` and friends from
 * `game_classification::to_config`, then `[multiplayer]`, `[statistics]`,
 * `[carryover_sides]`, `[snapshot]`, `[replay_start]`, `[replay]` -- see
 * `savegame.cpp`'s `ingame_savegame::write_game` (~L567) for that exact
 * order. `[snapshot]` is the live game: `play_controller::to_config`
 * (~L587) starts from a copy of the scenario's own config and overlays
 * turn/side/unit state onto it, which is why it carries `map_data=` and
 * every `[event]` as well as the `[side]`/`[unit]` blocks.
 *
 * ## Fidelity, and how it is kept
 *
 * A save imported from the real game keeps everything this port does not
 * model -- `[statistics]`, `[multiplayer]`, `[replay]`, `[undo_stack]`,
 * `[display]`, the scenario's own `[event]`s as that version wrote them --
 * verbatim in `SaveGameData.wesnothExtras`, and re-exporting overlays live
 * state back onto it. So a real save can make the round trip through this
 * port without silently shedding the parts it does not understand, which
 * is the property `wesnothSave.test.ts` pins down against a real 1.16.9
 * Dead Water save.
 *
 * A save created *here* has no extras to preserve, so export synthesizes
 * the required blocks from the scenario snapshot instead. The `[replay]`
 * it writes is the game's real command log (Phase 18b), with the
 * `[replay_start]` that log begins from -- so the real game can replay it.
 * A save from before Phase 18b, with no log, gets a minimal but valid one
 * (`[upload_log]` plus the `[start]`/`[random_seed]`/`[init_side]` commands
 * a turn-start autosave contains), which is all a save needs to load.
 *
 * ## Coordinates and other traps
 *
 * WML `[unit] x=`/`y=` are 1-based, `Location` is 0-based (`Location.
 * fromWml`/`wmlX` do the conversion); `playing_team` is 0-based where
 * `side=` is 1-based; a `[unit]` with no x/y is a recall-list unit, which
 * is how upstream itself tells the two apart; `canrecruit` is only written
 * when true; and upstream omits any unit attribute still matching its unit
 * type, which is why every numeric field of `SavedUnit` is optional.
 */

import {
  TString,
  Location,
  WmlConfig,
  recordedCommandToWml,
  recordedCommandsFromWml,
  type GameBoardSnapshot,
  type RecordedCommand,
  type WmlConfigJson,
} from '@wesnothweb2/engine';
import type { SaveGameData, SavedUnit } from '../gameSession.js';

/**
 * The campaign identity a save file carries, which this port keeps in a
 * different spelling than upstream does (`dead_water` vs `Dead_Water`).
 * Supplied by the caller from `campaigns.json` rather than guessed: the
 * upstream id cannot be derived from ours (`under_the_burning_suns` gives
 * no clue which letters are capitalised).
 */
export interface WesnothCampaignInfo {
  /** Upstream's `[campaign] id=`, e.g. `Dead_Water`. */
  wesnothId: string;
  /** Upstream's `[campaign] name=`, e.g. `Dead Water`. */
  name: string;
  /** Upstream's `[campaign] abbrev=`, e.g. `DW` -- the first half of a save's `label=`. */
  abbrev: string;
  /**
   * Upstream's `[campaign] define=`, e.g. `CAMPAIGN_DEAD_WATER`, written
   * to the save as `campaign_define=`. Load-bearing, and easy to miss: it
   * is the `#ifdef` flag that makes Wesnoth preprocess this campaign's own
   * content, so without it the game loads the save and then dies on the
   * first campaign-specific unit ("unknown unit type: Merman Child King").
   */
  define: string;
  /** `EASY`/`NORMAL`/`HARD`: the fallback when the save itself records no difficulty (`SaveGameData.difficulty`). */
  difficulty?: string;
}

export interface ImportedWesnothSave {
  save: SaveGameData;
  /** The save's own `label=` (`<abbrev>-<scenario name>`), for naming the imported slot. */
  label: string;
  /** Which Wesnoth version wrote it, purely informational. */
  version: string;
}

/** Wesnoth's own campaign ids map to this project's by lower-casing (`Dead_Water` -> `dead_water`) for all four ported campaigns. The reverse needs `WesnothCampaignInfo`. */
function campaignIdFromWesnoth(wesnothId: string): string | undefined {
  return wesnothId ? wesnothId.toLowerCase() : undefined;
}

// ── import ──────────────────────────────────────────────────────────────

const NOT_LIVING = ['undrainable', 'unpoisonable', 'unplagueable'] as const;

/** Reads a `[status]` child as the flag names it sets (`poisoned=yes` -> `poisoned`). */
function statusesFrom(unitCfg: WmlConfig): string[] | undefined {
  const status = unitCfg.child('status');
  if (!status) return undefined;
  const flags = new Set<string>();
  for (const name of status.attributeNames()) {
    if (!status.getBoolean(name, false)) continue;
    // Upstream's legacy alias (`unit::set_state`): stands for these three, never kept itself.
    if (name === 'not_living') for (const s of NOT_LIVING) flags.add(s);
    else flags.add(name);
  }
  return flags.size > 0 ? [...flags] : undefined;
}

function modificationsFrom(unitCfg: WmlConfig): SavedUnit['modifications'] {
  const mods = unitCfg.child('modifications');
  if (!mods) return undefined;
  const out = mods.allChildren().map(({ tag, config }) => ({ kind: tag, cfg: config.toJSON() }));
  return out.length > 0 ? out : undefined;
}

/** Reads one optional numeric attribute, leaving it `undefined` when the save omitted it (so the unit type's own default wins). */
function optNumber(cfg: WmlConfig, key: string): number | undefined {
  return cfg.hasAttribute(key) ? cfg.getNumber(key) : undefined;
}

function optString(cfg: WmlConfig, key: string): string | undefined {
  return cfg.hasAttribute(key) ? cfg.getString(key) : undefined;
}

function optBoolean(cfg: WmlConfig, key: string): boolean | undefined {
  return cfg.hasAttribute(key) ? cfg.getBoolean(key) : undefined;
}

/** One `[unit]` from a save's `[side]`. A unit with no x/y is a recall-list unit -- upstream's own rule. */
function unitFromWml(unitCfg: WmlConfig, side: number): SavedUnit {
  const onBoard = unitCfg.hasAttribute('x') && unitCfg.hasAttribute('y');
  const loc = onBoard ? Location.fromWml(unitCfg.getNumber('x'), unitCfg.getNumber('y')) : null;
  const gotoX = unitCfg.getNumber('goto_x', 0);
  const gotoY = unitCfg.getNumber('goto_y', 0);
  return {
    id: unitCfg.getString('id', '') || null,
    name: unitCfg.isTranslatable('name') ? unitCfg.getTString('name')!.toJSON() : unitCfg.getString('name', '') || null,
    // `parent_type=` is what a unit advanced beyond its base type records.
    typeId: unitCfg.hasAttribute('parent_type') ? unitCfg.getString('parent_type') : unitCfg.getString('type'),
    side: unitCfg.getNumber('side', side),
    canRecruit: unitCfg.getBoolean('canrecruit', false),
    ...(loc ? { x: loc.x, y: loc.y } : {}),
    hitpoints: optNumber(unitCfg, 'hitpoints'),
    maxHitpoints: optNumber(unitCfg, 'max_hitpoints'),
    movesLeft: optNumber(unitCfg, 'moves'),
    maxMoves: optNumber(unitCfg, 'max_moves'),
    attacksLeft: optNumber(unitCfg, 'attacks_left'),
    maxAttacksPerTurn: optNumber(unitCfg, 'max_attacks'),
    experience: optNumber(unitCfg, 'experience'),
    maxExperience: optNumber(unitCfg, 'max_experience'),
    level: optNumber(unitCfg, 'level'),
    facing: optString(unitCfg, 'facing'),
    resting: optBoolean(unitCfg, 'resting'),
    hidden: optBoolean(unitCfg, 'hidden'),
    unrenamable: optBoolean(unitCfg, 'unrenamable'),
    role: optString(unitCfg, 'role'),
    underlyingId: optNumber(unitCfg, 'underlying_id'),
    profile: optString(unitCfg, 'profile'),
    gender: optString(unitCfg, 'gender'),
    variation: optString(unitCfg, 'variation'),
    statuses: statusesFrom(unitCfg),
    modifications: modificationsFrom(unitCfg),
    variables: unitCfg.child('variables')?.toJSON(),
    // goto_x/goto_y are 0 (not absent) when there is no pending goto.
    ...(gotoX > 0 && gotoY > 0 ? { goto: { x: gotoX - 1, y: gotoY - 1 } } : {}),
    // Everything a real save records per unit that this port does not
    // model -- see `SavedUnit.wesnothExtras`.
    wesnothExtras: unitCfg.toJSON(),
  };
}

/**
 * Converts a parsed Wesnoth save into this project's own save shape.
 *
 * Only mid-scenario saves carry a `[snapshot]`; a start-of-scenario save
 * has `[carryover_sides_start]` and nothing else to resume from
 * (`savegame.cpp:475`), so it is rejected rather than silently loaded as
 * an empty game.
 */
export function fromWesnothSave(cfg: WmlConfig): ImportedWesnothSave {
  const snapshot = cfg.child('snapshot');
  if (!snapshot || snapshot.children('side').length === 0) {
    throw new Error(
      'This save has no [snapshot] with sides in it. Wesnoth writes that only for a mid-scenario save; ' +
        'a start-of-scenario or replay-only save cannot be resumed here.',
    );
  }

  const teams: SaveGameData['teams'][number][] = [];
  const units: SavedUnit[] = [];
  const recall: SavedUnit[] = [];

  for (const sideCfg of snapshot.children('side')) {
    const side = sideCfg.getNumber('side', teams.length + 1);
    teams.push({
      side,
      gold: sideCfg.getNumber('gold', 0),
      shroudData: optString(sideCfg, 'shroud_data'),
      fogData: optString(sideCfg, 'fog_data'),
      villages: sideCfg.children('village').map((v) => {
        const loc = Location.fromWml(v.getNumber('x'), v.getNumber('y'));
        return { x: loc.x, y: loc.y };
      }),
    });
    for (const unitCfg of sideCfg.children('unit')) {
      const unit = unitFromWml(unitCfg, side);
      (unit.x === undefined ? recall : units).push(unit);
    }
  }

  // `playing_team` is a 0-based index into the side list; `side=` is 1-based.
  const activeSide = snapshot.hasAttribute('playing_team') ? snapshot.getNumber('playing_team') + 1 : 1;

  // Everything this port does not model, kept so a re-export can put it
  // back. The `[side]` blocks stay -- they carry `controller=`, `recruit=`,
  // team colours, carryover settings and `[ai]` config that no live state
  // here reproduces -- but their `[unit]`/`[village]` children are dropped,
  // since those ARE regenerated (each unit keeps its own original block in
  // `SavedUnit.wesnothExtras`) and they are the bulk of the file.
  const extras = cfg.clone();
  for (const sideCfg of extras.child('snapshot')?.children('side') ?? []) {
    sideCfg.removeChildren('unit');
    sideCfg.removeChildren('village');
  }

  // Phase 18b: the real game's own command log, so "Show replay" can play
  // it here. Starts from this port's setup of the scenario, with the gold
  // and recall lists `[replay_start]` records (see `GameSession.forReplay`).
  const replayCfg = cfg.child('replay');
  const replayStartCfg = cfg.child('replay_start');
  let replay: SaveGameData['replay'];
  if (replayCfg && replayStartCfg) {
    const { commands, issues } = recordedCommandsFromWml(replayCfg);
    const startSides = replayStartCfg.children('side');
    replay = {
      commands,
      wesnothStart: {
        gold: startSides.map((sideCfg, i) => ({ side: sideCfg.getNumber('side', i + 1), gold: sideCfg.getNumber('gold', 0) })),
        recall: startSides.flatMap((sideCfg, i) =>
          sideCfg
            .children('unit')
            .filter((u) => !u.hasAttribute('x'))
            .map((u) => unitFromWml(u, sideCfg.getNumber('side', i + 1))),
        ),
      },
      ...(issues.length > 0 ? { readIssues: issues.map((issue) => `[command] #${issue.index + 1}: ${issue.message}`) } : {}),
    };
  }

  return {
    save: {
      version: 2,
      ...(replay ? { replay } : {}),
      turnNumber: snapshot.getNumber('turn_at', 1),
      activeSide,
      scenarioResult: null,
      startupEventsRun: true,
      scenarioId: snapshot.getString('id', ''),
      scenarioName: snapshot.getString('name', ''),
      campaignId: campaignIdFromWesnoth(cfg.getString('campaign', '')),
      // `game_classification::difficulty`: the campaign difficulty define the save was played at.
      difficulty: cfg.getString('difficulty', '') || undefined,
      teams,
      units,
      recall,
      variables: snapshot.child('variables')?.toJSON(),
      // Phase 18c: the live handlers and the objects already taken, as the real game saved them.
      events: snapshot.children('event').map((e) => e.toJSON()),
      nextUnitId: snapshot.getNumber('next_underlying_unit_id', 0),
      turnLimit: snapshot.getNumber('turns', -1),
      items: snapshot.children('item').map((i) => i.toJSON()),
      labels: snapshot.children('label').map((l) => l.toJSON()),
      music: snapshot.children('music').map((m) => m.toJSON()),
      soundSources: snapshot.children('sound_source').map((c) => c.toJSON()),
      nextItemName: snapshot.child('next_item_name')?.getNumber('next_item_name', 0) ?? 0,
      mapData: snapshot.getString('map_data', '') || undefined,
      usedItems: (snapshot.child('used_items')?.attributeNames() ?? []).filter((id) => snapshot.child('used_items')!.getBoolean(id, false)),
      tunnels: snapshot.children('tunnel').map((t) => t.toJSON()),
      nextTeleportGroupId: snapshot.getNumber('next_teleport_group_id', 0),
      // game_data's constructor: `can_end_turn`, `cannot_end_turn_reason`, `end_turn`.
      ...(snapshot.getBoolean('can_end_turn', true)
        ? {}
        : { endTurnForbidden: { reason: snapshot.getTString('cannot_end_turn_reason')?.toJSON() } }),
      ...(snapshot.getBoolean('end_turn', false) ? { endTurnForced: true } : {}),
      rng: {
        seed: snapshot.getString('random_seed', '00000000'),
        calls: snapshot.getNumber('random_calls', 0),
      },
      wesnothExtras: extras.toJSON(),
      // Phase 25: the campaign's statistics, read as the game reads them.
      ...(cfg.child('statistics') ? { statistics: cfg.child('statistics')!.toJSON() } : {}),
    },
    label: cfg.getString('label', ''),
    version: cfg.getString('version', ''),
  };
}

// ── export ──────────────────────────────────────────────────────────────

/**
 * One `[unit]` block. For a unit that came from a real save this starts
 * from that save's own block (`SavedUnit.wesnothExtras`) and overlays the
 * fields this port tracks, so the many attributes it does not track --
 * `gender`, `race`, `upkeep`, `image`, `[filter_recall]`, the movement
 * type's cost tables -- survive the trip back out to a file.
 */
function unitToWml(u: SavedUnit, onBoard: boolean): WmlConfig {
  const cfg = u.wesnothExtras ? WmlConfig.fromJSON(u.wesnothExtras) : new WmlConfig();
  cfg.setAttribute('type', u.typeId);
  if (u.id) cfg.setAttribute('id', u.id);
  if (u.name) cfg.setAttribute('name', typeof u.name === 'string' ? u.name : TString.fromJSON(u.name));
  cfg.setAttribute('side', u.side);
  if (onBoard && u.x !== undefined && u.y !== undefined) {
    const loc = new Location(u.x, u.y);
    cfg.setAttribute('x', loc.wmlX);
    cfg.setAttribute('y', loc.wmlY);
  }
  // Mirrors `unit::write`: canrecruit is written only when true.
  if (u.canRecruit) cfg.setAttribute('canrecruit', true);
  const num = (key: string, value: number | undefined): void => {
    if (value !== undefined) cfg.setAttribute(key, value);
  };
  num('hitpoints', u.hitpoints);
  num('max_hitpoints', u.maxHitpoints);
  num('moves', u.movesLeft);
  num('max_moves', u.maxMoves);
  num('attacks_left', u.attacksLeft);
  num('max_attacks', u.maxAttacksPerTurn);
  num('experience', u.experience);
  num('max_experience', u.maxExperience);
  num('level', u.level);
  num('underlying_id', u.underlyingId);
  if (u.facing) cfg.setAttribute('facing', u.facing);
  if (u.resting !== undefined) cfg.setAttribute('resting', u.resting);
  if (u.hidden !== undefined) cfg.setAttribute('hidden', u.hidden);
  if (u.unrenamable) cfg.setAttribute('unrenamable', true);
  if (u.role) cfg.setAttribute('role', u.role);
  if (u.profile) cfg.setAttribute('profile', u.profile);
  if (u.gender) cfg.setAttribute('gender', u.gender);
  if (u.variation) cfg.setAttribute('variation', u.variation);
  if (u.goto) {
    const loc = new Location(u.goto.x, u.goto.y);
    cfg.setAttribute('goto_x', loc.wmlX);
    cfg.setAttribute('goto_y', loc.wmlY);
  }
  // Regenerated from live state -- but only when there is live state to
  // write. Leaving an inherited (possibly empty) block alone is what keeps
  // a re-exported real save byte-for-byte faithful in these three spots.
  if (u.statuses && u.statuses.length > 0) {
    cfg.removeChildren('status');
    const status = cfg.addChild('status');
    for (const flag of u.statuses) status.setAttribute(flag, true);
    // `unit::get_states` writes the alias back whenever all three are set.
    if (NOT_LIVING.every((s) => u.statuses!.includes(s))) status.setAttribute('not_living', true);
  }
  if (u.modifications && u.modifications.length > 0) {
    cfg.removeChildren('modifications');
    const mods = cfg.addChild('modifications');
    for (const m of u.modifications) mods.addChild(m.kind, WmlConfig.fromJSON(m.cfg));
  }
  if (u.variables) {
    cfg.removeChildren('variables');
    cfg.addChild('variables', WmlConfig.fromJSON(u.variables));
  }
  return cfg;
}

/**
 * Builds the `[side]` blocks for a `[snapshot]`: live team state, this
 * side's board units, then its recall-list units (which carry no x/y).
 * Each side keeps whatever the scenario declared about it that this port
 * does not track (`recruit=`, `controller=`, `team_name=`, `[ai]`, ...)
 * by starting from `template`, when one is available.
 */
function sidesToWml(save: SaveGameData, templates: Map<number, WmlConfig>): WmlConfig[] {
  return save.teams.map((team) => {
    const cfg = templates.get(team.side)?.clone() ?? new WmlConfig();
    cfg.removeChildren('unit');
    cfg.removeChildren('village');
    cfg.setAttribute('side', team.side);
    cfg.setAttribute('gold', team.gold);
    if (team.shroudData !== undefined) cfg.setAttribute('shroud_data', team.shroudData);
    if (team.fogData !== undefined) cfg.setAttribute('fog_data', team.fogData);
    for (const v of team.villages ?? []) {
      const loc = new Location(v.x, v.y);
      cfg.addChild('village').setAttribute('x', loc.wmlX).setAttribute('y', loc.wmlY);
    }
    for (const u of save.units) {
      if (u.side === team.side) cfg.addChild('unit', unitToWml(u, true));
    }
    for (const u of save.recall ?? []) {
      if (u.side === team.side) cfg.addChild('unit', unitToWml(u, false));
    }
    return cfg;
  });
}

/** The smallest `[replay]` a real save is ever written with -- see this module's doc comment on why a real log is not needed. */
function minimalReplay(save: SaveGameData): WmlConfig {
  const replay = new WmlConfig();
  replay.addChild('upload_log');
  replay.addChild('command').addChild('start');
  const seedCommand = replay.addChild('command');
  seedCommand.setAttribute('dependent', true);
  seedCommand.setAttribute('from_side', 'server');
  seedCommand.addChild('random_seed').setAttribute('new_seed', save.rng?.seed ?? '00000000');
  replay.addChild('command').addChild('init_side').setAttribute('side_number', save.activeSide);
  return replay;
}

/**
 * `[replay_start]`: the scenario as it stood before its `start` command --
 * upstream's `saved_game::replay_start()`. The scenario's own `[side]`s are
 * kept as written (the real game creates their leaders and inline units
 * itself, exactly as it did for the original game), with what the scenario
 * was entered with laid over them: each side's gold and its recall list
 * (units the previous scenario carried over, traits and all, and
 * `random_traits=no` so they are not rolled again).
 */
function replayStartToWml(start: SaveGameData, scenarioCfg: WmlConfig, snapshot: GameBoardSnapshot): WmlConfig {
  const cfg = scenarioCfg.clone();
  cfg.setAttribute('map_data', snapshot.map.data);
  cfg.setAttribute('turn_at', start.turnNumber);
  if (start.rng) {
    cfg.setAttribute('random_seed', start.rng.seed);
    cfg.setAttribute('random_calls', start.rng.calls);
  }
  if (start.variables) {
    cfg.removeChildren('variables');
    cfg.addChild('variables', WmlConfig.fromJSON(start.variables));
  }
  for (const sideCfg of cfg.children('side')) {
    const side = sideCfg.getNumber('side', 0);
    const team = start.teams.find((t) => t.side === side);
    if (team) sideCfg.setAttribute('gold', team.gold);
    // As upstream writes a built side: its units -- the leader included --
    // are explicit [unit]s at their hexes, and `no_leader=yes` so the side's
    // own `type=` is not turned into a second leader. (A replay loaded from
    // a save does not create the leader from `type=` at all: without this
    // the real game had no leader to recruit with.)
    sideCfg.setAttribute('no_leader', true);
    sideCfg.removeChildren('unit');
    for (const u of start.units) {
      if (u.side !== side) continue;
      const unitCfg = unitToWml(u, true);
      unitCfg.setAttribute('random_traits', false);
      sideCfg.addChild('unit', unitCfg);
    }
    for (const u of start.recall ?? []) {
      if (u.side !== side) continue;
      const unitCfg = unitToWml(u, false);
      unitCfg.setAttribute('random_traits', false);
      sideCfg.addChild('unit', unitCfg);
    }
  }
  cfg.setAttribute('next_underlying_unit_id', start.nextUnitId ?? 0);
  return cfg;
}

/** `[replay]`: `[upload_log]`, then every recorded command and its dependents (see `recordedCommandToWml`). */
function replayToWml(commands: readonly RecordedCommand[]): WmlConfig {
  const replay = new WmlConfig();
  replay.addChild('upload_log');
  // Each server choice (a seed) carries the game's running request number,
  // counted from 1 (`synced_context::ask_server_choice`); the real game warns
  // on a mismatch.
  let requestId = 0;
  for (const rec of commands) {
    for (const block of recordedCommandToWml(rec)) {
      const seed = block.child('random_seed');
      if (seed) seed.setAttribute('request_id', ++requestId);
      replay.addChild('command', block);
    }
  }
  return replay;
}

/**
 * Converts one of this project's saves into a real Wesnoth save tree,
 * ready for `writeWml` + gzip.
 *
 * `snapshot` supplies what a save needs but live state does not carry: the
 * scenario's own config (its `[event]`s, `[time]`s and objectives, which
 * `[snapshot]` embeds) and the map. `version` defaults to the content this
 * port ships; override it to target the exact build a file is destined for.
 */
export function toWesnothSave(
  save: SaveGameData,
  snapshot: GameBoardSnapshot,
  campaign: WesnothCampaignInfo,
  options: { version?: string } = {},
): WmlConfig {
  const extras = save.wesnothExtras ? WmlConfig.fromJSON(save.wesnothExtras) : null;
  const out = extras ?? new WmlConfig();

  const scenarioCfg = WmlConfig.fromJSON(snapshot.scenarioConfigJson as WmlConfigJson);
  const label = save.scenarioName ? `${campaign.abbrev}-${save.scenarioName}` : campaign.abbrev;

  // `game_classification::to_config`'s root attributes. An imported save
  // already has them; keep its own values rather than restating ours.
  if (!extras) {
    out.setAttribute('version', options.version ?? WESNOTH_CONTENT_VERSION);
    out.setAttribute('campaign_type', 'scenario');
    out.setAttribute('campaign', campaign.wesnothId);
    out.setAttribute('campaign_name', campaign.name);
    out.setAttribute('abbrev', campaign.abbrev);
    out.setAttribute('difficulty', save.difficulty ?? campaign.difficulty ?? 'NORMAL');
    out.setAttribute('label', label);
    out.setAttribute('end_credits', true);
    // See `WesnothCampaignInfo.define`: without these the game loads the
    // save but has never preprocessed the campaign's own units.
    out.setAttribute('campaign_define', campaign.define);
    out.setAttribute('campaign_extra_defines', '');
    out.setAttribute('scenario_define', '');
    out.setAttribute('era_define', '');
    out.setAttribute('mod_defines', '');
    out.setAttribute('active_mods', '');
    out.setAttribute('era_id', 'era_default');
    // Upstream's loader synthesizes a default [multiplayer] when a save
    // has none, by way of its "convert old saves" path; writing one keeps
    // a current-version save on the current-version code path.
    const mp = out.addChild('multiplayer');
    mp.setAttribute('mp_campaign', campaign.wesnothId);
    mp.setAttribute('mp_scenario', save.scenarioId ?? snapshot.scenario.id);
    mp.setAttribute('mp_scenario_name', save.scenarioName ?? snapshot.scenario.name);
    mp.setAttribute('mp_era_name', 'Default');
    mp.setAttribute('era_id', 'era_default');
    mp.setAttribute('experience_modifier', 100);
    mp.setAttribute('mp_use_map_settings', true);
  } else if (options.version) {
    out.setAttribute('version', options.version);
  }
  // Phase 25: `saved_game::write_general_info`'s `[statistics]`: ours, in place of the imported one.
  out.removeChildren('statistics');
  out.addChild('statistics', save.statistics ? WmlConfig.fromJSON(save.statistics) : new WmlConfig());

  // The `[side]` blocks the scenario declares are the templates for the
  // live ones: they carry recruit lists, controllers, team names and [ai]
  // config this port does not track in a save.
  const templates = new Map<number, WmlConfig>();
  const previousSnapshot = extras?.child('snapshot');
  for (const sideCfg of previousSnapshot?.children('side') ?? scenarioCfg.children('side')) {
    templates.set(sideCfg.getNumber('side', templates.size + 1), sideCfg);
  }

  // `[snapshot]` = the scenario's config with live state overlaid
  // (`play_controller::to_config`). Rebuild it from the scenario every
  // time so a stale copy in `wesnothExtras` cannot drift.
  out.removeChildren('snapshot');
  const snapCfg = previousSnapshot ? previousSnapshot.clone() : scenarioCfg.clone();
  snapCfg.removeChildren('side');
  snapCfg.removeChildren('variables');
  // A real `[snapshot]` has no `[story]`, even though the scenario config
  // it is built from does. Found the hard way: leave it in and the real
  // game replays the campaign's intro screens instead of resuming the
  // game, because a snapshot carrying story is indistinguishable to it
  // from a scenario that has not started yet.
  snapCfg.removeChildren('story');
  snapCfg.setAttribute('id', save.scenarioId ?? snapshot.scenario.id);
  snapCfg.setAttribute('name', save.scenarioName ?? snapshot.scenario.name);
  snapCfg.setAttribute('map_data', save.mapData ?? snapshot.map.data);
  snapCfg.setAttribute('turn_at', save.turnNumber);
  // `playing_team` is a 0-based index; `next_player_number` is the 1-based
  // side that plays *after* the current one, wrapping round the side list.
  snapCfg.setAttribute('playing_team', save.activeSide - 1);
  snapCfg.setAttribute('next_player_number', (save.activeSide % Math.max(1, save.teams.length)) + 1);
  snapCfg.setAttribute('init_side_done', true);
  // `game_state::write`/`game_data::write_snapshot` fields a loader reads
  // that no live state here carries: the next id new units get (derived
  // from the highest one in play), and the "resuming, not starting" flags.
  // Despite the name this is the HIGHEST id handed out so far, not the
  // next one (`unit_id_manager::get_save_id` returns the counter, and
  // `next_id()` pre-increments it) -- the real fixture says 11 while
  // carrying a unit whose `underlying_id` is 11. Never let it shrink
  // below what an imported save already recorded: ids of units that have
  // since died must not be reused.
  snapCfg.setAttribute(
    'next_underlying_unit_id',
    Math.max(
      snapCfg.getNumber('next_underlying_unit_id', 0),
      save.nextUnitId ?? 0,
      ...save.units.map((u) => u.underlyingId ?? 0),
      ...(save.recall ?? []).map((u) => u.underlyingId ?? 0),
    ),
  );
  if (save.turnLimit !== undefined) snapCfg.setAttribute('turns', save.turnLimit);
  // Phase 18: the live items (upstream's persistent [item]/[next_item_name] tags), not the scenario's.
  if (save.items !== undefined) {
    snapCfg.removeChildren('item');
    for (const item of save.items) snapCfg.addChild('item', WmlConfig.fromJSON(item));
  }
  // Phase 18: the live labels (map_labels::write), not the scenario's.
  if (save.labels !== undefined) {
    snapCfg.removeChildren('label');
    for (const label of save.labels) snapCfg.addChild('label', WmlConfig.fromJSON(label));
  }
  // Phase 19: the live playlist (write_music_play_list), not the scenario's.
  if (save.music !== undefined) {
    snapCfg.removeChildren('music');
    for (const m of save.music) snapCfg.addChild('music', WmlConfig.fromJSON(m));
  }
  // Phase 19: the live sound sources (write_sourcespecs), not the scenario's.
  if (save.soundSources !== undefined) {
    snapCfg.removeChildren('sound_source');
    for (const source of save.soundSources) snapCfg.addChild('sound_source', WmlConfig.fromJSON(source));
  }
  if (save.nextItemName !== undefined) {
    snapCfg.removeChildren('next_item_name');
    snapCfg.addChild('next_item_name').setAttribute('next_item_name', save.nextItemName);
  }
  snapCfg.setAttribute('it_is_a_new_turn', false);
  snapCfg.setAttribute('do_healing', true);
  // game_data::write_snapshot: `[disallow_end_turn]`'s state (`end_turn=` is read, never written).
  snapCfg.setAttribute('can_end_turn', save.endTurnForbidden === undefined);
  if (save.endTurnForbidden?.reason) snapCfg.setAttribute('cannot_end_turn_reason', TString.fromJSON(save.endTurnForbidden.reason));
  snapCfg.setAttribute('require_scenario', true);
  if (save.rng) {
    snapCfg.setAttribute('random_seed', save.rng.seed);
    snapCfg.setAttribute('random_calls', save.rng.calls);
  }
  if (save.variables) snapCfg.addChild('variables', WmlConfig.fromJSON(save.variables));
  // Phase 18c: the handlers still live, not the scenario's originals --
  // otherwise the real game would re-fire every spent one-time event.
  if (save.events) {
    snapCfg.removeChildren('event');
    for (const e of save.events) snapCfg.addChild('event', WmlConfig.fromJSON(e));
  }
  if (save.usedItems && save.usedItems.length > 0) {
    snapCfg.removeChildren('used_items');
    const used = snapCfg.addChild('used_items');
    for (const id of save.usedItems) used.setAttribute(id, true);
  }
  // `pathfind::manager::to_config`, merged into the snapshot root.
  snapCfg.removeChildren('tunnel');
  for (const t of save.tunnels ?? []) snapCfg.addChild('tunnel', WmlConfig.fromJSON(t));
  if (save.tunnels !== undefined || snapCfg.hasAttribute('next_teleport_group_id')) {
    snapCfg.setAttribute('next_teleport_group_id', save.nextTeleportGroupId ?? snapCfg.getNumber('next_teleport_group_id', 0));
  }
  for (const sideCfg of sidesToWml(save, templates)) snapCfg.addChild('side', sideCfg);
  out.addChild('snapshot', snapCfg);

  // `[replay_start]` is the scenario as it stood before any of this was
  // played; an imported save already has the real one.
  if (!out.child('replay_start')) {
    const replayStart = scenarioCfg.clone();
    replayStart.setAttribute('map_data', snapshot.map.data);
    out.addChild('replay_start', replayStart);
  }
  // Phase 18b: a save made here carries its whole command log, so it can be
  // written as a real replay -- `[replay_start]` from the state the log
  // starts at, `[replay]` from the log itself -- and replayed by the real
  // game (`wesnoth --load <save> --with-replay`).
  if (!extras && save.replay?.start) {
    out.removeChildren('replay_start');
    out.addChild('replay_start', replayStartToWml(save.replay.start, scenarioCfg, snapshot));
    out.removeChildren('replay');
    out.addChild('replay', replayToWml(save.replay.commands));
  }
  if (!out.child('replay')) out.addChild('replay', minimalReplay(save));
  // `replay_pos` is how many of `[replay]`'s commands have already been
  // played. Found the hard way: leave it out and the real game assumes
  // none have been, replays the scenario from its beginning -- story
  // screen and all -- instead of resuming the snapshot.
  snapCfg.setAttribute('replay_pos', out.child('replay')!.children('command').length);
  if (!out.child('carryover_sides')) out.addChild('carryover_sides', carryoverSides(save, campaign));

  return out;
}

/** `[carryover_sides]`: what upstream would carry into the next scenario (`carryover.cpp:209`). */
function carryoverSides(save: SaveGameData, campaign: WesnothCampaignInfo): WmlConfig {
  const cfg = new WmlConfig();
  cfg.setAttribute('next_scenario', '');
  if (save.rng) {
    cfg.setAttribute('random_seed', save.rng.seed);
    cfg.setAttribute('random_calls', save.rng.calls);
  }
  if (save.variables) cfg.addChild('variables', WmlConfig.fromJSON(save.variables));
  for (const team of save.teams) {
    const side = cfg.addChild('side');
    side.setAttribute('save_id', `${campaign.wesnothId}-${team.side}`);
    side.setAttribute('gold', team.gold);
    side.setAttribute('add', false);
  }
  return cfg;
}

/**
 * The version string a freshly-exported save claims. This port's content
 * comes from the 1.19 branch of the wesnoth submodule, so that is what it
 * says it is; `savegame.cpp`'s compatibility check accepts a differing
 * version with a warning the player can accept, so an older installed
 * build still opens it.
 */
export const WESNOTH_CONTENT_VERSION = '1.19.21';
