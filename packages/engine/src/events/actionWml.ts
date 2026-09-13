/**
 * TS port of the executable half of WML's action tags: the handlers a
 * `[event]` (or `[if][then]`, `[command]`, ...) body invokes tag by tag.
 *
 * Upstream split this across two eras of code that this port collapses
 * into one place: the handful of tags still implemented in C++
 * (`src/game_events/action_wml.cpp` -- `[unit]`, `[modify_turns]`,
 * `[recall]`, `[tunnel]`, ...) and the much larger set that moved to Lua
 * (`data/lua/wml-tags.lua`, `data/lua/wml-flow.lua`, and the per-tag files
 * under `data/lua/wml/*.lua` -- `[message]`, `[if]`, `[set_variable]`,
 * `[modify_unit]`, `[kill]`, `[store_unit]`, ...). Since Lua isn't ported
 * yet (Phase 3), this file re-implements the *behavior* those Lua files
 * define directly in TypeScript, reading them as the spec.
 *
 * ## Implemented action tags
 * `message`, `if` (with `then`/`elseif`/`else`), `set_variable` (`value`,
 * `literal`, `to_variable`, `prefix`, `suffix`, `add`, `sub`, `multiply`,
 * `divide`, `modulo`, `abs`, `round` incl. ceil/floor/trunc, `power`,
 * `root` incl. square/cube, `ipart`/`fpart`, `min`/`max`, `string_length`,
 * `reverse`, `join`), `set_variables` (`replace`/`append`/`merge`≈append/
 * `insert` modes over `[value]` children), `clear_variable`, `store_unit`,
 * `unstore_unit` (real, reported bug: a common "hide units off-board during
 * a cutscene" idiom -- `[store_unit] kill=yes` then a later `[unstore_unit]`
 * -- silently never restored the unit at all, permanently removing it; see
 * that handler's own doc comment), `kill`, `modify_unit` (simplified, see
 * below), `unit` (spawn), `gold`,
 * `store_gold`, `allow_recruit`, `capture_village` (side= only, see its
 * own doc comment), `recall` (see its own doc comment for what's
 * deliberately not re-implemented from upstream's C++ `[recall]` handler),
 * `move_unit` (real, reported bug: real scenario content -- e.g.
 * Dead_Water scenario 1's `{MOVE_UNIT id=Gwabbo 20 10}` -- silently did
 * nothing; see that handler's own doc comment for what it does and does
 * not cover, and `pathfind.ts`'s `findVacantTile`, ported alongside it),
 * `objectives` (real, reported bug: used to be a no-op -- see
 * `objectives.ts`'s own doc comment for the real `data/lua/wml/
 * objectives.lua` logic it ports and what's deliberately scoped out).
 *
 * Presentation-only tags that have no headless effect are registered as
 * explicit no-ops (not silently dropped) so real content doesn't spam
 * "unsupported tag" warnings: `music`, `sound`, `scroll_to`,
 * `scroll_to_unit`, `delay`, `redraw`, `highlight`, `floating_text`,
 * `label`, `move_unit_fake` (a pure animation of a move `move_unit`
 * already performed for real).
 *
 * ## Extension points (NOT implemented here, on purpose)
 * `[attack]`, `[recruit]` (need `packages/engine/src/actions/`'s
 * combat/recruit logic, being built in parallel -- explicitly out of
 * scope for this module per the task brief) and `[lua]` (needs the Phase
 * 3 Lua bridge) remain placeholders. Each is registered with a handler
 * that logs a clear "extension point" message and no-ops, rather than
 * either crashing or silently doing nothing -- `ActionRegistry.
 * register(tag, handler)` is public specifically so later work can
 * override these without touching this file.
 *
 * ## Known simplifications
 * `[modify_unit]` upstream (`data/lua/wml/modify_unit.lua`) is a fully
 * generic WML-tree merge over a unit's *entire* serialized config
 * (arbitrary nested tags, `mode=replace` semantics per-subtree, `[object]`/
 * `[trait]`/`[effect]` application). This port implements only: direct
 * top-level scalar field overrides for the handful of fields `model/
 * Unit.ts` actually models (hitpoints, max_hitpoints, moves, max_moves,
 * experience, max_experience, side, canrecruit, name, facing), plus
 * `[set_variable]`/`[set_variables]`/`[clear_variable]` children applied
 * to the matched unit's own `variables` bag. No `[object]`/`[trait]`/
 * `[effect]` support (needs the effects/WFL machinery `Unit.ts` itself
 * defers, see its module doc comment).
 *
 * Loop tags (`[while]`/`[for]`/`[foreach]`/`[repeat]`/`[switch]`,
 * `data/lua/wml-flow.lua`) are NOT ported -- only `[if]` is, since that
 * covers everything Dead_Water scenario 1's real event bodies use. The
 * `ExitState`/`ActionRegistry` plumbing (see `context.ts`) is generic
 * enough that adding them later doesn't require restructuring this file.
 */

import type { EndLevelState } from './context.js';
import { Direction, Location, parseDirection } from '../model/Location.js';
import { Unit } from '../model/Unit.js';
import { WmlConfig } from '../wml/config.js';
import { checkRecruitLocation, recallUnit } from '../actions/recruit.js';
import { findVacantTile } from '../pathfind/pathfind.js';
import type { ActionHandler, EventContext } from './context.js';
import { ActionRegistry } from './context.js';
import { conditionalPassed } from './conditionalWml.js';
import { findUnits, locationMatchesFilter, unitMatchesFilter } from './filter.js';
import { actionLiftFog, actionPlaceShroud, actionRemoveShroud, actionResetFog } from './shroudWml.js';
import { actionTimeArea, actionRemoveTimeArea, actionReplaceSchedule, actionStoreTimeOfDay } from './todWml.js';
import { newVarNode, varNodeFromConfig, varNodeToConfig, VariableStore, type VarNode } from './variables.js';
import { parseScenarioObjectives } from './objectives.js';

// --- shared helpers ---

/**
 * Runs a sequence of action tags (an `[event]` body, or an `[if][then]`/
 * `[else]`/`[elseif][then]` body), mirroring `wml-utils.lua`'s
 * `handle_event_commands`: each child is shallow-`$var`-expanded and
 * dispatched through `ctx.registry` immediately before it runs (NOT
 * upfront for the whole body -- see `variables.ts`'s `expandConfig` doc
 * comment on why), `filter*`-prefixed children are skipped (they belong to
 * the tag that owns this body, e.g. an `[event]`'s own trigger filters,
 * not to the action sequence), and iteration stops as soon as
 * `ctx.exit.type` becomes non-`'none'`.
 */
export function runActionSequence(body: WmlConfig, ctx: EventContext): void {
  for (const { tag, config } of body.allChildren()) {
    if (tag.startsWith('filter')) continue;
    const handler = ctx.registry.get(tag);
    if (!handler) {
      ctx.log('warn', `[${tag}] not supported (skipped)`);
      continue;
    }
    try {
      handler(ctx.variables.expandConfig(config), ctx);
    } catch (e) {
      ctx.log('error', `Error occurred inside [${tag}]: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (ctx.exit.type !== 'none') break;
  }
}

function extensionPoint(tag: string, owner: string): ActionHandler {
  return (_cfg, ctx) => {
    ctx.log(
      'warn',
      `[${tag}] extension point not implemented (needs ${owner}) -- no-op. ` +
        `Register a real handler via ActionRegistry.register('${tag}', ...) to wire it in.`,
    );
  };
}

function noop(): void {
  /* presentation-only, headless no-op */
}

// --- [message] ---

function actionMessage(cfg: WmlConfig, ctx: EventContext): void {
  const speakerAttr = cfg.getString('speaker', '');
  let speaker = '';
  if (speakerAttr === 'narrator') {
    speaker = 'narrator';
  } else if (speakerAttr === 'unit') {
    speaker = ctx.board.unitAt(ctx.loc1)?.id ?? '';
  } else if (speakerAttr === 'second_unit') {
    speaker = ctx.board.unitAt(ctx.loc2)?.id ?? '';
  } else if (speakerAttr !== '') {
    speaker = ctx.board.allUnits().find((u) => u.id === speakerAttr)?.id ?? speakerAttr;
  }
  ctx.messages.push({
    speaker,
    message: cfg.getString('message', ''),
    image: cfg.hasAttribute('image') ? cfg.getString('image') : undefined,
    caption: cfg.hasAttribute('caption') ? cfg.getString('caption') : undefined,
    unitsBefore: ctx.board.allUnits().map((unit) => ({
      unit,
      x: unit.location.x,
      y: unit.location.y,
      hitpoints: unit.hitpoints,
    })),
  });
}

// --- [if] ---

function actionIf(cfg: WmlConfig, ctx: EventContext): void {
  const hasBranches = cfg.hasChild('then') || cfg.hasChild('elseif') || cfg.hasChild('else');
  if (!hasBranches) {
    ctx.log('error', "[if] didn't find any [then], [elseif], or [else] children.");
    return;
  }

  if (conditionalPassed(cfg, ctx)) {
    for (const thenCfg of cfg.children('then')) {
      runActionSequence(thenCfg, ctx);
      if (ctx.exit.type !== 'none') break;
    }
    return;
  }

  for (const elseifCfg of cfg.children('elseif')) {
    if (conditionalPassed(elseifCfg, ctx)) {
      for (const thenCfg of elseifCfg.children('then')) {
        runActionSequence(thenCfg, ctx);
        if (ctx.exit.type !== 'none') break;
      }
      return;
    }
  }

  for (const elseCfg of cfg.children('else')) {
    runActionSequence(elseCfg, ctx);
    if (ctx.exit.type !== 'none') break;
  }
}

// --- [set_variable] ---

/** Core of `[set_variable]`, factored out so `[modify_unit]` can run it against a per-unit variable store too. */
export function applySetVariable(cfg: WmlConfig, variables: VariableStore, log: EventContext['log']): void {
  const name = cfg.getString('name', '');
  if (name === '') {
    log('error', 'trying to set a variable with an empty name');
    return;
  }

  if (cfg.hasAttribute('value')) variables.set(name, cfg.get('value')!);
  if (cfg.hasAttribute('literal')) variables.set(name, cfg.get('literal')!);
  if (cfg.hasAttribute('to_variable')) variables.set(name, variables.get(cfg.getString('to_variable')) ?? '');
  if (cfg.hasAttribute('suffix')) variables.set(name, variables.getString(name) + cfg.getString('suffix'));
  if (cfg.hasAttribute('prefix')) variables.set(name, cfg.getString('prefix') + variables.getString(name));

  const num = (): number => variables.getNumber(name, 0);
  if (cfg.hasAttribute('add')) variables.set(name, num() + cfg.getNumber('add'));
  if (cfg.hasAttribute('sub')) variables.set(name, num() - cfg.getNumber('sub'));
  if (cfg.hasAttribute('multiply')) variables.set(name, num() * cfg.getNumber('multiply'));
  if (cfg.hasAttribute('divide')) {
    const d = cfg.getNumber('divide');
    if (d === 0) log('error', `division by zero on variable ${name}`);
    else variables.set(name, num() / d);
  }
  if (cfg.hasAttribute('modulo')) {
    const m = cfg.getNumber('modulo');
    if (m === 0) log('error', `division by zero on variable ${name}`);
    else variables.set(name, num() % m);
  }
  if (cfg.hasAttribute('abs')) variables.set(name, Math.abs(num()));
  if (cfg.hasAttribute('reverse')) variables.set(name, variables.getString(name).split('').reverse().join(''));

  if (cfg.hasAttribute('root')) {
    const rootAttr = cfg.getString('root');
    const root = rootAttr === 'square' ? 2 : rootAttr === 'cube' ? 3 : cfg.getNumber('root', 2);
    const radicand = num();
    if (radicand < 0 && root % 2 === 0) {
      log('error', `${root === 2 ? 'square' : `${root}th`} root of negative number on variable ${name}`);
    } else {
      variables.set(name, Math.sign(radicand) * Math.abs(radicand) ** (1 / root));
    }
  }
  if (cfg.hasAttribute('power')) variables.set(name, num() ** cfg.getNumber('power'));

  if (cfg.hasAttribute('round')) {
    const roundAttr = cfg.getString('round');
    const v = num();
    if (roundAttr === 'ceil') variables.set(name, Math.ceil(v));
    else if (roundAttr === 'floor') variables.set(name, Math.floor(v));
    else if (roundAttr === 'trunc') variables.set(name, Math.trunc(v));
    else {
      const decimals = cfg.getNumber('round', 0);
      const scale = 10 ** decimals;
      variables.set(name, Math.round(v * scale) / scale);
    }
  }

  if (cfg.hasAttribute('ipart')) variables.set(name, Math.trunc(cfg.getNumber('ipart')));
  if (cfg.hasAttribute('fpart')) variables.set(name, cfg.getNumber('fpart') - Math.trunc(cfg.getNumber('fpart')));

  if (cfg.hasAttribute('min')) {
    const values = cfg
      .getString('min')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n));
    if (values.length > 0) variables.set(name, Math.min(...values));
  }
  if (cfg.hasAttribute('max')) {
    const values = cfg
      .getString('max')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n));
    if (values.length > 0) variables.set(name, Math.max(...values));
  }

  if (cfg.hasAttribute('string_length')) variables.set(name, String(cfg.get('string_length')).length);

  const joinCfg = cfg.child('join');
  if (joinCfg) {
    const arrayName = joinCfg.getString('variable', '');
    const separator = joinCfg.getString('separator', '');
    const keyName = joinCfg.getString('key', 'value');
    const removeEmpty = joinCfg.getBoolean('remove_empty', false);
    const parts: string[] = [];
    for (const elem of variables.getArray(arrayName)) {
      const v = elem.attrs.get(keyName);
      if (v === undefined && removeEmpty) continue;
      parts.push(v === undefined ? '' : String(v));
    }
    variables.set(name, parts.join(separator));
  }

  // NOT ported: `rand=` (needs the shared RNG, owned by packages/engine/src/rng/, out of
  // scope here), `formula=` (would need a `value`-bound WFL context; skipped for now),
  // `time=stamp` (no wall-clock concept in a deterministic headless engine).
}

function actionSetVariable(cfg: WmlConfig, ctx: EventContext): void {
  applySetVariable(cfg, ctx.variables, ctx.log);
}

// --- [set_variables] ---

function actionSetVariables(cfg: WmlConfig, ctx: EventContext): void {
  const name = cfg.getString('name', '');
  if (name === '') {
    ctx.log('error', 'trying to set variables with an empty name');
    return;
  }
  const mode = cfg.getString('mode', 'replace');

  const data: VarNode[] = [];
  for (const { tag, config } of cfg.allChildren()) {
    if (tag === 'value') data.push(varNodeFromConfig(ctx.variables.expandConfig(config)));
    // [literal]/[split] (data/lua/wml/set_variables.lua) are not ported -- see module doc comment.
  }

  if (mode === 'replace') {
    ctx.variables.setArray(name, data);
  } else if (mode === 'append' || mode === 'merge') {
    // 'merge' (element-wise field merge) collapses to 'append' here -- see module doc comment.
    for (const item of data) ctx.variables.pushArray(name, item);
  } else if (mode === 'insert') {
    const idx = cfg.getNumber('insert_index', ctx.variables.arrayLength(name));
    const existing = ctx.variables.getArray(name).slice();
    existing.splice(idx, 0, ...data);
    ctx.variables.setArray(name, existing);
  } else {
    ctx.log('error', `unknown mode for [set_variables]: ${mode}`);
  }
}

// --- [clear_variable] ---

function actionClearVariable(cfg: WmlConfig, ctx: EventContext): void {
  const names = cfg.getString('name', '');
  if (names === '') {
    ctx.log('error', '[clear_variable] missing required name= attribute.');
    return;
  }
  for (const n of names.split(',')) {
    ctx.variables.clear(n.trim());
  }
}

// --- [store_unit] ---

function unitToVarNode(unit: Unit): VarNode {
  const node = newVarNode();
  node.attrs.set('type', unit.type.id);
  node.attrs.set('id', unit.id);
  node.attrs.set('name', unit.name);
  node.attrs.set('side', unit.side);
  if (unit.location.valid()) {
    node.attrs.set('x', unit.location.wmlX);
    node.attrs.set('y', unit.location.wmlY);
  } else {
    node.attrs.set('x', 'recall');
    node.attrs.set('y', 'recall');
  }
  node.attrs.set('hitpoints', unit.hitpoints);
  node.attrs.set('max_hitpoints', unit.maxHitpoints);
  node.attrs.set('moves', unit.movesLeft);
  node.attrs.set('max_moves', unit.maxMoves);
  node.attrs.set('experience', unit.experience);
  node.attrs.set('max_experience', unit.maxExperience);
  node.attrs.set('level', unit.level);
  node.attrs.set('canrecruit', unit.canRecruit);
  node.attrs.set('resting', unit.resting);
  if (unit.variables) {
    const varsNode = varNodeFromConfig(unit.variables);
    if (varsNode.attrs.size > 0 || varsNode.arrays.size > 0) {
      node.arrays.set('variables', [varsNode]);
    }
  }
  return node;
}

function actionStoreUnit(cfg: WmlConfig, ctx: EventContext): void {
  const filterCfg = cfg.child('filter');
  if (!filterCfg) {
    ctx.log('error', '[store_unit] missing required [filter] tag');
    return;
  }
  const kill = cfg.getBoolean('kill', false);
  const variable = cfg.getString('variable', 'unit');
  const xStr = filterCfg.getString('x', '');
  const yStr = filterCfg.getString('y', '');
  const includeRecall = xStr === 'recall' && yStr === 'recall';
  const units = findUnits(ctx.board, ctx.variables.expandConfig(filterCfg), includeRecall);

  const mode = cfg.getString('mode', 'always_clear');
  if (mode === 'append') {
    for (const u of units) ctx.variables.pushArray(variable, unitToVarNode(u));
  } else {
    ctx.variables.setArray(
      variable,
      units.map((u) => unitToVarNode(u)),
    );
  }

  if (kill) {
    for (const u of units) {
      if (u.location.valid()) ctx.board.removeUnitAt(u.location);
    }
  }
}

// --- [unstore_unit] ---

/**
 * Real, reported bug: Liberty scenario 1's `[store_unit] variable=
 * goodguys_store kill=yes [filter] side=1 [/filter] [/store_unit]` (hiding
 * Baldras off-board during the opening goblin conversation, a common real
 * WML idiom for a cutscene) has a matching `[unstore_unit] variable=
 * goodguys_store [/unstore_unit]` a few lines later meant to put him right
 * back -- but this tag was never registered as an action handler at all, so
 * `runActionSequence` silently skipped it (a `[tag] not supported` warn
 * log). Baldras stayed permanently removed: the scenario's own leader unit
 * was simply absent from the board for the entire rest of the playthrough,
 * making it unplayable (no unit to select/move/recruit with). Discovered
 * investigating a "white circle units that can't move" bug report -- the
 * OTHER half of that report was `[base_unit]` (see UnitTypeDatabase.ts's
 * fix, same session), but this is a distinct, more severe issue underneath.
 *
 * Ports `data/lua/wml-tags.lua`'s `wml_actions.unstore_unit`: reads the
 * stored unit config back out of `variable=` (the container-node rules --
 * implicit index 0 for a plain array-variable name, explicit `foo[n]`
 * otherwise -- are the same ones `[store_unit]`'s own `variable=` uses, see
 * `VariableStore.getContainerNode`), rebuilds a real `Unit` from it via the
 * exact same `Unit.fromConfig` path `[unit]` uses (their config shapes are
 * exact duals: `unitToVarNode` writes precisely the attributes
 * `Unit.fromConfig` reads), and places it at `x=`/`y=` if given, else the
 * unit's own stored position (matching upstream's `x = cfg.x or unit.x`).
 *
 * NOT ported: `advance=`/`animate=`/`text=`/`color=` (cosmetic-only, no
 * headless effect -- consistent with this file's other no-op cosmetic
 * tags), `find_vacant=`/`check_passability=` (no real content exercised so
 * far needs a vacant-hex fallback here), and restoring to a recall list
 * (`x,y=recall,recall` -- Liberty's own usage always restores to the map).
 * Also inherits `[store_unit]`'s own gap: `unitToVarNode` doesn't serialize
 * `[modifications]`, so a unit's `[object]` effects (Baldras's own
 * `mace-spiked` weapon override, granted in his `[side]` block) are lost
 * across a store/kill/unstore round-trip -- a real but lower-severity gap
 * than the unit being missing entirely, not fixed here.
 */
function actionUnstoreUnit(cfg: WmlConfig, ctx: EventContext): void {
  const variable = cfg.getString('variable', '');
  if (!variable) {
    ctx.log('error', '[unstore_unit] missing required variable= attribute');
    return;
  }
  const node = ctx.variables.getContainerNode(variable, false);
  if (!node || node.attrs.size === 0) {
    ctx.log('error', `[unstore_unit]: variable '${variable}' doesn't contain unit data`);
    return;
  }
  const unitCfg = varNodeToConfig(node);
  let unit: Unit;
  try {
    unit = Unit.fromConfig(unitCfg, ctx.resolveType);
  } catch (e) {
    ctx.log('error', `Error occurred inside [unstore_unit]: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (cfg.hasAttribute('x') && cfg.hasAttribute('y')) {
    unit.location = Location.fromConfig(cfg);
  }
  if (!unit.location.valid()) {
    ctx.log('error', "[unstore_unit]: stored unit has no valid location (recall-list restore isn't supported)");
    return;
  }
  ctx.board.addUnit(unit);
  ctx.board.captureVillage(unit.location, unit.side);
}

// --- [kill] ---

function actionKill(cfg: WmlConfig, ctx: EventContext): void {
  if (cfg.hasChild('filter')) {
    ctx.log('error', 'Tag [filter] may not be used in [kill]');
    return;
  }
  const fireEvent = cfg.getBoolean('fire_event', false);
  const secondaryCfg = cfg.child('secondary_unit');
  const secondary = secondaryCfg ? findUnits(ctx.board, ctx.variables.expandConfig(secondaryCfg))[0] : undefined;

  const doomed = findUnits(ctx.board, cfg);
  let killedCount = 0;
  for (const unit of doomed) {
    const deathLoc = unit.location;
    const killerLoc = secondary ? secondary.location : deathLoc;
    unit.hitpoints = 0;
    // NOTE: upstream fires 'last breath'/'die' *before* erasing the unit, synchronously
    // (recursive pump). This port's pump only drains queued events after the current
    // action sequence finishes (see pump.ts's module doc comment), so a raised 'die'
    // event here will see the unit already removed from the board -- a known ordering
    // divergence, harmless for content that doesn't inspect the dying unit from its own
    // 'die' handler via $x1/$y1, but a real gap for content that does.
    if (fireEvent) {
      ctx.raise('last breath', deathLoc, killerLoc);
      ctx.raise('die', deathLoc, killerLoc);
    }
    if (deathLoc.valid()) ctx.board.removeUnitAt(deathLoc);
    killedCount++;
  }

  const xStr = cfg.getString('x', '');
  const yStr = cfg.getString('y', '');
  if ((xStr === 'recall' || xStr === '') && (yStr === 'recall' || yStr === '')) {
    for (const team of ctx.board.teams()) {
      const list = ctx.board.recallList(team.side).filter((u) => unitMatchesFilter(u, cfg));
      for (const u of list) {
        ctx.board.removeFromRecallList(team.side, u.underlyingId);
        killedCount++;
      }
    }
  }
  void killedCount;
}

// --- [modify_unit] ---

const MODIFY_UNIT_FIELDS: Record<string, (u: Unit, cfg: WmlConfig, key: string) => void> = {
  hitpoints: (u, cfg) => (u.hitpoints = cfg.getNumber('hitpoints', u.hitpoints)),
  max_hitpoints: (u, cfg) => (u.maxHitpoints = cfg.getNumber('max_hitpoints', u.maxHitpoints)),
  moves: (u, cfg) => (u.movesLeft = cfg.getNumber('moves', u.movesLeft)),
  max_moves: (u, cfg) => (u.maxMoves = cfg.getNumber('max_moves', u.maxMoves)),
  experience: (u, cfg) => (u.experience = cfg.getNumber('experience', u.experience)),
  max_experience: (u, cfg) => (u.maxExperience = cfg.getNumber('max_experience', u.maxExperience)),
  side: (u, cfg) => (u.side = cfg.getNumber('side', u.side)),
  canrecruit: (u, cfg) => (u.canRecruit = cfg.getBoolean('canrecruit', u.canRecruit)),
  name: (u, cfg) => (u.name = cfg.getString('name', u.name)),
  role: (u, cfg) => (u.role = cfg.getString('role', u.role)),
};

function actionModifyUnit(cfg: WmlConfig, ctx: EventContext): void {
  const filterCfg = cfg.child('filter');
  if (!filterCfg) {
    ctx.log('error', '[modify_unit] missing required [filter] tag');
    return;
  }
  const units = findUnits(ctx.board, ctx.variables.expandConfig(filterCfg));

  for (const unit of units) {
    for (const key of Object.keys(MODIFY_UNIT_FIELDS)) {
      if (cfg.hasAttribute(key)) MODIFY_UNIT_FIELDS[key]!(unit, cfg, key);
    }
    if (cfg.hasAttribute('facing')) {
      unit.facing = parseDirection(cfg.getString('facing'));
    }

    const unitVars = new VariableStore(unit.variables ? varNodeFromConfig(unit.variables) : newVarNode());
    const subCtx: EventContext = { ...ctx, variables: unitVars };
    for (const { tag, config } of cfg.allChildren()) {
      if (tag === 'filter') continue;
      const expanded = ctx.variables.expandConfig(config);
      if (tag === 'set_variable') applySetVariable(expanded, unitVars, ctx.log);
      else if (tag === 'set_variables') actionSetVariables(expanded, subCtx);
      else if (tag === 'clear_variable') actionClearVariable(expanded, subCtx);
      // [object]/[trait]/[advancement]/[effect] are NOT ported -- see module doc comment.
    }
    unit.variables = unitVars.toConfig();
  }
}

// --- [unit] ---

function actionUnit(cfg: WmlConfig, ctx: EventContext): void {
  const side = cfg.getNumber('side', 1);
  const team = ctx.board.getTeam(side);
  if (!team) {
    ctx.log('error', `wrong side in [unit] tag - no such side: ${side}`);
    return;
  }
  let unit: Unit;
  try {
    unit = Unit.fromConfig(cfg, ctx.resolveType);
  } catch (e) {
    ctx.log('error', `Error occurred inside [unit]: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (!unit.location.valid()) {
    unit.location = ctx.board.map.startingPosition(side);
  }
  if (unit.location.valid()) {
    ctx.board.addUnit(unit);
    // Mirrors real `unit_creator`'s default `allow_get_village=true` --
    // an event-spawned unit placed directly onto a village captures it,
    // same as a `[side]`/scenario-level `[unit]` present at scenario
    // start (see `GameBoard.fromConfig`'s own capture calls).
    ctx.board.captureVillage(unit.location, side);
  } else {
    ctx.log('error', '[unit] has no valid location and no starting position to fall back to');
  }
}

// --- side/team helpers shared by [gold]/[store_gold]/[allow_recruit] ---

function findSides(ctx: EventContext, cfg: WmlConfig): number[] {
  if (cfg.hasAttribute('side')) {
    return cfg
      .getString('side')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n));
  }
  return ctx.board.teams().map((t) => t.side);
}

function actionGold(cfg: WmlConfig, ctx: EventContext): void {
  if (!cfg.hasAttribute('amount')) {
    ctx.log('error', '[gold] missing required amount= attribute.');
    return;
  }
  const amount = Math.floor(cfg.getNumber('amount'));
  for (const side of findSides(ctx, cfg)) {
    const team = ctx.board.getTeam(side);
    if (team) team.gold += amount;
  }
}

function actionStoreGold(cfg: WmlConfig, ctx: EventContext): void {
  const side = findSides(ctx, cfg)[0];
  const team = side !== undefined ? ctx.board.getTeam(side) : undefined;
  if (team) ctx.variables.set(cfg.getString('variable', 'gold'), team.gold);
}

function actionAllowRecruit(cfg: WmlConfig, ctx: EventContext): void {
  if (!cfg.hasAttribute('type')) {
    ctx.log('error', '[allow_recruit] missing required type= attribute');
    return;
  }
  const types = cfg
    .getString('type')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const side of findSides(ctx, cfg)) {
    const team = ctx.board.getTeam(side);
    if (!team) continue;
    for (const t of types) team.canRecruit.add(t);
  }
}

/**
 * Mirrors `wml_actions.capture_village` (`data/lua/wml-tags.lua`): assigns
 * every village matching the location filter (`cfg` itself, same
 * top-level x=/y= convention as `[filter_location]`) to `side=`. `side=0`
 * (or omitted, which resolves to 0 below) neutralises rather than
 * assigning to a nonexistent side, matching `GameBoard.captureVillage`'s
 * own `side <= 0` handling.
 *
 * Deliberately NOT ported: `[filter_side]` (pick the side by SSF instead
 * of a literal `side=` number) and `fire_event=` (upstream's own comment
 * on this notes fire_event "doesn't currently exist but probably should
 * someday" for `set_owner` itself -- the real `capture`/`village capture`
 * WML event isn't fired by this action either way yet, see
 * `move.ts`/`GameBoard.captureVillage`'s own doc comments on that gap).
 */
function actionCaptureVillage(cfg: WmlConfig, ctx: EventContext): void {
  if (!cfg.hasAttribute('side')) {
    ctx.log('warn', '[capture_village] without side= (or [filter_side], not yet supported) is a no-op');
    return;
  }
  const side = cfg.getNumber('side', 0);
  for (const loc of ctx.board.map.villages) {
    if (locationMatchesFilter(loc, cfg)) {
      ctx.board.captureVillage(loc, side);
    }
  }
}

/**
 * Mirrors `WML_HANDLER_FUNCTION(recall, ...)` (`src/game_events/
 * action_wml.cpp`): finds the first recall-list unit (searched across
 * every side's list, in side order -- matching upstream's `for (team& t :
 * resources::gameboard->teams())` outer loop) matching `cfg` as a SUF
 * (including the already-ported `x,y=recall,recall` convention -- see
 * `filter.ts`'s `unitMatchesFilter`), then places it via the same
 * leader/vacancy search `checkRecruitLocation` already does for the
 * player-facing recall UI, falling back to any vacant castle tile
 * connected to any able leader's keep when `cfg` doesn't specify (or its
 * requested) x=/y=.
 *
 * Deliberately NOT ported (matching `recruit.ts`'s own documented
 * simplifications for the same reasons): `[secondary_unit]` (restricting
 * *which* leader may recall the match), per-leader `recall_filter=`,
 * `location_id=`, `check_passability=` (`canUse` is always permissive,
 * `checkRecruitLocation` always passability-checks via
 * `findVacantCastleTile`), and `show=`/`fire_event=` (headless; no
 * display, and the `recall` WML event isn't fired by this port's event
 * pump for any recall path yet, player-driven or scripted).
 */
function actionRecall(cfg: WmlConfig, ctx: EventContext): void {
  const board = ctx.board;
  // `x=`/`y=` on [recall] are the DESTINATION, not a unit-filter criterion
  // -- mirrors upstream's own `temp_config["x"] = "recall"` trick (its
  // comment: "Prevent the recall unit filter from using the location as a
  // criterion"). Recall-list units have no board location, so leaving
  // x=/y= in the filter would make `unitMatchesFilter`'s ordinary
  // (non-"recall") x=/y= range check spuriously reject every candidate.
  const unitFilterCfg = new WmlConfig();
  for (const name of cfg.attributeNames()) {
    if (name === 'x' || name === 'y') continue;
    unitFilterCfg.setAttribute(name, cfg.getString(name));
  }
  for (const { tag, config } of cfg.allChildren()) unitFilterCfg.addChild(tag, config);

  for (const team of board.teams()) {
    const list = board.recallList(team.side);
    const index = list.findIndex((u) => unitMatchesFilter(u, unitFilterCfg, board));
    if (index === -1) continue;
    const unit = list[index]!;

    const preferredLoc = Location.fromConfig(cfg);
    const { result, location, leader } = checkRecruitLocation(board, team.side, preferredLoc, preferredLoc, () => true);
    if (result === 'no_leader' || result === 'no_able_leader' || result === 'no_keep_leader' || result === 'no_vacancy') {
      ctx.log('warn', `[recall] found ${unit.id || unit.type.id} on side ${team.side}'s recall list but no legal leader/location (${result})`);
      return;
    }

    // Splices `list` (the board's own live recall-list array) directly by
    // the index just found, NOT `GameBoard.removeFromRecallList`'s
    // `underlyingId`-keyed lookup -- this project doesn't auto-assign
    // unique `underlying_id`s (see `Unit.ts`), so several recall-list
    // entries commonly share `underlyingId=0`, and removing "whichever
    // entry has underlyingId=0" would silently splice out the WRONG unit
    // whenever one comes before the one this filter actually matched.
    // Mirrors `GameSession.tryRecallAt`'s own doc comment on the same
    // trap, in the player-facing recall UI.
    list.splice(index, 1);
    const facing = cfg.hasAttribute('facing') ? parseDirection(cfg.getString('facing')) : undefined;
    recallUnit(board, team, unit, location, leader?.location ?? location, facing);
    return;
  }
  ctx.log('warn', '[recall]: no recall-list unit on any side matched the filter');
}

// --- [move_unit] ---

/**
 * Mirrors `data/lua/wml/move_unit.lua`'s `wesnoth.wml_actions.move_unit`:
 * relocates every unit matching `cfg` (as a unit filter -- `to_x`/`to_y`/
 * `fire_event`/etc. aren't among the keys `unitMatchesFilter` checks, so
 * `cfg` is used as-is, matching upstream's own approach of stripping only
 * the path/control keys before treating the rest as a filter) directly to
 * its target hex -- NOT a real player move: no movement-point cost, no
 * zone-of-control stop, no pathfinding at all, since this is upstream's
 * scripted/cutscene relocation (its own macro doc: "moves a unit from its
 * current location to the given location, displaying movement normally").
 * If the target hex is occupied, lands on the nearest vacant hex instead
 * (`findVacantTile`, mirroring `wesnoth.paths.find_vacant_hex`).
 *
 * Deliberately NOT ported: `to_location=`/`dir=` path specs (multi-hex
 * scripted routes) -- only the far more common absolute `to_x=`/`to_y=`
 * form (optionally comma-lists, matched positionally against multiple
 * filtered units, same as upstream) is implemented; `check_passability=no`
 * (always passability-checks, matching upstream's default); `clear_shroud=`
 * (no fog/shroud model yet, see `pathfind.ts`'s module doc comment).
 * `fire_event=` IS supported (raises a real `moveto` event via `ctx.raise`,
 * queued for the next pump pass like every other `raise` call in this
 * file -- see that field's own doc comment on the batching this implies).
 */
function actionMoveUnit(cfg: WmlConfig, ctx: EventContext): void {
  if (cfg.hasAttribute('to_location') || cfg.hasAttribute('dir')) {
    ctx.log('warn', '[move_unit]: to_location=/dir= path specs are not supported (only to_x=/to_y=) -- ignored');
  }
  const toXStr = cfg.getString('to_x', '');
  const toYStr = cfg.getString('to_y', '');
  if (!toXStr || !toYStr) {
    ctx.log('warn', '[move_unit]: missing to_x=/to_y= (the only supported destination form) -- no-op');
    return;
  }
  const toXs = toXStr.split(',').map((s) => s.trim());
  const toYs = toYStr.split(',').map((s) => s.trim());
  const fireEvent = cfg.getBoolean('fire_event', false);
  const checkPassability = cfg.getBoolean('check_passability', true);

  const units = findUnits(ctx.board, cfg);
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!;
    // Positional pairing with the comma-list, clamped to the last entry --
    // mirrors upstream's own coroutine-based `path_locs` running out of
    // `to_x`/`to_y` entries and repeatedly yielding `nil` (which its
    // `tonumber(x) or current_unit:to_map(false)` then reads back as
    // "stay put on this axis").
    const xStr = toXs[Math.min(i, toXs.length - 1)]!;
    const yStr = toYs[Math.min(i, toYs.length - 1)]!;
    const wmlX = Number(xStr);
    const wmlY = Number(yStr);
    if (!Number.isFinite(wmlX) || !Number.isFinite(wmlY)) {
      ctx.log('error', `[move_unit]: invalid to_x=/to_y= ("${xStr}", "${yStr}")`);
      continue;
    }

    const fromLoc = unit.location;
    const requested = Location.fromWml(wmlX, wmlY);
    const alreadyThere = requested.equals(fromLoc);
    const target = alreadyThere
      ? requested
      : findVacantTile(ctx.board, requested, { passCheck: checkPassability ? unit : undefined });
    if (!target) {
      ctx.log('error', `[move_unit]: could not find a vacant hex near (${wmlX}, ${wmlY})`);
      continue;
    }

    // Real Lua's own facing rule: purely left/right, from the ORIGINAL hex
    // to the FINAL one -- not `directionTo`'s full 6-direction geometry.
    if (fromLoc.x < target.x) unit.facing = Direction.SouthEast;
    else if (fromLoc.x > target.x) unit.facing = Direction.SouthWest;

    ctx.board.moveUnit(fromLoc, target);
    if (fireEvent) ctx.raise('moveto', target, fromLoc);
  }
}

// --- [objectives] ---

/**
 * Real, reported bug (bugs3.md): `[objectives]` was a plain no-op, so no
 * caller had any structured data to show a real objectives dialog with.
 * Mirrors `wml_actions.objectives` (`data/lua/wml/objectives.lua`): parses
 * the block once (`parseScenarioObjectives`) and applies it to every side
 * named in `side=` (a comma-separated list, matching real WML's own
 * convention -- see `findUnits`' side-filter handling elsewhere in this
 * file for the same pattern), or every side currently on the board if
 * `side=` is absent (real `#sides_cfg == 0` branch).
 */
function actionObjectives(cfg: WmlConfig, ctx: EventContext): void {
  const parsed = parseScenarioObjectives(cfg);
  const sideAttr = cfg.getString('side', '');
  const sides = sideAttr
    ? sideAttr
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n))
    : ctx.board.teams().map((t) => t.side);
  for (const side of sides) {
    ctx.objectivesBySide.set(side, parsed);
  }
}

// --- registry ---

/**
 * Mirrors `wml_actions.endlevel` (`data/lua/wml/endlevel.lua`): the
 * scenario ends in victory if a human side wins, else in defeat if a human
 * side loses or `result=defeat`. Repeated firings are ignored.
 */
function actionEndlevel(cfg: WmlConfig, ctx: EventContext): void {
  if (ctx.endLevel) {
    ctx.log('warn', 'Repeated [endlevel] execution, ignoring');
    return;
  }
  const sideResults = new Map<number, WmlConfig>();
  for (const r of cfg.children('result')) sideResults.set(r.getNumber('side', 0), r);

  const carryover: EndLevelState['carryover'] = new Map();
  let humanVictory = false;
  let humanDefeat = false;
  const cfgResult = cfg.getString('result', 'victory');
  for (const team of ctx.board.teams()) {
    const sideResult = sideResults.get(team.side);
    const outcome = sideResult?.getString('result', '') || cfgResult;
    if (outcome !== 'victory' && outcome !== 'defeat') {
      ctx.log('error', `invalid result= key in [endlevel] '${outcome}'`);
      return;
    }
    if (team.controller === 'human') {
      if (outcome === 'victory') humanVictory = true;
      else humanDefeat = true;
    }
    const pick = (key: string): WmlConfig | undefined =>
      sideResult?.hasAttribute(key) ? sideResult : cfg.hasAttribute(key) ? cfg : undefined;
    const entry: { bonus?: boolean; carryoverAdd?: boolean; carryoverPercentage?: number } = {};
    const bonusCfg = pick('bonus');
    if (bonusCfg) entry.bonus = bonusCfg.getBoolean('bonus');
    const addCfg = pick('carryover_add');
    if (addCfg) entry.carryoverAdd = addCfg.getBoolean('carryover_add');
    const pctCfg = pick('carryover_percentage');
    if (pctCfg) entry.carryoverPercentage = pctCfg.getNumber('carryover_percentage');
    if (Object.keys(entry).length > 0) carryover.set(team.side, entry);
  }

  const proceed = humanVictory || (!humanDefeat && cfgResult !== 'defeat');
  ctx.endLevel = {
    result: proceed ? 'victory' : 'defeat',
    carryover,
    ...(cfg.hasAttribute('next_scenario') ? { nextScenario: cfg.getString('next_scenario') } : {}),
    ...(cfg.hasAttribute('end_text') ? { endText: cfg.getString('end_text') } : {}),
  };
}

/**
 * Builds a fresh registry with every action tag this module implements
 * (plus the presentation no-ops and extension-point placeholders)
 * pre-registered. Callers needing combat/recruit/Lua support should
 * `.register()` real handlers over the placeholders afterward.
 */
export function createDefaultActionRegistry(): ActionRegistry {
  const registry = new ActionRegistry();

  registry.register('message', actionMessage);
  registry.register('if', actionIf);
  registry.register('set_variable', actionSetVariable);
  registry.register('set_variables', actionSetVariables);
  registry.register('clear_variable', actionClearVariable);
  registry.register('store_unit', actionStoreUnit);
  registry.register('unstore_unit', actionUnstoreUnit);
  registry.register('kill', actionKill);
  registry.register('modify_unit', actionModifyUnit);
  registry.register('unit', actionUnit);
  registry.register('gold', actionGold);
  registry.register('store_gold', actionStoreGold);
  registry.register('allow_recruit', actionAllowRecruit);
  registry.register('capture_village', actionCaptureVillage);
  registry.register('recall', actionRecall);
  registry.register('move_unit', actionMoveUnit);
  registry.register('objectives', actionObjectives);
  registry.register('endlevel', actionEndlevel);
  registry.register('remove_shroud', actionRemoveShroud);
  registry.register('place_shroud', actionPlaceShroud);
  registry.register('lift_fog', actionLiftFog);
  registry.register('reset_fog', actionResetFog);
  registry.register('time_area', actionTimeArea);
  registry.register('remove_time_area', actionRemoveTimeArea);
  registry.register('replace_schedule', actionReplaceSchedule);
  registry.register('store_time_of_day', actionStoreTimeOfDay);

  for (const tag of [
    'music',
    'sound',
    'scroll_to',
    'scroll_to_unit',
    'delay',
    'redraw',
    'highlight',
    'floating_text',
    'label',
    'select_unit',
    'unit_overlay',
    'remove_unit_overlay',
    // Purely a cosmetic animation of a move `[move_unit]` (above) already
    // performed for real -- upstream's own `move_unit.lua` calls this
    // itself right before setting the unit's real x/y. Headless, so
    // there's nothing to implement, unlike `move_unit` itself.
    'move_unit_fake',
  ]) {
    registry.register(tag, noop);
  }

  registry.register('attack', extensionPoint('attack', 'packages/engine/src/actions/'));
  registry.register('recruit', extensionPoint('recruit', 'packages/engine/src/actions/'));
  registry.register('lua', extensionPoint('lua', 'packages/lua-bridge/ (Phase 3)'));

  return registry;
}

// Re-exported for pump.ts / tests without pulling in the whole model surface directly.
export { Location };
