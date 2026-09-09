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
 * `kill`, `modify_unit` (simplified, see below), `unit` (spawn), `gold`,
 * `store_gold`, `allow_recruit`.
 *
 * Presentation-only tags that have no headless effect are registered as
 * explicit no-ops (not silently dropped) so real content doesn't spam
 * "unsupported tag" warnings: `music`, `sound`, `scroll_to`,
 * `scroll_to_unit`, `delay`, `redraw`, `highlight`, `floating_text`,
 * `label`, `objectives`.
 *
 * ## Extension points (NOT implemented here, on purpose)
 * `[attack]`, `[recruit]`, `[recall]`, `[move_unit]`/`[move_unit_fake]`
 * (need `packages/engine/src/actions/`'s move/combat/recruit logic, being
 * built in parallel -- explicitly out of scope for this module per the
 * task brief) and `[lua]` (needs the Phase 3 Lua bridge). Each is
 * registered with a placeholder handler that logs a clear "extension
 * point" message and no-ops, rather than either crashing or silently
 * doing nothing -- `ActionRegistry.register(tag, handler)` is public
 * specifically so later work can override these without touching this
 * file. `capture_village` is similarly a placeholder: it needs
 * per-team village-ownership tracking that `model/Team.ts` doesn't carry
 * yet (see that file's module doc comment on scope).
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

import { Location, parseDirection } from '../model/Location.js';
import { Unit } from '../model/Unit.js';
import { WmlConfig } from '../wml/config.js';
import type { ActionHandler, EventContext } from './context.js';
import { ActionRegistry } from './context.js';
import { conditionalPassed } from './conditionalWml.js';
import { findUnits, unitMatchesFilter } from './filter.js';
import { newVarNode, varNodeFromConfig, VariableStore, type VarNode } from './variables.js';

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

// --- registry ---

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
  registry.register('kill', actionKill);
  registry.register('modify_unit', actionModifyUnit);
  registry.register('unit', actionUnit);
  registry.register('gold', actionGold);
  registry.register('store_gold', actionStoreGold);
  registry.register('allow_recruit', actionAllowRecruit);

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
    'objectives',
    'select_unit',
    'unit_overlay',
    'remove_unit_overlay',
  ]) {
    registry.register(tag, noop);
  }

  registry.register('attack', extensionPoint('attack', 'packages/engine/src/actions/'));
  registry.register('recruit', extensionPoint('recruit', 'packages/engine/src/actions/'));
  registry.register('recall', extensionPoint('recall', 'packages/engine/src/actions/'));
  registry.register('move_unit', extensionPoint('move_unit', 'packages/engine/src/actions/ + pathfind/'));
  registry.register('move_unit_fake', extensionPoint('move_unit_fake', 'packages/engine/src/actions/ + pathfind/'));
  registry.register('lua', extensionPoint('lua', 'packages/lua-bridge/ (Phase 3)'));
  registry.register('capture_village', extensionPoint('capture_village', 'model/Team.ts village ownership (not modeled yet)'));

  return registry;
}

// Re-exported for pump.ts / tests without pulling in the whole model surface directly.
export { Location };
