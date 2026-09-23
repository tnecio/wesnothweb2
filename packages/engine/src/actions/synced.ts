/**
 * The synced command layer (Phase 18b): every game-state change a player or
 * the AI makes is described as one `SyncedCommand`, recorded in order, and
 * executed by a single executor, so a game can be replayed, an action undone
 * and redone, and the log written out as a real Wesnoth `[replay]`.
 *
 * Mirrors upstream's `synced_commands.cpp`/`replay_helper.cpp` shapes
 * (`[move]`, `[attack]`, `[recruit]`, `[recall]`, `[disband]`,
 * `[init_side]`, `[end_turn]`, `[fire_event]`, `[start]`) and the
 * *dependent* commands recorded while one runs (`[random_seed]`, `[input]`,
 * `[choose]`). The executor itself lives with whoever owns the scenario flow
 * (`packages/ui`'s `GameSession`), because a command's meaning includes the
 * events it fires, victory checks and advancement -- which this module
 * deliberately knows nothing about. What lives here is the data: the command
 * union in a JSON-safe form (it is saved), its WML spelling, and the
 * `Recorder` that keeps the log.
 *
 * Coordinates are this port's own 0-based ones everywhere except the WML
 * spelling, which uses upstream's 1-based `x`/`y`.
 */

import { WmlConfig } from '../wml/config.js';
import { Location } from '../model/Location.js';
import type { GameBoard } from '../model/GameBoard.js';

/** A board position in JSON form (0-based, like `Location`). */
export interface HexJson {
  readonly x: number;
  readonly y: number;
}

export function hexOf(loc: Location): HexJson {
  return { x: loc.x, y: loc.y };
}

export function locOf(hex: HexJson): Location {
  return new Location(hex.x, hex.y);
}

/** `[move]`: the steps actually requested this turn (`replay_helper::get_movement`). */
export interface MoveCommand {
  readonly kind: 'move';
  readonly steps: readonly HexJson[];
  /** `skip_sighted=`: `all` / `only_ally`; omitted for a normal, interruptible move. */
  readonly skipSighted?: 'all' | 'only_ally';
}

/** `[attack]` (`replay_helper::get_attack`). The type/level/turn/tod fields are informational, as upstream (it only warns when they differ). */
export interface AttackCommand {
  readonly kind: 'attack';
  readonly source: HexJson;
  readonly destination: HexJson;
  readonly weapon: number;
  /** -1: the defender does not fight back. */
  readonly defenderWeapon: number;
  readonly attackerType?: string;
  readonly defenderType?: string;
  readonly attackerLevel?: number;
  readonly defenderLevel?: number;
  readonly turn?: number;
  readonly tod?: string;
}

/** `[recruit]`: `type=` at `x,y`, called by the leader standing at `[from]`. */
export interface RecruitCommand {
  readonly kind: 'recruit';
  readonly type: string;
  readonly loc: HexJson;
  readonly from: HexJson;
}

/**
 * `[recall] value=<unit id>`. `index` is this port's own addition: its units
 * do not always carry a unique id (see `GameBoard.removeFromRecallListAt`),
 * so the recall-list position the player picked is kept too and preferred
 * whenever the unit there still matches `id`. Not written to WML.
 */
export interface RecallCommand {
  readonly kind: 'recall';
  readonly id: string;
  readonly index?: number;
  readonly loc: HexJson;
  readonly from: HexJson;
}

/** `[disband] value=<unit id>`: dismissing a recall-list unit. `index` as for `RecallCommand`. */
export interface DisbandCommand {
  readonly kind: 'disband';
  readonly id: string;
  readonly index?: number;
}

/** `[init_side] side_number=`: the start of a side turn -- turn events, income, healing, refresh. */
export interface InitSideCommand {
  readonly kind: 'init_side';
  readonly side: number;
}

/** `[end_turn] next_player_number=`: the side-turn-end events, and the turn-end ones when the turn wraps. */
export interface EndTurnCommand {
  readonly kind: 'end_turn';
  readonly nextSide: number;
}

/** `[fire_event] raise=`: a `[set_menu_item]` command (`menu item <id>`), fired at `[source]`. */
export interface FireEventCommand {
  readonly kind: 'fire_event';
  readonly raise: string;
  readonly source?: HexJson;
}

/** `[start]`: the scenario's `prestart`/`start` events and the first side's turn start, recorded as one action as upstream does. */
export interface StartCommand {
  readonly kind: 'start';
}

/**
 * This port's own, never written to WML: the AI giving up a unit's remaining
 * moves/attacks (`stopunit_result`). Upstream does that outside any synced
 * context, so its replays do not reproduce it; recording it here keeps a
 * replay's mid-turn state bit-identical to the game it came from.
 */
export interface StopUnitCommand {
  readonly kind: 'stop_unit';
  readonly loc: HexJson;
  readonly movement: boolean;
  readonly attacks: boolean;
}

export type SyncedCommand =
  | MoveCommand
  | AttackCommand
  | RecruitCommand
  | RecallCommand
  | DisbandCommand
  | InitSideCommand
  | EndTurnCommand
  | FireEventCommand
  | StartCommand
  | StopUnitCommand;

/**
 * What a command asked for while it ran, recorded after it as upstream's
 * `dependent=yes` commands: the seed its random numbers were drawn from
 * (`[random_seed] new_seed=`), each `[message]` answer (`[input]`), and each
 * advancement choice (`[choose] value=`).
 */
export type Dependent =
  | { readonly kind: 'random_seed'; readonly seed: string }
  | { readonly kind: 'input'; readonly value?: number; readonly text?: string; readonly side: number }
  | { readonly kind: 'choose'; readonly value: number; readonly side: number };

/** One entry of the log: a command, what it depended on, and (when recorded live) a digest of the state it left behind. */
export interface RecordedCommand {
  readonly command: SyncedCommand;
  /** The side that issued it (`from_side=`). */
  readonly side: number;
  dependents: Dependent[];
  /** `stateDigest` after the command, for out-of-sync checks. Absent on commands imported from a real Wesnoth replay. */
  digest?: string;
}

// ---------------------------------------------------------------------------
// WML spelling
// ---------------------------------------------------------------------------

function writeHex(cfg: WmlConfig, hex: HexJson): WmlConfig {
  locOf(hex).writeToConfig(cfg);
  return cfg;
}

function readHex(cfg: WmlConfig | undefined): HexJson {
  return hexOf(cfg ? Location.fromConfig(cfg) : Location.NULL);
}

/** `write_locations`: comma lists of 1-based x and y. */
function writeSteps(cfg: WmlConfig, steps: readonly HexJson[]): void {
  cfg.setAttribute('x', steps.map((s) => s.x + 1).join(','));
  cfg.setAttribute('y', steps.map((s) => s.y + 1).join(','));
}

/** `read_locations`; throws on a malformed list, as upstream's does. */
function readSteps(cfg: WmlConfig): HexJson[] {
  const xs = cfg.getString('x', '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  const ys = cfg.getString('y', '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (xs.length !== ys.length) throw new Error('[move]: x and y lists differ in length');
  return xs.map((x, i) => {
    const px = Number.parseInt(x, 10);
    const py = Number.parseInt(ys[i]!, 10);
    if (Number.isNaN(px) || Number.isNaN(py)) throw new Error(`[move]: bad step ${x},${ys[i]}`);
    return { x: px - 1, y: py - 1 };
  });
}

/** The command's own tag and body, e.g. `['move', {x=..., y=...}]`. `null` for this port's local commands, which have no WML form. */
export function commandToWml(command: SyncedCommand): { tag: string; cfg: WmlConfig } | null {
  const cfg = new WmlConfig();
  switch (command.kind) {
    case 'move':
      if (command.skipSighted) cfg.setAttribute('skip_sighted', command.skipSighted);
      writeSteps(cfg, command.steps);
      return { tag: 'move', cfg };
    case 'attack':
      cfg.addChild('source', writeHex(new WmlConfig(), command.source));
      cfg.addChild('destination', writeHex(new WmlConfig(), command.destination));
      cfg.setAttribute('weapon', command.weapon);
      cfg.setAttribute('defender_weapon', command.defenderWeapon);
      if (command.attackerType !== undefined) cfg.setAttribute('attacker_type', command.attackerType);
      if (command.defenderType !== undefined) cfg.setAttribute('defender_type', command.defenderType);
      if (command.attackerLevel !== undefined) cfg.setAttribute('attacker_lvl', command.attackerLevel);
      if (command.defenderLevel !== undefined) cfg.setAttribute('defender_lvl', command.defenderLevel);
      if (command.turn !== undefined) cfg.setAttribute('turn', command.turn);
      if (command.tod !== undefined) cfg.setAttribute('tod', command.tod);
      return { tag: 'attack', cfg };
    case 'recruit':
      cfg.setAttribute('type', command.type);
      writeHex(cfg, command.loc);
      cfg.addChild('from', writeHex(new WmlConfig(), command.from));
      return { tag: 'recruit', cfg };
    case 'recall':
      cfg.setAttribute('value', command.id);
      writeHex(cfg, command.loc);
      cfg.addChild('from', writeHex(new WmlConfig(), command.from));
      return { tag: 'recall', cfg };
    case 'disband':
      cfg.setAttribute('value', command.id);
      return { tag: 'disband', cfg };
    case 'init_side':
      cfg.setAttribute('side_number', command.side);
      return { tag: 'init_side', cfg };
    case 'end_turn':
      cfg.setAttribute('next_player_number', command.nextSide);
      return { tag: 'end_turn', cfg };
    case 'fire_event':
      cfg.setAttribute('raise', command.raise);
      if (command.source) cfg.addChild('source', writeHex(new WmlConfig(), command.source));
      return { tag: 'fire_event', cfg };
    case 'start':
      return { tag: 'start', cfg };
    case 'stop_unit':
      return null;
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

/** The command a `[command]` child describes, or `null` for one this port does not execute (`[label]`, `[speak]`, `[countdown_update]`, ...). */
export function commandFromWml(tag: string, cfg: WmlConfig): SyncedCommand | null {
  switch (tag) {
    case 'move': {
      const skip = cfg.getString('skip_sighted', '');
      return {
        kind: 'move',
        steps: readSteps(cfg),
        ...(skip === 'all' || skip === 'only_ally' ? { skipSighted: skip } : {}),
      };
    }
    case 'attack':
      return {
        kind: 'attack',
        source: readHex(cfg.child('source')),
        destination: readHex(cfg.child('destination')),
        weapon: cfg.getNumber('weapon', 0),
        // Upstream's own fallback for replays older than defender_weapon=.
        defenderWeapon: cfg.hasAttribute('defender_weapon') ? cfg.getNumber('defender_weapon', -1) : -1,
        ...(cfg.hasAttribute('attacker_type') ? { attackerType: cfg.getString('attacker_type') } : {}),
        ...(cfg.hasAttribute('defender_type') ? { defenderType: cfg.getString('defender_type') } : {}),
        ...(cfg.hasAttribute('attacker_lvl') ? { attackerLevel: cfg.getNumber('attacker_lvl') } : {}),
        ...(cfg.hasAttribute('defender_lvl') ? { defenderLevel: cfg.getNumber('defender_lvl') } : {}),
        ...(cfg.hasAttribute('turn') ? { turn: cfg.getNumber('turn') } : {}),
        ...(cfg.hasAttribute('tod') ? { tod: cfg.getString('tod') } : {}),
      };
    case 'recruit':
      return { kind: 'recruit', type: cfg.getString('type'), loc: readHex(cfg), from: readHex(cfg.child('from')) };
    case 'recall':
      return { kind: 'recall', id: cfg.getString('value'), loc: readHex(cfg), from: readHex(cfg.child('from')) };
    case 'disband':
      return { kind: 'disband', id: cfg.getString('value') };
    case 'init_side':
      return { kind: 'init_side', side: cfg.getNumber('side_number', 1) };
    case 'end_turn':
      return { kind: 'end_turn', nextSide: cfg.getNumber('next_player_number', 0) };
    case 'fire_event': {
      const source = cfg.child('source');
      return { kind: 'fire_event', raise: cfg.getString('raise'), ...(source ? { source: readHex(source) } : {}) };
    }
    case 'start':
      return { kind: 'start' };
    default:
      return null;
  }
}

function dependentToWml(dep: Dependent): { tag: string; cfg: WmlConfig; fromSide: number | 'server' } {
  const cfg = new WmlConfig();
  switch (dep.kind) {
    case 'random_seed':
      cfg.setAttribute('new_seed', dep.seed);
      return { tag: 'random_seed', cfg, fromSide: 'server' };
    case 'input':
      if (dep.value !== undefined) cfg.setAttribute('value', dep.value);
      if (dep.text !== undefined) cfg.setAttribute('text', dep.text);
      return { tag: 'input', cfg, fromSide: dep.side };
    case 'choose':
      cfg.setAttribute('value', dep.value);
      return { tag: 'choose', cfg, fromSide: dep.side };
    default: {
      const exhaustive: never = dep;
      return exhaustive;
    }
  }
}

function dependentFromWml(tag: string, cfg: WmlConfig, fromSide: string): Dependent | null {
  const side = Number.parseInt(fromSide, 10);
  switch (tag) {
    case 'random_seed':
      return { kind: 'random_seed', seed: cfg.getString('new_seed') };
    case 'input':
      return {
        kind: 'input',
        ...(cfg.hasAttribute('value') ? { value: cfg.getNumber('value') } : {}),
        ...(cfg.hasAttribute('text') ? { text: cfg.getString('text') } : {}),
        side: Number.isNaN(side) ? 0 : side,
      };
    case 'choose':
      return { kind: 'choose', value: cfg.getNumber('value', 0), side: Number.isNaN(side) ? 0 : side };
    default:
      return null;
  }
}

/**
 * The `[command]` blocks one recorded command becomes in a `[replay]`: the
 * command itself, then one `dependent=yes` block per dependent, in the order
 * they were asked for (`replay::add_synced_command` / `replay::user_input`).
 * Empty for this port's local commands.
 */
export function recordedCommandToWml(rec: RecordedCommand): WmlConfig[] {
  const main = commandToWml(rec.command);
  if (!main) return [];
  const out: WmlConfig[] = [];
  const cmd = new WmlConfig();
  // [start] carries no from_side upstream (replay::add_start); [init_side]/[end_turn] neither.
  if (rec.command.kind !== 'start' && rec.command.kind !== 'init_side' && rec.command.kind !== 'end_turn') {
    cmd.setAttribute('from_side', rec.side);
  }
  cmd.addChild(main.tag, main.cfg);
  out.push(cmd);
  for (const dep of rec.dependents) {
    const d = dependentToWml(dep);
    const depCmd = new WmlConfig();
    depCmd.setAttribute('dependent', true);
    depCmd.setAttribute('from_side', d.fromSide);
    depCmd.addChild(d.tag, d.cfg);
    out.push(depCmd);
  }
  return out;
}

/** What `recordedCommandsFromWml` skipped, so a caller can report it rather than silently lose it. */
export interface ReplayReadIssue {
  readonly index: number;
  readonly message: string;
}

/**
 * Reads a `[replay]` block's `[command]`s back into recorded commands:
 * each non-dependent command starts an entry and every `dependent=yes`
 * block after it attaches to it. Commands this port does not execute
 * (`[speak]`, `[label]`, `[countdown_update]`, ...) are skipped and reported.
 */
export function recordedCommandsFromWml(replay: WmlConfig): { commands: RecordedCommand[]; issues: ReplayReadIssue[] } {
  const commands: RecordedCommand[] = [];
  const issues: ReplayReadIssue[] = [];
  let current: RecordedCommand | null = null;
  replay.children('command').forEach((cmd, index) => {
    const first = cmd.allChildren().find((c) => c.tag !== 'checkup' && !c.tag.startsWith('checkup'));
    if (!first) return;
    if (cmd.getBoolean('dependent', false)) {
      const dep = dependentFromWml(first.tag, first.config, cmd.getString('from_side', ''));
      if (!dep) issues.push({ index, message: `unsupported dependent [${first.tag}]` });
      else if (!current) issues.push({ index, message: `dependent [${first.tag}] with no command before it` });
      else current.dependents.push(dep);
      return;
    }
    let command: SyncedCommand | null;
    try {
      command = commandFromWml(first.tag, first.config);
    } catch (e) {
      issues.push({ index, message: `[${first.tag}]: ${(e as Error).message}` });
      current = null;
      return;
    }
    if (!command) {
      issues.push({ index, message: `unsupported command [${first.tag}]` });
      // A dependent after an unsupported command belongs to it, not to the one before.
      current = null;
      return;
    }
    current = { command, side: cmd.getNumber('from_side', 0), dependents: [] };
    commands.push(current);
  });
  return { commands, issues };
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/**
 * The command log (`replay`/`replay_recorder_base`): commands in execution
 * order, each with its dependents. Undo cuts the last command off (keeping
 * it for redo, as `replay::undo_cut`); redo appends it again.
 */
export class Recorder {
  private readonly log: RecordedCommand[] = [];

  get commands(): readonly RecordedCommand[] {
    return this.log;
  }

  get length(): number {
    return this.log.length;
  }

  add(command: SyncedCommand, side: number): RecordedCommand {
    const rec: RecordedCommand = { command, side, dependents: [] };
    this.log.push(rec);
    return rec;
  }

  /** The last command, which dependents attach to. */
  last(): RecordedCommand | undefined {
    return this.log[this.log.length - 1];
  }

  /** Removes and returns the last command (`replay::undo_cut`). */
  cutLast(): RecordedCommand | undefined {
    return this.log.pop();
  }

  replaceAll(commands: readonly RecordedCommand[]): void {
    this.log.splice(0, this.log.length, ...commands.map(cloneRecorded));
  }

  toJSON(): RecordedCommand[] {
    return this.log.map(cloneRecorded);
  }
}

export function cloneRecorded(rec: RecordedCommand): RecordedCommand {
  return {
    command: rec.command,
    side: rec.side,
    dependents: rec.dependents.map((d) => ({ ...d })),
    ...(rec.digest !== undefined ? { digest: rec.digest } : {}),
  };
}

// ---------------------------------------------------------------------------
// State digest
// ---------------------------------------------------------------------------

/** 32-bit FNV-1a, hex. Not cryptographic -- it only has to notice a difference. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The state a replay must reproduce exactly, as one canonical string --
 * this port's stand-in for upstream's `[checkup]` (which compares only
 * random-call counts and the next unit id). Covers every unit on the board
 * and on recall lists, gold and villages per side, plus whatever `extra`
 * the caller adds (turn, active side, variables). `stateDigest` hashes it;
 * the string itself is what a divergence report diffs.
 */
export function stateDescription(board: GameBoard, extra: Readonly<Record<string, string | number | boolean | null>> = {}): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${String(v)}`);
  for (const team of board.teams()) {
    const villages = board
      .villagesOwnedBy(team.side)
      .map((l) => l.key())
      .sort()
      .join(' ');
    parts.push(`side ${team.side}: gold=${team.gold} villages=[${villages}]`);
    for (const u of board.recallList(team.side)) {
      parts.push(`  recall ${u.id}/${u.type.id} hp=${u.hitpoints}/${u.maxHitpoints} xp=${u.experience}/${u.maxExperience}`);
    }
  }
  const units = [...board.allUnits()].sort((a, b) => a.location.y - b.location.y || a.location.x - b.location.x);
  for (const u of units) {
    const statuses = [...u.statuses].sort().join(',');
    parts.push(
      `unit ${u.location.key()} ${u.side}:${u.id}/${u.type.id} hp=${u.hitpoints}/${u.maxHitpoints} xp=${u.experience}/${u.maxExperience} ` +
        `mv=${u.movesLeft}/${u.maxMoves} at=${u.attacksLeft} f=${u.facing} st=[${statuses}]`,
    );
  }
  return parts.join('\n');
}

export function stateDigest(board: GameBoard, extra: Readonly<Record<string, string | number | boolean | null>> = {}): string {
  return fnv1a(stateDescription(board, extra));
}
