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
 * objectives.lua` logic it ports and what's deliberately scoped out),
 * `heal_unit` (see its own doc comment for the real `data/lua/wml/
 * heal_unit.lua` subset), `set_menu_item`/`clear_menu_item` (Phase 14:
 * lets a scenario's `[event]`s declare real right-click context-menu
 * entries -- see their own doc comments and `GameSession.menuItems`/
 * `runMenuItem`, packages/ui, for how the UI surfaces and executes them).
 *
 * Presentation-only tags with nothing to show for them headlessly are
 * registered as explicit no-ops (not silently dropped) so real content
 * doesn't spam "unsupported tag" warnings: `music`, `sound`, `redraw`,
 * `highlight`, `floating_text`, `label`, `select_unit`, `unit_overlay`,
 * `remove_unit_overlay`. The cutscene and camera tags that used to be in
 * that list -- `[delay]`, `[scroll_to]`, `[move_unit_fake]`, ... -- are
 * real as of Phase 17 and live in `cutsceneWml.ts`, registered from here.
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
 * The rest of `data/lua/wml-flow.lua` -- `[while]`/`[for]`/`[foreach]`/
 * `[repeat]`/`[switch]`/`[command]` and the `[break]`/`[continue]`/
 * `[return]` signals -- lives in `flowWml.ts` (Phase 17), registered from
 * here; only `[if]` stayed in this file, next to the other tags.
 */

import type { EndLevelState } from './context.js';
import { Direction, Location, parseDirection } from '../model/Location.js';
import { Unit } from '../model/Unit.js';
import { WmlConfig } from '../wml/config.js';
import { checkRecruitLocation, recallUnit } from '../actions/recruit.js';
import { findPath, findVacantTile } from '../pathfind/pathfind.js';
import type { Rng } from '../rng/Rng.js';
import type { ActionHandler, EventContext, RecordedMessage } from './context.js';
import { ActionRegistry } from './context.js';
import { isFlow, runFlow, type Flow, type MessageOption, type Responder, type TextInputSpec } from './interaction.js';
import { conditionalPassed } from './conditionalWml.js';
import { findUnits, locationMatchesFilter, unitMatchesFilter } from './filter.js';
import { actionLiftFog, actionPlaceShroud, actionRemoveShroud, actionResetFog } from './shroudWml.js';
import { actionTimeArea, actionRemoveTimeArea, actionReplaceSchedule, actionStoreTimeOfDay } from './todWml.js';
import { newVarNode, varNodeFromConfig, varNodeToConfig, VariableStore, type VarNode } from './variables.js';
import { parseScenarioObjectives } from './objectives.js';
import { registerFlowActions } from './flowWml.js';
import { playBeat, registerCutsceneActions } from './cutsceneWml.js';

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
export function* runActionFlow(body: WmlConfig, ctx: EventContext): Flow {
  for (const { tag, config } of body.allChildren()) {
    if (tag.startsWith('filter')) continue;
    const handler = ctx.registry.get(tag);
    if (!handler) {
      ctx.log('warn', `[${tag}] not supported (skipped)`);
      continue;
    }
    try {
      const result = handler(ctx.variables.expandConfig(config), ctx);
      // A handler that needs to block returns a generator (see
      // interaction.ts); delegating rather than driving it here is what
      // lets the suspension travel out to whoever is pumping.
      if (isFlow(result)) yield* result;
    } catch (e) {
      ctx.log('error', `Error occurred inside [${tag}]: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (ctx.exit.type !== 'none') break;
  }
}

/**
 * `runActionFlow` for a caller with nothing to show: runs the body to
 * completion, answering any interaction inline with `autoRespond`. This
 * is the shape every pre-Phase-17 caller already used, kept so that
 * headless callers (`GameSession.runMenuItem`, tests) need no changes.
 */
export function runActionSequence(body: WmlConfig, ctx: EventContext, respond?: Responder): void {
  runFlow(runActionFlow(body, ctx), respond);
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

/**
 * Port of `data/lua/wml/message.lua`'s `wml_actions.message`: shows one
 * line of dialogue and, as of Phase 17, **blocks its event** until the
 * player dismisses it or answers its `[option]`/`[text_input]`.
 *
 * Ported: `[show_if]`; `get_speaker` (a message whose speaker cannot be
 * found is skipped, as upstream); `get_image`/`get_caption`'s portrait
 * and caption rules; `[option]` with `[show_if]`/`label=`/`message=`/
 * `description=`/`image=`/`default=`/`value=`/`[command]`; `[text_input]`
 * (first one only); `variable=`; `side_for=` gating for messages with no
 * input; Escape-skips-the-rest-of-this-event.
 *
 * NOT ported: `male_message=`/`female_message=` pick nothing, because
 * this port's `Unit` has no gender yet (Phase 1 deferred gender with
 * `[variation]`) -- the plain `message=` is used, and a message that
 * *only* has gendered text falls back to the male form, upstream's own
 * default gender. Unused by any campaign ported so far. The Pango
 * formatting attributes (`font=`, `color=`, `underline=`, ...) are not
 * applied either; `sound=`/`voice=` are carried on the recorded message
 * for Phase 19 rather than played.
 */
function* actionMessage(cfg: WmlConfig, ctx: EventContext): Flow {
  const showIf = cfg.child('show_if');
  if (showIf && !conditionalPassed(showIf, ctx)) return;

  // Only the first [text_input] is considered, as upstream.
  const textInputCfgs = cfg.children('text_input');
  if (textInputCfgs.length > 1) ctx.log('warn', 'Too many [text_input] tags, only first one accepted');
  const textInputCfg = textInputCfgs[0];
  let textInput: TextInputSpec | undefined;
  if (textInputCfg) {
    let maxLength = textInputCfg.getNumber('max_length', 256);
    if (maxLength > 1024 || maxLength < 1) {
      ctx.log('warn', `Invalid maximum size for input ${maxLength}`);
      maxLength = 256;
    }
    textInput = {
      label: textInputCfg.getString('label', ''),
      text: textInputCfg.getString('text', ''),
      maxLength,
    };
  }

  // [option]s that fail their own [show_if] are dropped entirely, so the
  // 1-based index a `variable=` receives counts only the shown ones.
  const options: MessageOption[] = [];
  const optionValues: Array<string | undefined> = [];
  const optionCommands: WmlConfig[][] = [];
  for (const optionCfg of cfg.children('option')) {
    const optionShowIf = optionCfg.child('show_if');
    if (optionShowIf && !conditionalPassed(optionShowIf, ctx)) continue;

    // message= and description= are synonyms (backwards compatibility upstream).
    const hasMessage = optionCfg.hasAttribute('message');
    const hasDescription = optionCfg.hasAttribute('description');
    let description = '';
    if (hasMessage && hasDescription) {
      ctx.log('warn', '[option] uses both message= and description= which is invalid.');
      description = 'Invalid use of both message and description attributes on this option!';
    } else if (hasMessage) {
      description = optionCfg.getString('message');
    } else if (hasDescription) {
      description = optionCfg.getString('description');
    }

    options.push({
      label: optionCfg.getString('label', ''),
      description,
      image: optionCfg.getString('image', ''),
      isDefault: optionCfg.getBoolean('default', false),
    });
    optionValues.push(optionCfg.hasAttribute('value') ? optionCfg.getString('value') : undefined);
    optionCommands.push(optionCfg.children('command'));
  }

  const hasInput = textInput !== undefined || options.length > 0;

  // Nothing to ask and the player has already pressed Escape this event.
  if (!hasInput && ctx.skipMessages) {
    ctx.log('debug', 'Skipping [message] because user not interested');
    return;
  }

  // side_for= only gates messages with no input; one that asks something
  // is always put to whoever is playing (upstream routes it through the
  // synced-choice machinery instead).
  if (!hasInput && cfg.hasAttribute('side_for')) {
    const wanted = cfg
      .getString('side_for')
      .split(/[\s,]+/)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0);
    const shown = wanted.some((side) => ctx.board.teams().find((t) => t.side === side)?.controller === 'human');
    if (!shown) {
      ctx.log('debug', "Player isn't controlling side that should see [message]");
      return;
    }
  }

  const speakerAttr = cfg.getString('speaker', '');
  const narrator = speakerAttr === 'narrator';
  let speakerUnit: ReturnType<typeof findUnits>[number] | undefined;
  if (narrator) {
    speakerUnit = undefined;
  } else if (speakerAttr === 'unit') {
    speakerUnit = ctx.board.unitAt(ctx.loc1);
  } else if (speakerAttr === 'second_unit') {
    speakerUnit = ctx.board.unitAt(ctx.loc2);
  } else if (speakerAttr !== '') {
    speakerUnit = ctx.board.allUnits().find((u) => u.id === speakerAttr);
  } else {
    // No speaker=: the message's own attributes act as a unit filter, first match speaks.
    speakerUnit = findUnits(ctx.board, cfg)[0];
  }
  if (!narrator && !speakerUnit) {
    ctx.log('debug', 'No speaker found for [message]');
    return;
  }

  // get_image
  const secondImage = cfg.getString('second_image', '');
  let image = cfg.hasAttribute('image') ? cfg.getString('image') : '';
  if (speakerUnit && image === '' && secondImage === '') image = speakerUnit.portrait();
  let portrait = '';
  let leftSide = true;
  if (image !== '' && image !== 'none') {
    portrait = image;
    if (portrait.includes('~RIGHT()')) {
      leftSide = false;
      portrait = portrait.split('~RIGHT()').join('');
    }
    const imagePos = cfg.getString('image_pos', '');
    if (imagePos === 'left') leftSide = true;
    else if (imagePos === 'right') leftSide = false;
    else if (imagePos !== '') ctx.log('error', 'Invalid [message]image_pos - should be left or right');
  }

  // get_caption
  let title = cfg.hasAttribute('caption') ? cfg.getString('caption') : '';
  if (!cfg.hasAttribute('caption') && speakerUnit) title = speakerUnit.name !== '' ? speakerUnit.name : speakerUnit.type.name;

  // No gender in this port's model yet, so a message that only has
  // gendered text falls back to the male form (upstream's default).
  const body = cfg.hasAttribute('message')
    ? cfg.getString('message')
    : cfg.hasAttribute('male_message')
      ? cfg.getString('male_message')
      : cfg.getString('female_message', '');

  const message: RecordedMessage = {
    speaker: narrator ? 'narrator' : (speakerUnit?.id ?? ''),
    message: body,
    image: cfg.hasAttribute('image') ? cfg.getString('image') : undefined,
    caption: cfg.hasAttribute('caption') ? cfg.getString('caption') : undefined,
    portrait,
    leftSide,
    mirror: cfg.getBoolean('mirror', false),
    secondPortrait: secondImage === 'none' ? '' : secondImage,
    secondMirror: cfg.getBoolean('second_mirror', false),
    title,
    speakerLocation: speakerUnit ? { x: speakerUnit.location.x, y: speakerUnit.location.y } : undefined,
    scroll: cfg.getBoolean('scroll', true),
    highlight: cfg.getBoolean('highlight', true),
    sound: cfg.getString('sound', ''),
    voice: cfg.getString('voice', ''),
  };
  ctx.messages.push(message);

  const answer = yield { kind: 'message', message, options, textInput };

  // Escape on a message with nothing to answer: drop the rest of this
  // event's plain messages (`wesnoth.interface.skip_messages()`).
  if (answer.skip && !hasInput) ctx.skipMessages = true;

  if (!hasInput) return;

  ctx.choices.push({
    value: options.length > 0 ? (answer.value ?? 1) : undefined,
    text: textInput ? (answer.text ?? textInput.text) : undefined,
    side: ctx.variables.getNumber('side_number', 0),
  });

  if (textInputCfg && textInput) {
    ctx.variables.set(textInputCfg.getString('variable', 'input'), answer.text ?? textInput.text);
  }

  if (options.length === 0) return;

  const chosen = answer.value ?? 1;
  if (chosen < 1 || chosen > options.length) {
    ctx.log('debug', `invalid choice (${chosen}) was specified, choice 1 to ${options.length} was expected`);
    return;
  }
  const index = chosen - 1;

  const variableName = cfg.getString('variable', '');
  if (variableName !== '') {
    const value = optionValues[index];
    ctx.variables.set(variableName, value ?? chosen);
  }

  for (const command of optionCommands[index]!) {
    yield* runActionFlow(command, ctx);
    if (ctx.exit.type !== 'none') break;
  }
}

// --- [if] ---

function* actionIf(cfg: WmlConfig, ctx: EventContext): Flow {
  const hasBranches = cfg.hasChild('then') || cfg.hasChild('elseif') || cfg.hasChild('else');
  if (!hasBranches) {
    ctx.log('error', "[if] didn't find any [then], [elseif], or [else] children.");
    return;
  }

  if (conditionalPassed(cfg, ctx)) {
    for (const thenCfg of cfg.children('then')) {
      yield* runActionFlow(thenCfg, ctx);
      if (ctx.exit.type !== 'none') break;
    }
    return;
  }

  for (const elseifCfg of cfg.children('elseif')) {
    if (conditionalPassed(elseifCfg, ctx)) {
      for (const thenCfg of elseifCfg.children('then')) {
        yield* runActionFlow(thenCfg, ctx);
        if (ctx.exit.type !== 'none') break;
      }
      return;
    }
  }

  for (const elseCfg of cfg.children('else')) {
    yield* runActionFlow(elseCfg, ctx);
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

  // `rand=` is handled by `actionSetVariable` above, which has the
  // context (and so the RNG) this shared helper deliberately does not.
  // NOT ported: `rand=` here (needs the shared RNG, owned by packages/engine/src/rng/, out of
  // scope here), `formula=` (would need a `value`-bound WFL context; skipped for now),
  // `time=stamp` (no wall-clock concept in a deterministic headless engine).
}

/**
 * `rand=`'s own little grammar (`mathx.random_choice`): a comma-separated
 * list whose entries are either literal values or `A..B` numeric ranges,
 * picked from uniformly over every possibility -- so `rand="1..4"` is one
 * of four numbers and `rand="a,1..3"` is one of four choices, not two.
 */
function randomChoice(spec: string, rng: Rng): string {
  const entries: Array<{ from: number; to: number } | string> = [];
  let total = 0;
  for (const raw of spec.split(',')) {
    const token = raw.trim();
    const range = /^(-?\d+)\.\.(-?\d+)$/.exec(token);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      entries.push({ from: lo, to: hi });
      total += hi - lo + 1;
    } else {
      entries.push(token);
      total += 1;
    }
  }
  if (total === 0) return '';

  let pick = rng.getRandomInt(0, total - 1);
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (pick === 0) return entry;
      pick -= 1;
    } else {
      const size = entry.to - entry.from + 1;
      if (pick < size) return String(entry.from + pick);
      pick -= size;
    }
  }
  return '';
}

function actionSetVariable(cfg: WmlConfig, ctx: EventContext): void {
  // `rand=` needs the session RNG, which `applySetVariable` (shared with
  // `[modify_unit]`'s per-unit variable bag) has no access to.
  if (cfg.hasAttribute('rand')) {
    const name = cfg.getString('name', '');
    if (name === '') {
      ctx.log('error', '[set_variable] with rand= but no name=');
      return;
    }
    if (!ctx.rng) {
      ctx.log('warn', '[set_variable] rand= needs a game RNG -- ignored');
      return;
    }
    const chosen = randomChoice(cfg.getString('rand'), ctx.rng);
    const asNumber = Number(chosen);
    ctx.variables.set(name, chosen !== '' && !Number.isNaN(asNumber) ? asNumber : chosen);
    return;
  }
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

function* actionKill(cfg: WmlConfig, ctx: EventContext): Flow {
  if (cfg.hasChild('filter')) {
    ctx.log('error', 'Tag [filter] may not be used in [kill]');
    return;
  }
  const fireEvent = cfg.getBoolean('fire_event', false);
  const animate = cfg.getBoolean('animate', false);
  const secondaryCfg = cfg.child('secondary_unit');
  const secondary = secondaryCfg ? findUnits(ctx.board, ctx.variables.expandConfig(secondaryCfg))[0] : undefined;

  const doomed = findUnits(ctx.board, cfg);
  let killedCount = 0;
  for (const unit of doomed) {
    const deathLoc = unit.location;
    const killerLoc = secondary ? secondary.location : deathLoc;
    unit.hitpoints = 0;
    // Phase 17: upstream's own order (`data/lua/wml/kill.lua`) -- 'last
    // breath', then the death animation, then 'die', and only then the
    // unit is erased, each event drained completely before the next step.
    // Until the pump could suspend, this port could only `raise` both
    // (draining after the whole action sequence), so a 'die' handler saw
    // the unit already gone from the board.
    if (fireEvent) yield* ctx.fireNow('last breath', deathLoc, killerLoc);
    if (animate && deathLoc.valid() && ctx.board.unitAt(deathLoc) === unit) {
      yield* playBeat({ kind: 'unitDeath', unit, scroll: cfg.getBoolean('scroll', true) });
    }
    if (fireEvent) yield* ctx.fireNow('die', deathLoc, killerLoc);
    // "if it's still on the map" -- an event above may have erased or
    // moved it (`unit.valid == "map"` upstream).
    if (deathLoc.valid() && ctx.board.unitAt(deathLoc) === unit) ctx.board.removeUnitAt(deathLoc);
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

function* actionUnit(cfg: WmlConfig, ctx: EventContext): Flow {
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
    // `animate=yes`: the unit fades in where it lands, as
    // `unit_creator::post_create` does via `unit_display::unit_recruited`.
    if (cfg.getBoolean('animate', false)) yield* playBeat({ kind: 'unitAppear', unit });
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
function* actionMoveUnit(cfg: WmlConfig, ctx: EventContext): Flow {
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

    // Phase 17: `move_unit.lua:103` hands the *visible* move to
    // `[move_unit_fake]` before relocating the unit for real, so the
    // walk plays out before whatever the event does next (a line of
    // dialogue, usually). Headless this resolves instantly and the
    // teleport below is all that happens, exactly as before.
    if (!alreadyThere) {
      const route = findPath(ctx.board, unit, target, { seeAll: true, ignoreUnit: true }).steps;
      const path = route.length > 0 ? route : [fromLoc, target];
      yield* playBeat({ kind: 'moveUnit', unit, path });
    }

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
    ...(cfg.hasAttribute('end_text_duration') ? { endTextDuration: Math.min(Math.max(Math.trunc(cfg.getNumber('end_text_duration', 0)), 0), 5000) } : {}),
    ...(cfg.hasAttribute('end_credits') ? { endCredits: cfg.getBoolean('end_credits', true) } : {}),
  };
}

// --- [heal_unit] ---

/**
 * Real subset of `data/lua/wml/heal_unit.lua`: `[filter]` (defaults to the
 * unit at `$x1,$y1`, i.e. `ctx.loc1` -- matches upstream reading
 * `wesnoth.current.event_context.x1/y1`), `amount` (a number, or `"full"`/
 * omitted for a full heal -- upstream's own default), `moves` (`"full"` or
 * an amount added, default 0), `restore_attacks`, and `restore_statuses`
 * (default `true`, clearing poisoned/petrified/slowed -- `unhealable` is
 * not modelled as a status the way upstream's `status.unhealable` is, see
 * `Unit.ts`, so it's not cleared here). NOT ported: `[filter_second]`
 * (healer-of-record, used only for the `animate=` visual), `variable=`
 * (per-unit result recording).
 */
function actionHealUnit(cfg: WmlConfig, ctx: EventContext): void {
  const filterCfg = cfg.child('filter');
  const units = filterCfg
    ? findUnits(ctx.board, ctx.variables.expandConfig(filterCfg))
    : ctx.loc1.valid()
      ? [ctx.board.unitAt(ctx.loc1)].filter((u): u is Unit => u !== undefined)
      : [];

  const amountStr = cfg.getString('amount', 'full');
  const movesStr = cfg.getString('moves', '');
  const restoreAttacks = cfg.getBoolean('restore_attacks', false);
  const restoreStatuses = cfg.getBoolean('restore_statuses', true);

  for (const unit of units) {
    if (amountStr === 'full') {
      unit.hitpoints = unit.maxHitpoints;
    } else {
      const amount = Number(amountStr) || 0;
      unit.hitpoints = Math.floor(Math.max(1, Math.min(unit.maxHitpoints, unit.hitpoints + amount)));
    }

    if (movesStr === 'full') {
      unit.movesLeft = unit.maxMoves;
    } else if (movesStr !== '') {
      unit.movesLeft = Math.min(unit.maxMoves, unit.movesLeft + (Number(movesStr) || 0));
    }

    if (restoreAttacks) unit.attacksLeft = unit.maxAttacksPerTurn;

    if (restoreStatuses) {
      unit.setStatus('poisoned', false);
      unit.setStatus('petrified', false);
      unit.setStatus('slowed', false);
    }
  }
}

// --- [set_menu_item] / [clear_menu_item] ---

/**
 * Real subset of upstream's `[set_menu_item]` (`src/game_events/action_wml.
 * cpp`'s `menu_item` handling + `src/menu_events.cpp`'s right-click menu
 * build): `id` (required) and `description` (the menu label, defaulting to
 * `id`), plus a `[command]` child -- the WML action body `runActionSequence`
 * runs (via `GameSession.runMenuItem`, packages/ui) when the player picks
 * this entry from the context menu. Registering just STORES the definition
 * in `ctx.menuItems` (mirrors `actionObjectives`/`ctx.objectivesBySide`'s
 * own "populate a map the UI reads later" pattern) -- it does not run
 * anything itself. NOT ported: `[show_if]`/`[filter_location]` (real
 * per-hex enablement -- this port's menu items are offered unconditionally
 * on every hex, see `GameSession.menuItems`'s own doc comment),
 * `image=`/`needs_select=`/`hotkey=`.
 */
function actionSetMenuItem(cfg: WmlConfig, ctx: EventContext): void {
  const id = cfg.getString('id', '');
  if (id === '') {
    ctx.log('error', '[set_menu_item] missing required id=');
    return;
  }
  ctx.menuItems.set(id, {
    id,
    description: cfg.getString('description', id),
    command: cfg.child('command') ?? new WmlConfig(),
  });
}

/** `id=` removes that one entry; omitted clears every menu item (matches upstream's own `[clear_menu_item]` with no id=). */
function actionClearMenuItem(cfg: WmlConfig, ctx: EventContext): void {
  const id = cfg.getString('id', '');
  if (id === '') ctx.menuItems.clear();
  else ctx.menuItems.delete(id);
}

// --- [fire_event] ---

/**
 * Port of `wml-tags.lua`'s `fire_event`: fires an event *immediately*,
 * draining it (and anything it raises) before the rest of this action
 * sequence continues. `[primary_unit]`/`[secondary_unit]` are unit
 * filters supplying `$x1|$y1`/`$x2|$y2`; `[data]` is passed through as
 * the event's own data, with `[primary_attack]`/`[secondary_attack]`
 * folded into it as `[first]`/`[second]` (upstream's own shuffling, so
 * weapon-filtered handlers see what they expect).
 */
function* actionFireEvent(cfg: WmlConfig, ctx: EventContext): Flow {
  const name = cfg.getString('name', '');
  const id = cfg.getString('id', '');
  if (name === '' && id === '') {
    ctx.log('error', '[fire_event] missing required name= or id=');
    return;
  }

  const filterLoc = (tag: string): Location => {
    const filterCfg = cfg.child(tag);
    if (!filterCfg) return Location.NULL;
    const unit = findUnits(ctx.board, ctx.variables.expandConfig(filterCfg))[0];
    return unit ? unit.location : Location.NULL;
  };

  const data = cfg.child('data') ?? new WmlConfig();
  const primaryAttack = cfg.child('primary_attack');
  const secondaryAttack = cfg.child('secondary_attack');
  if (primaryAttack) data.addChild('first', primaryAttack);
  if (secondaryAttack) data.addChild('second', secondaryAttack);

  yield* ctx.fireNow(name, filterLoc('primary_unit'), filterLoc('secondary_unit'), data, id);
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
  registry.register('heal_unit', actionHealUnit);
  registry.register('set_menu_item', actionSetMenuItem);
  registry.register('clear_menu_item', actionClearMenuItem);
  registry.register('fire_event', actionFireEvent);
  registerFlowActions((tag, handler) => registry.register(tag, handler));

  for (const tag of ['music', 'sound', 'redraw', 'highlight', 'floating_text', 'label', 'select_unit', 'unit_overlay', 'remove_unit_overlay']) {
    registry.register(tag, noop);
  }
  registerCutsceneActions((tag, handler) => registry.register(tag, handler));

  registry.register('attack', extensionPoint('attack', 'packages/engine/src/actions/'));
  registry.register('recruit', extensionPoint('recruit', 'packages/engine/src/actions/'));
  registry.register('lua', extensionPoint('lua', 'packages/lua-bridge/ (Phase 3)'));

  return registry;
}

// Re-exported for pump.ts / tests without pulling in the whole model surface directly.
export { Location };
